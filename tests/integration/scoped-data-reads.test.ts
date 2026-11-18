/**
 * The reads behind a scoped data page.
 *
 * Two properties are pinned here, and the second is the one worth the setup:
 *
 * **The filter narrows, never widens.** `integrationId` arrives from the URL,
 * so a mistyped, deleted or foreign id must produce an empty page — never a
 * hint that the id names another tenant's rows. Ownership always comes from
 * `userId`; the integration id only narrows further.
 *
 * **Pagination is exact.** Page 2 must not repeat page 1, `totals` must not
 * change between pages, and the merged agreement list must slice after its two
 * halves are merged. The id tiebreaks these reads now carry are what make that
 * true for rows that share a name or a date.
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { PAGE_SIZE } from "@/core/repositories/data-page";
import { loadAgreements } from "@/core/repositories/agreement-repository";
import { loadInvoices } from "@/core/repositories/billing-repository";
import { loadCatalog } from "@/core/repositories/catalog-repository";
import {
  countMessagesForUser,
  loadMessagesForUser,
} from "@/core/repositories/message-repository";
import {
  loadCustomerAccounts,
  loadSyncedData,
} from "@/core/repositories/synced-data-repository";
import { prisma } from "@/lib/prisma";

interface Seed {
  userId: string;
  integrationId: string;
  siblingIntegrationId: string;
  foreignIntegrationId: string;
  sharedAccountId: string;
}

const MAIN_LABEL = "Stripe — main";
const CUSTOMER_COUNT = PAGE_SIZE + 5;
const AGREEMENT_COUNT = PAGE_SIZE + 5;

function pad(index: number): string {
  return String(index).padStart(3, "0");
}

async function seedTenant(): Promise<Seed> {
  const user = await prisma.user.create({
    data: { email: `scoped-reads-${randomUUID()}@test.local` },
    select: { id: true },
  });
  const otherUser = await prisma.user.create({
    data: { email: `scoped-reads-other-${randomUUID()}@test.local` },
    select: { id: true },
  });

  async function integration(
    userId: string,
    label: string
  ): Promise<string> {
    const row = await prisma.integration.create({
      data: {
        userId,
        providerName: "stripe",
        status: "active",
        instanceLabel: label,
      },
      select: { id: true },
    });
    return row.id;
  }

  const integrationId = await integration(user.id, MAIN_LABEL);
  const siblingIntegrationId = await integration(user.id, "Stripe — sibling");
  const foreignIntegrationId = await integration(otherUser.id, "Someone else");

  // -- Customers and contacts ------------------------------------------------
  await prisma.customer.createMany({
    data: Array.from({ length: CUSTOMER_COUNT }, (_, index) => ({
      integrationId,
      externalSourceId: `main-customer-${pad(index)}`,
      name: `Main Customer ${pad(index)}`,
    })),
  });
  await prisma.customer.createMany({
    data: [
      {
        integrationId: siblingIntegrationId,
        externalSourceId: "sibling-customer-0",
        name: "Sibling Customer 0",
      },
      {
        integrationId: siblingIntegrationId,
        externalSourceId: "sibling-customer-1",
        name: "Sibling Customer 1",
      },
    ],
  });
  await prisma.customer.create({
    data: {
      integrationId: foreignIntegrationId,
      externalSourceId: "foreign-customer",
      name: "Foreign Customer",
    },
  });

  await prisma.contact.createMany({
    data: [
      {
        integrationId,
        externalSourceId: "main-contact-0",
        name: "Main Contact",
      },
      {
        // Counted as unlinked: it named a company that is not here.
        integrationId,
        externalSourceId: "main-contact-unlinked",
        name: "Unlinked Contact",
        externalCustomerId: "cus_missing",
      },
      {
        integrationId: siblingIntegrationId,
        externalSourceId: "sibling-contact",
        name: "Sibling Contact",
        externalCustomerId: "cus_missing",
      },
    ],
  });

  // -- Accounts --------------------------------------------------------------
  const sharedAccount = await prisma.customerAccount.create({
    data: { userId: user.id, name: "Main Account" },
    select: { id: true },
  });
  const siblingOnlyAccount = await prisma.customerAccount.create({
    data: { userId: user.id, name: "Sibling Account" },
    select: { id: true },
  });

  await prisma.customer.updateMany({
    where: { integrationId, externalSourceId: "main-customer-000" },
    data: { customerAccountId: sharedAccount.id },
  });
  await prisma.customer.updateMany({
    where: {
      integrationId: siblingIntegrationId,
      externalSourceId: "sibling-customer-0",
    },
    data: { customerAccountId: sharedAccount.id },
  });
  await prisma.customer.updateMany({
    where: {
      integrationId: siblingIntegrationId,
      externalSourceId: "sibling-customer-1",
    },
    data: { customerAccountId: siblingOnlyAccount.id },
  });

  // -- Catalog ---------------------------------------------------------------
  await prisma.product.createMany({
    data: [
      {
        id: "prod-main-a",
        integrationId,
        externalSourceId: "prod_main_a",
        name: "Main Product A",
      },
      {
        id: "prod-main-b",
        integrationId,
        externalSourceId: "prod_main_b",
        name: "Main Product B",
      },
      {
        id: "prod-sibling",
        integrationId: siblingIntegrationId,
        externalSourceId: "prod_sibling",
        name: "Sibling Product",
      },
    ],
  });
  await prisma.offering.createMany({
    data: [
      {
        id: "off-main-a",
        integrationId,
        externalSourceId: "off_main_a",
        name: "Main Offering A",
        productId: "prod-main-a",
      },
      {
        id: "off-main-b",
        integrationId,
        externalSourceId: "off_main_b",
        name: "Main Offering B",
        productId: "prod-main-b",
      },
      {
        // Unlinked on purpose: counted in `unlinkedOfferings`.
        id: "off-main-unlinked",
        integrationId,
        externalSourceId: "off_main_unlinked",
        name: "Unlinked Offering",
        externalProductId: "prod_missing",
      },
      {
        id: "off-sibling",
        integrationId: siblingIntegrationId,
        externalSourceId: "off_sibling",
        name: "Sibling Offering",
        productId: "prod-sibling",
      },
    ],
  });

  await prisma.feature.createMany({
    data: [
      {
        id: "feat-main-a",
        integrationId,
        externalSourceId: "feat_main_a",
        name: "Shared Feature",
        lookupKey: "shared",
        isMetered: false,
      },
      {
        // Same lookup key in the same integration: folded into one row.
        id: "feat-main-b",
        integrationId,
        externalSourceId: "feat_main_b",
        name: "Shared Feature",
        lookupKey: "shared",
        unit: "seats",
      },
      {
        id: "feat-main-solo",
        integrationId,
        externalSourceId: "feat_main_solo",
        name: "Solo Feature",
        lookupKey: "solo",
      },
      {
        // Same key, different integration: a different feature.
        id: "feat-sibling",
        integrationId: siblingIntegrationId,
        externalSourceId: "feat_sibling",
        name: "Shared Feature",
        lookupKey: "shared",
      },
    ],
  });
  await prisma.entitlement.createMany({
    data: [
      {
        id: "ent-main-a",
        integrationId,
        externalSourceId: "ent_main_a",
        featureId: "feat-main-a",
        offeringId: "off-main-a",
      },
      {
        id: "ent-main-b",
        integrationId,
        externalSourceId: "ent_main_b",
        featureId: "feat-main-b",
        offeringId: "off-main-b",
      },
      {
        id: "ent-main-solo",
        integrationId,
        externalSourceId: "ent_main_solo",
        featureId: "feat-main-solo",
        offeringId: "off-main-a",
      },
      {
        // Unlinked on purpose: counted in `unlinkedEntitlements`.
        id: "ent-main-unlinked",
        integrationId,
        externalSourceId: "ent_main_unlinked",
        offeringId: "off-main-a",
      },
      {
        id: "ent-sibling",
        integrationId: siblingIntegrationId,
        externalSourceId: "ent_sibling",
        featureId: "feat-sibling",
        offeringId: "off-sibling",
      },
    ],
  });

  // -- Agreements ------------------------------------------------------------
  await prisma.agreement.createMany({
    data: Array.from({ length: AGREEMENT_COUNT }, (_, index) => ({
      id: `agr-main-${pad(index)}`,
      integrationId,
      externalSourceId: `sub_main_${pad(index)}`,
      name: `Main Agreement ${pad(index)}`,
      agreementType: "subscription",
      status: "active",
      currency: "USD",
      externalCustomerId: index === 0 ? "cus_missing" : null,
    })),
  });
  await prisma.subscription.createMany({
    data: Array.from({ length: AGREEMENT_COUNT }, (_, index) => ({
      id: `sub-main-${pad(index)}`,
      integrationId,
      externalSourceId: `sub_main_${pad(index)}`,
      agreementId: `agr-main-${pad(index)}`,
      nextBillingAt: new Date(Date.UTC(2026, 0, 1 + index)),
    })),
  });
  await prisma.agreement.createMany({
    data: [
      {
        id: "agr-sibling-0",
        integrationId: siblingIntegrationId,
        externalSourceId: "sub_sibling_0",
        name: "Sibling Agreement 0",
        agreementType: "subscription",
        status: "active",
      },
      {
        id: "agr-sibling-1",
        integrationId: siblingIntegrationId,
        externalSourceId: "sub_sibling_1",
        name: "Sibling Agreement 1",
        agreementType: "subscription",
        status: "active",
      },
    ],
  });
  await prisma.subscription.createMany({
    data: [
      {
        id: "sub-sibling-0",
        integrationId: siblingIntegrationId,
        externalSourceId: "sub_sibling_0",
        agreementId: "agr-sibling-0",
        nextBillingAt: new Date(Date.UTC(2026, 5, 1)),
      },
      {
        id: "sub-sibling-1",
        integrationId: siblingIntegrationId,
        externalSourceId: "sub_sibling_1",
        agreementId: "agr-sibling-1",
        nextBillingAt: new Date(Date.UTC(2026, 5, 2)),
      },
    ],
  });

  // -- Billing ---------------------------------------------------------------
  await prisma.invoice.createMany({
    data: [
      {
        id: "inv-main-0",
        integrationId,
        externalSourceId: "inv_main_0",
        number: "INV-0",
        status: "paid",
        issuedAt: new Date(Date.UTC(2026, 2, 1)),
        externalCustomerId: "cus_missing",
      },
      {
        id: "inv-main-1",
        integrationId,
        externalSourceId: "inv_main_1",
        number: "INV-1",
        status: "open",
        issuedAt: new Date(Date.UTC(2026, 2, 2)),
        externalAgreementId: "sub_missing",
      },
      {
        id: "inv-main-2",
        integrationId,
        externalSourceId: "inv_main_2",
        number: "INV-2",
        status: "draft",
        issuedAt: null,
      },
      {
        id: "inv-sibling",
        integrationId: siblingIntegrationId,
        externalSourceId: "inv_sibling",
        number: "INV-S",
        status: "paid",
        issuedAt: new Date(Date.UTC(2026, 2, 3)),
      },
    ],
  });
  await prisma.invoiceLine.create({
    data: {
      integrationId,
      externalSourceId: "inv_main_0_line",
      invoiceId: "inv-main-0",
      description: "Main line",
      amountMinor: 4200,
    },
  });
  await prisma.payment.createMany({
    data: [
      {
        integrationId,
        externalSourceId: "pay_main_0",
        kind: "payment",
        invoiceId: "inv-main-0",
      },
      {
        integrationId: siblingIntegrationId,
        externalSourceId: "pay_sibling_0",
        kind: "payment",
        invoiceId: "inv-sibling",
      },
    ],
  });

  // -- Messages --------------------------------------------------------------
  await prisma.message.createMany({
    data: [
      {
        integrationId,
        externalSourceId: "msg_main_0",
        subject: "Main message 0",
        sentAt: new Date(Date.UTC(2026, 3, 1)),
        direction: "received",
      },
      {
        integrationId,
        externalSourceId: "msg_main_1",
        subject: "Main message 1",
        sentAt: new Date(Date.UTC(2026, 3, 2)),
        direction: "sent",
      },
      {
        integrationId: siblingIntegrationId,
        externalSourceId: "msg_sibling",
        subject: "Sibling message",
        sentAt: new Date(Date.UTC(2026, 3, 3)),
        direction: "sent",
      },
    ],
  });

  return {
    userId: user.id,
    integrationId,
    siblingIntegrationId,
    foreignIntegrationId,
    sharedAccountId: sharedAccount.id,
  };
}

let seed: Seed;

beforeAll(async () => {
  seed = await seedTenant();
});

describe("scoped customer and contact reads", () => {
  it("returns only the requested connection's rows and totals", async () => {
    const page = await loadSyncedData(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(page.totals.customers).toBe(CUSTOMER_COUNT);
    expect(page.totals.contacts).toBe(2);
    expect(page.totals.unlinkedContacts).toBe(1);
    expect(page.customers.every((row) => row.integrationLabel === MAIN_LABEL));
    expect(page.contacts.every((row) => row.integrationLabel === MAIN_LABEL));
  });

  it("keeps page 1 and page 2 disjoint while totals stay put", async () => {
    const first = await loadSyncedData(seed.userId, {
      integrationId: seed.integrationId,
      page: 1,
    });
    const second = await loadSyncedData(seed.userId, {
      integrationId: seed.integrationId,
      page: 2,
    });

    expect(first.customers).toHaveLength(PAGE_SIZE);
    expect(second.customers).toHaveLength(CUSTOMER_COUNT - PAGE_SIZE);
    expect(first.totals.customers).toBe(second.totals.customers);

    const firstIds = new Set(first.customers.map((row) => row.id));
    expect(second.customers.some((row) => firstIds.has(row.id))).toBe(false);

    // Sorted by name, then id: the window is a contiguous slice of that order,
    // so the first row of page 2 follows the last of page 1.
    expect(second.customers[0]?.name).toBe(
      `Main Customer ${pad(PAGE_SIZE)}`
    );
  });

  it("answers empty for an unknown or foreign integration instead of leaking", async () => {
    for (const integrationId of ["does-not-exist", seed.foreignIntegrationId]) {
      const page = await loadSyncedData(seed.userId, { integrationId });

      expect(page.customers).toHaveLength(0);
      expect(page.contacts).toHaveLength(0);
      expect(page.totals.customers).toBe(0);
    }
  });
});

describe("scoped resolved accounts", () => {
  it("returns accounts with a member from the connection, keeping every member", async () => {
    const accounts = await loadCustomerAccounts(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(accounts.map((account) => account.name)).toEqual(["Main Account"]);
    // The point of the tab: the account is a merge, so the sibling's record is
    // still shown even though it is not what put the account in this view.
    expect(
      accounts[0]?.members.map((member) => member.externalSourceId).sort()
    ).toEqual(["main-customer-000", "sibling-customer-0"]);
  });

  it("counts the same accounts the tab lists", async () => {
    const page = await loadSyncedData(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(page.totals.accounts).toBe(1);
  });
});

describe("scoped catalog reads", () => {
  it("paginates features after grouping and excludes the sibling", async () => {
    const page = await loadCatalog(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(page.products.every((row) => row.integrationLabel === MAIN_LABEL));
    expect(page.offerings.every((row) => row.integrationLabel === MAIN_LABEL));
    expect(page.totals.products).toBe(2);
    expect(page.totals.offerings).toBe(3);

    // Two definitions share a lookup key, so three definitions are two rows.
    expect(page.features).toHaveLength(2);
    expect(page.totals.features).toBe(2);

    const shared = page.features.find((row) => row.lookupKey === "shared");
    expect(shared?.offerings.map((offering) => offering.name)).toEqual([
      "Main Offering A",
      "Main Offering B",
    ]);
    // A gap in one definition is filled from the other.
    expect(shared?.unit).toBe("seats");
  });

  it("scopes the unlinked counts", async () => {
    const page = await loadCatalog(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(page.totals.unlinkedOfferings).toBe(1);
    expect(page.totals.unlinkedEntitlements).toBe(1);
  });
});

describe("scoped agreement reads", () => {
  it("slices the merged list and keeps its totals stable", async () => {
    const first = await loadAgreements(seed.userId, {
      integrationId: seed.integrationId,
      page: 1,
    });
    const second = await loadAgreements(seed.userId, {
      integrationId: seed.integrationId,
      page: 2,
    });

    expect(first.agreements).toHaveLength(PAGE_SIZE);
    expect(second.agreements).toHaveLength(AGREEMENT_COUNT - PAGE_SIZE);
    expect(first.totals).toEqual(second.totals);
    expect(first.totals.agreements).toBe(AGREEMENT_COUNT);
    expect(first.totals.unlinkedCustomers).toBe(1);

    const firstIds = new Set(first.agreements.map((row) => row.id));
    expect(second.agreements.some((row) => firstIds.has(row.id))).toBe(false);

    // Renewal dates are strictly increasing in the fixture, so page 2 starts
    // where page 1 stopped.
    expect(second.agreements[0]?.name).toBe(
      `Main Agreement ${pad(PAGE_SIZE)}`
    );
  });
});

describe("scoped billing reads", () => {
  it("returns only the connection's invoices and payments", async () => {
    const page = await loadInvoices(seed.userId, {
      integrationId: seed.integrationId,
    });

    expect(page.totals.invoices).toBe(3);
    expect(page.totals.payments).toBe(1);
    expect(page.totals.unlinkedCustomers).toBe(1);
    expect(page.totals.unlinkedAgreements).toBe(1);
    expect(page.invoices.every((row) => row.integrationLabel === MAIN_LABEL));
  });
});

describe("scoped message reads", () => {
  it("narrows both the rows and the count", async () => {
    const rows = await loadMessagesForUser(seed.userId, {
      integrationId: seed.integrationId,
    });
    const count = await countMessagesForUser(
      seed.userId,
      seed.integrationId
    );

    expect(rows).toHaveLength(2);
    expect(count).toBe(2);
    expect(rows.every((row) => row.integrationLabel === MAIN_LABEL));
  });
});
