/**
 * The account commercial read model: one account, two independent state axes,
 * and records reached through the account's members rather than through one
 * connection.
 *
 * Rows are written with Prisma directly. Driving four providers to produce two
 * agreements, four invoices and four payments would test the writers, which are
 * covered elsewhere; this file is about the shape the account page reads.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { loadAccountCommercial } from "@/core/repositories/account-commercial-repository";

const USER_ID = "user-account-commercial";
const OTHER_USER_ID = "user-account-commercial-other";

interface Seeded {
  accountId: string;
  otherAccountId: string;
  memberCustomerIds: string[];
}

async function seed(): Promise<Seeded> {
  await prisma.user.deleteMany({
    where: { id: { in: [USER_ID, OTHER_USER_ID] } },
  });

  await prisma.user.create({
    data: { id: USER_ID, email: "account-commercial@test.local" },
  });
  await prisma.user.create({
    data: { id: OTHER_USER_ID, email: "account-commercial-other@test.local" },
  });

  const stripe = await prisma.integration.create({
    data: {
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Stripe — Acme",
    },
  });
  const chargebee = await prisma.integration.create({
    data: {
      userId: USER_ID,
      providerName: "chargebee",
      status: "active",
      instanceLabel: "Chargebee — Acme",
    },
  });
  const otherIntegration = await prisma.integration.create({
    data: {
      userId: OTHER_USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Someone else",
    },
  });

  const account = await prisma.customerAccount.create({
    data: { userId: USER_ID, name: "Acme" },
  });
  const otherAccount = await prisma.customerAccount.create({
    data: { userId: OTHER_USER_ID, name: "Other Co" },
  });

  const stripeCustomer = await prisma.customer.create({
    data: {
      integrationId: stripe.id,
      externalSourceId: "cus_stripe",
      name: "Acme (Stripe)",
      customerAccountId: account.id,
    },
  });
  const chargebeeCustomer = await prisma.customer.create({
    data: {
      integrationId: chargebee.id,
      externalSourceId: "cus_chargebee",
      name: "Acme (Chargebee)",
      customerAccountId: account.id,
    },
  });
  const otherCustomer = await prisma.customer.create({
    data: {
      integrationId: otherIntegration.id,
      externalSourceId: "cus_other",
      name: "Other Co",
      customerAccountId: otherAccount.id,
    },
  });

  const activeStripe = await prisma.agreement.create({
    data: {
      integrationId: stripe.id,
      externalSourceId: "sub_active",
      name: "Stripe annual",
      agreementType: "subscription",
      status: "active",
      currency: "USD",
      customerId: stripeCustomer.id,
    },
  });
  const trialingChargebee = await prisma.agreement.create({
    data: {
      integrationId: chargebee.id,
      externalSourceId: "sub_trial",
      name: "Chargebee trial",
      agreementType: "subscription",
      status: "trialing",
      currency: "USD",
      customerId: chargebeeCustomer.id,
    },
  });
  const cancelledStripe = await prisma.agreement.create({
    data: {
      integrationId: stripe.id,
      externalSourceId: "sub_cancelled",
      name: "Stripe cancelled",
      agreementType: "subscription",
      status: "canceled",
      currency: "USD",
      customerId: stripeCustomer.id,
    },
  });
  const endingChargebee = await prisma.agreement.create({
    data: {
      integrationId: chargebee.id,
      externalSourceId: "sub_ending",
      name: "Chargebee ending",
      agreementType: "subscription",
      status: "active",
      currency: "USD",
      customerId: chargebeeCustomer.id,
    },
  });
  const otherAgreement = await prisma.agreement.create({
    data: {
      integrationId: otherIntegration.id,
      externalSourceId: "sub_other",
      name: "Other subscription",
      agreementType: "subscription",
      status: "active",
      currency: "USD",
      customerId: otherCustomer.id,
    },
  });

  await prisma.subscription.createMany({
    data: [
      {
        integrationId: stripe.id,
        externalSourceId: "sub_active",
        agreementId: activeStripe.id,
        nextBillingAt: new Date("2026-12-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
      },
      {
        integrationId: chargebee.id,
        externalSourceId: "sub_trial",
        agreementId: trialingChargebee.id,
        nextBillingAt: new Date("2026-11-15T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-11-15T00:00:00.000Z"),
        trialEndsAt: new Date("2026-11-15T00:00:00.000Z"),
      },
      {
        integrationId: stripe.id,
        externalSourceId: "sub_cancelled",
        agreementId: cancelledStripe.id,
        nextBillingAt: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      },
      {
        integrationId: chargebee.id,
        externalSourceId: "sub_ending",
        agreementId: endingChargebee.id,
        currentPeriodEnd: new Date("2026-10-15T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      },
      {
        integrationId: otherIntegration.id,
        externalSourceId: "sub_other",
        agreementId: otherAgreement.id,
        nextBillingAt: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
      },
    ],
  });

  const openInvoice = await prisma.invoice.create({
    data: {
      integrationId: stripe.id,
      externalSourceId: "in_open",
      number: "IN-OPEN",
      status: "open",
      currency: "USD",
      totalMinor: 5000,
      amountDueMinor: 5000,
      issuedAt: new Date("2026-03-01T00:00:00.000Z"),
      customerId: stripeCustomer.id,
      agreementId: activeStripe.id,
    },
  });
  const pastDueInvoice = await prisma.invoice.create({
    data: {
      integrationId: chargebee.id,
      externalSourceId: "in_past_due",
      number: "IN-PAST-DUE",
      status: "past_due",
      currency: "USD",
      totalMinor: 1000,
      amountDueMinor: 1000,
      issuedAt: new Date("2026-03-02T00:00:00.000Z"),
      customerId: chargebeeCustomer.id,
      agreementId: trialingChargebee.id,
    },
  });
  const agreementOnlyInvoice = await prisma.invoice.create({
    data: {
      integrationId: stripe.id,
      externalSourceId: "in_via_agreement",
      number: "IN-VIA-AGREEMENT",
      status: "paid",
      currency: "USD",
      totalMinor: 2500,
      amountDueMinor: 0,
      issuedAt: new Date("2026-02-01T00:00:00.000Z"),
      agreementId: activeStripe.id,
    },
  });
  const directInvoice = await prisma.invoice.create({
    data: {
      integrationId: chargebee.id,
      externalSourceId: "in_direct",
      number: "IN-DIRECT",
      status: "paid",
      currency: "USD",
      totalMinor: 800,
      amountDueMinor: 0,
      issuedAt: new Date("2026-01-01T00:00:00.000Z"),
      customerId: chargebeeCustomer.id,
    },
  });
  await prisma.invoice.create({
    data: {
      integrationId: otherIntegration.id,
      externalSourceId: "in_other",
      number: "IN-OTHER",
      status: "open",
      currency: "USD",
      totalMinor: 9999,
      amountDueMinor: 9999,
      issuedAt: new Date("2026-03-03T00:00:00.000Z"),
      customerId: otherCustomer.id,
      agreementId: otherAgreement.id,
    },
  });

  await prisma.payment.createMany({
    data: [
      {
        integrationId: stripe.id,
        externalSourceId: "pay_stripe",
        invoiceId: openInvoice.id,
        customerId: stripeCustomer.id,
        kind: "payment",
        status: "succeeded",
        amountMinor: 5000,
        currency: "USD",
        processedAt: new Date("2026-03-05T00:00:00.000Z"),
      },
      {
        integrationId: chargebee.id,
        externalSourceId: "refund_chargebee",
        customerId: chargebeeCustomer.id,
        kind: "refund",
        status: "succeeded",
        amountMinor: 800,
        currency: "USD",
        processedAt: new Date("2026-03-07T00:00:00.000Z"),
      },
      {
        integrationId: stripe.id,
        externalSourceId: "pay_via_agreement",
        invoiceId: agreementOnlyInvoice.id,
        kind: "payment",
        status: "failed",
        amountMinor: 2500,
        currency: "USD",
        processedAt: new Date("2026-03-06T00:00:00.000Z"),
        failureReason: "card_declined",
      },
      {
        integrationId: chargebee.id,
        externalSourceId: "pay_chargebee",
        invoiceId: pastDueInvoice.id,
        customerId: chargebeeCustomer.id,
        kind: "payment",
        status: "succeeded",
        amountMinor: 1000,
        currency: "USD",
        processedAt: new Date("2026-03-08T00:00:00.000Z"),
      },
      {
        integrationId: otherIntegration.id,
        externalSourceId: "pay_other",
        invoiceId: null,
        customerId: otherCustomer.id,
        kind: "payment",
        status: "succeeded",
        amountMinor: 9999,
        currency: "USD",
        processedAt: new Date("2026-03-09T00:00:00.000Z"),
      },
    ],
  });

  return {
    accountId: account.id,
    otherAccountId: otherAccount.id,
    memberCustomerIds: [stripeCustomer.id, chargebeeCustomer.id],
  };
}

let seeded: Seeded;

beforeEach(async () => {
  seeded = await seed();
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { in: [USER_ID, OTHER_USER_ID] } },
  });
  await prisma.$disconnect();
});

describe("loadAccountCommercial", () => {
  it("reaches agreements, invoices and payments through every member", async () => {
    const view = await loadAccountCommercial(USER_ID, seeded.accountId);

    expect(view).not.toBeNull();
    expect(view?.account.members.map((member) => member.externalSourceId)).toEqual(
      ["cus_chargebee", "cus_stripe"]
    );

    expect(view?.agreements.map((row) => row.externalSourceId).sort()).toEqual([
      "sub_active",
      "sub_cancelled",
      "sub_ending",
      "sub_trial",
    ]);

    // `in_via_agreement` has no customer of its own. It belongs here because
    // its agreement's customer is a member, which is the traversal the account
    // view promises.
    expect(view?.invoices.map((row) => row.externalSourceId).sort()).toEqual([
      "in_direct",
      "in_open",
      "in_past_due",
      "in_via_agreement",
    ]);

    // Likewise `pay_via_agreement` reaches the account through invoice →
    // agreement → member.
    expect(view?.payments.map((row) => row.externalSourceId).sort()).toEqual([
      "pay_chargebee",
      "pay_stripe",
      "pay_via_agreement",
      "refund_chargebee",
    ]);

    expect(view?.payments.find((row) => row.externalSourceId === "pay_via_agreement"))
      .toMatchObject({
        status: "failed",
        failureReason: "card_declined",
        invoiceLabel: "IN-VIA-AGREEMENT",
      });
    expect(view?.invoices.find((row) => row.externalSourceId === "in_via_agreement"))
      .toMatchObject({ agreementName: "Stripe annual", status: "paid" });
  });

  it("keeps commercial and payment states independent", async () => {
    const view = await loadAccountCommercial(USER_ID, seeded.accountId);
    const summary = view?.summary;

    expect(summary?.agreementTotal).toBe(4);
    expect(summary?.inForce).toBe(3);
    expect(summary?.cancellingAgreements).toBe(1);
    expect(
      Object.fromEntries(
        (summary?.agreementStatuses ?? []).map((row) => [
          row.status ?? "unknown",
          row.count,
        ])
      )
    ).toEqual({ active: 2, trialing: 1, canceled: 1 });

    expect(summary?.renewal?.at.toISOString()).toBe(
      "2026-11-15T00:00:00.000Z"
    );
    expect(summary?.renewal?.agreementNames).toEqual(["Chargebee trial"]);

    expect(summary?.invoiceTotal).toBe(4);
    expect(
      Object.fromEntries(
        (summary?.invoiceStatuses ?? []).map((row) => [
          row.status ?? "unknown",
          row.count,
        ])
      )
    ).toEqual({ open: 1, paid: 2, past_due: 1 });

    expect(summary?.paymentTotal).toBe(4);
    expect(summary?.payments).toBe(3);
    expect(summary?.refunds).toBe(1);
    expect(summary?.failedPayments).toBe(1);
    expect(summary?.lastPaymentAt?.toISOString()).toBe(
      "2026-03-08T00:00:00.000Z"
    );
  });

  it("does not expose an account to another user or invent one", async () => {
    const { accountId, otherAccountId } = seeded;

    await expect(loadAccountCommercial(OTHER_USER_ID, accountId)).resolves.toBeNull();
    await expect(loadAccountCommercial(USER_ID, otherAccountId)).resolves.toBeNull();
    await expect(loadAccountCommercial(USER_ID, "missing-account")).resolves.toBeNull();
  });

  it("returns an honest empty read for an account with no commercial records", async () => {
    const empty = await prisma.customerAccount.create({
      data: { userId: USER_ID, name: "Empty Co" },
    });

    const view = await loadAccountCommercial(USER_ID, empty.id);

    expect(view?.agreements).toEqual([]);
    expect(view?.invoices).toEqual([]);
    expect(view?.payments).toEqual([]);
    expect(view?.summary).toMatchObject({
      agreementTotal: 0,
      inForce: 0,
      cancellingAgreements: 0,
      renewal: null,
      invoiceTotal: 0,
      paymentTotal: 0,
      payments: 0,
      refunds: 0,
      failedPayments: 0,
      disputedPayments: 0,
      lastPaymentAt: null,
    });
  });
});
