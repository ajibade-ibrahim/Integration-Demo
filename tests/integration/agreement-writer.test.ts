/**
 * The agreement writers against a real database.
 *
 * Sibling of `catalog-writer.test.ts`, covering the two things that are not the
 * same here:
 *
 *   - **Two parents.** Each resolves independently, each warns independently,
 *     and each is repaired independently by the relink pass. The single-parent
 *     writer could not express a half-resolved row at all.
 *   - **A required child FK.** Every other association in this codebase is
 *     nullable and worth keeping unlinked; a subscription without its agreement
 *     is a set of dates about nothing, so it is rejected. That is the one place
 *     the family deliberately breaks the house pattern, which makes it the one
 *     most likely to be "fixed" back by someone tidying up.
 *
 * `agreement-sync.test.ts` drives the same writers through `executeSync` over
 * mocked HTTP. This file talks to them directly, so it can build inputs a
 * provider would never produce — a blank name, an unknown status, a child
 * arriving before its parent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  relinkOrphanedAgreements,
  writeAgreements,
  writeCustomers,
  writeOfferings,
  writeProducts,
  writeRecordsForFunction,
  writeSubscriptions,
  type CollectedRecord,
} from "@/core/sync/record-writer";
import type { TargetObject } from "@/core/types/common";
import type { MappedRecord } from "@/core/types/mapping";
import { loadAgreements } from "@/core/repositories/agreement-repository";

const USER_ID = "user-agreement-writer";
const INTEGRATION_ID = "integration-agreement-writer";

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "agreement-writer@example.test" },
    update: {},
  });
  await prisma.integration.upsert({
    where: { id: INTEGRATION_ID },
    create: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Agreement writer",
    },
    update: {},
  });
});

beforeEach(async () => {
  const where = { where: { integrationId: INTEGRATION_ID } };
  await prisma.subscription.deleteMany(where);
  await prisma.agreement.deleteMany(where);
  await prisma.offering.deleteMany(where);
  await prisma.product.deleteMany(where);
  await prisma.customer.deleteMany(where);
});

afterAll(async () => {
  await prisma.integration
    .delete({ where: { id: INTEGRATION_ID } })
    .catch(() => {});
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

function agreementRecord(
  externalSourceId: string,
  refs: { customer?: string; offering?: string } = {},
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: refs,
    mapped: {
      object: "agreement",
      fields: {
        name: `Agreement ${externalSourceId}`,
        agreementType: "subscription",
        status: "active",
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

function subscriptionRecord(
  externalSourceId: string,
  agreement: string | undefined,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: { agreement },
    mapped: {
      object: "subscription",
      fields: {
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        quantity: "1",
        itemCount: "1",
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

/** The two parent families an agreement resolves against. */
async function seedParents(): Promise<void> {
  await writeCustomers(INTEGRATION_ID, [
    {
      externalSourceId: "cus_1",
      mapped: {
        object: "customer",
        fields: { name: "Acme" },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    },
  ]);
  const products = await writeProducts(INTEGRATION_ID, [
    {
      externalSourceId: "prod_1",
      mapped: {
        object: "product",
        fields: { name: "Platform" },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    },
  ]);
  await writeOfferings(
    INTEGRATION_ID,
    [
      {
        externalSourceId: "price_1",
        externalRefs: { product: "prod_1" },
        mapped: {
          object: "offering",
          fields: {
            name: "$49/month",
            amountMinor: "4900",
            currency: "usd",
            interval: "month",
          },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ],
    products.externalToInternal
  );
}

describe("resolving two parents", () => {
  it("links both halves when both exist", async () => {
    await seedParents();

    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, offering: true },
    });
    expect(row.customer?.name).toBe("Acme");
    expect(row.offering?.name).toBe("$49/month");
  });

  it("resolves each half against its own table", async () => {
    // The assertion a wrong `ParentModel` branch would fail. Both tables are
    // keyed `[integrationId, externalSourceId]`, so a branch looking up the
    // wrong model would still find rows — it would just attach the agreement
    // to the wrong thing. Giving the customer and the offering the *same*
    // provider id is what makes that visible.
    await writeCustomers(INTEGRATION_ID, [
      {
        externalSourceId: "shared_id",
        mapped: {
          object: "customer",
          fields: { name: "Customer with a colliding id" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ]);
    const products = await writeProducts(INTEGRATION_ID, [
      {
        externalSourceId: "prod_1",
        mapped: {
          object: "product",
          fields: { name: "Platform" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ]);
    await writeOfferings(
      INTEGRATION_ID,
      [
        {
          externalSourceId: "shared_id",
          externalRefs: { product: "prod_1" },
          mapped: {
            object: "offering",
            fields: { name: "Offering with a colliding id" },
            customFields: {},
            crossRefs: {},
          } as MappedRecord,
        },
      ],
      products.externalToInternal
    );

    await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "shared_id", offering: "shared_id" }),
    ]);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, offering: true },
    });
    expect(row.customer?.name).toBe("Customer with a colliding id");
    expect(row.offering?.name).toBe("Offering with a colliding id");
  });

  it("warns per unresolved half and keeps the row", async () => {
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_missing", offering: "price_missing" }),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues.map((i) => i.fieldName).sort()).toEqual([
      "associatedCustomerId",
      "associatedOfferingId",
    ]);
    expect(result.issues.every((i) => i.severity === "warning")).toBe(true);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    // Both external ids retained, which is what makes the repair possible.
    expect(row.externalCustomerId).toBe("cus_missing");
    expect(row.externalOfferingId).toBe("price_missing");
  });

  it("says nothing about a half the provider never claimed", async () => {
    // An absent reference and an unresolvable one are different facts. A
    // provider that gives no offering id has told us something; warning about
    // it would be inventing a problem.
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("relinks both edges in one pass, counting the row once", async () => {
    await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);
    await seedParents();

    // One row gained two links. The count answers "how many rows changed", so
    // a row relinked on both halves is still one row.
    expect(await relinkOrphanedAgreements(INTEGRATION_ID)).toBe(1);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, offering: true },
    });
    expect(row.customer?.name).toBe("Acme");
    expect(row.offering?.name).toBe("$49/month");

    // Idempotent: nothing left to repair.
    expect(await relinkOrphanedAgreements(INTEGRATION_ID)).toBe(0);
  });

  it("repairs one edge while the other stays unresolved", async () => {
    await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);

    // Identity syncs; catalog does not.
    await writeCustomers(INTEGRATION_ID, [
      {
        externalSourceId: "cus_1",
        mapped: {
          object: "customer",
          fields: { name: "Acme" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ]);

    expect(await relinkOrphanedAgreements(INTEGRATION_ID)).toBe(1);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.customerId).not.toBeNull();
    expect(row.offeringId).toBeNull();
  });
});

describe("agreement validation policy", () => {
  it("rejects a record with no provider id", async () => {
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("", { customer: "cus_1" }),
    ]);
    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("rejects a blank name", async () => {
    // The same policy a customer, product and offering get. A provider whose
    // records carry no name is expected to synthesize one in its handler.
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}, { name: "   " }),
    ]);
    expect(result.written).toBe(0);
    expect(result.issues[0]?.fieldName).toBe("name");
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("warns and leaves the status unset rather than guessing", async () => {
    // The policy `customer.type` and `offering.interval` get. An agreement
    // whose status we cannot read is still an agreement, and a wrong status is
    // worse than a missing one.
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}, { status: "renegotiating" }),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues[0]?.fieldName).toBe("status");
    expect(result.issues[0]?.severity).toBe("warning");

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.status).toBeNull();
  });

  it("falls back to subscription for an unreadable type, and says so", async () => {
    // Unlike `status`, the discriminator is required in the database, so it
    // cannot simply be left unset. Rejecting the row would throw away a real
    // agreement over a label; a nullable column would be the shapeless table
    // this design exists to avoid. So: a default, stated out loud.
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}, { agreementType: "master_services" }),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues[0]?.fieldName).toBe("agreementType");
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.reason).toMatch(/recorded as subscription/);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.agreementType).toBe("subscription");
  });

  it("accepts every declared type", async () => {
    for (const type of ["subscription", "order_form", "contract", "deal"]) {
      const result = await writeAgreements(INTEGRATION_ID, [
        agreementRecord(`sub_${type}`, {}, { agreementType: type }),
      ]);
      expect(result.issues, type).toEqual([]);
    }

    const rows = await prisma.agreement.findMany({
      where: { integrationId: INTEGRATION_ID },
      select: { agreementType: true },
    });
    expect(rows.map((r) => r.agreementType).sort()).toEqual([
      "contract",
      "deal",
      "order_form",
      "subscription",
    ]);
  });

  it("normalises the case of a type and status", async () => {
    const result = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}, { agreementType: "Contract", status: "ACTIVE" }),
    ]);
    expect(result.issues).toEqual([]);

    const row = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.agreementType).toBe("contract");
    expect(row.status).toBe("active");
  });
});

describe("the subscription half", () => {
  it("rejects a subscription whose agreement is not there", async () => {
    // The one child in this codebase that is not kept unlinked. Its FK is
    // required and cascades, so there is no row to keep and no page that could
    // render one.
    const result = await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", "sub_1")],
      new Map()
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
    expect(result.issues[0]?.reason).toMatch(/was not written/);
  });

  it("rejects a subscription that claims no agreement at all", async () => {
    const result = await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", undefined)],
      new Map()
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.reason).toMatch(/claims no agreement/);
  });

  it("warns when more items exist than the one linked", async () => {
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}),
    ]);
    const result = await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", "sub_1", { itemCount: "3" })],
      agreements.externalToInternal
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.fieldName).toBe("itemCount");
    expect(result.issues[0]?.reason).toMatch(/3 priced items/);
  });

  it("says nothing about a single-item subscription", async () => {
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}),
    ]);
    const result = await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", "sub_1")],
      agreements.externalToInternal
    );
    expect(result.issues).toEqual([]);
  });

  it("stays one row per agreement across a re-sync", async () => {
    // The FK is `@unique`, so a second row for the same agreement is a
    // constraint violation rather than a duplicate. The upsert key has to be
    // the one that prevents it.
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", {}),
    ]);
    for (const attempt of [1, 2]) {
      const result = await writeSubscriptions(
        INTEGRATION_ID,
        [subscriptionRecord("sub_1", "sub_1", { quantity: String(attempt) })],
        agreements.externalToInternal
      );
      expect(result.written).toBe(1);
    }

    const rows = await prisma.subscription.findMany({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(2);
  });
});

describe("per-function dispatch", () => {
  it("writes the agreement before its subscription, whatever order they arrive in", async () => {
    // The collected map is built child-first on purpose. The dispatch reads
    // `objectsForFunction`, not insertion order, and for this family that is a
    // correctness requirement rather than a nicety: the child's FK is
    // required, so a child written first is rejected outright.
    const collected = new Map<TargetObject, CollectedRecord[]>();
    collected.set("subscription", [subscriptionRecord("sub_1", "sub_1")]);
    collected.set("agreement", [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);

    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "agreement",
      collected
    );

    expect(result.counts).toEqual({ agreement: 1, subscription: 1 });
    const row = await prisma.subscription.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { agreement: true },
    });
    expect(row.agreement.externalSourceId).toBe("sub_1");
  });

  it("counts both objects, and no others", async () => {
    const collected = new Map<TargetObject, CollectedRecord[]>();
    collected.set("agreement", [agreementRecord("sub_1", {})]);
    collected.set("subscription", [subscriptionRecord("sub_1", "sub_1")]);

    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "agreement",
      collected
    );

    // No `customer: 0`. An absent key means "not synced", which is what the
    // run report should say for an agreement sync.
    expect(Object.keys(result.counts).sort()).toEqual([
      "agreement",
      "subscription",
    ]);
  });
});

describe("what the agreements page reads", () => {
  it("reports both unresolved counts separately", async () => {
    await writeCustomers(INTEGRATION_ID, [
      {
        externalSourceId: "cus_1",
        mapped: {
          object: "customer",
          fields: { name: "Acme" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ]);

    // Customer resolves, offering does not.
    await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_missing" }),
    ]);

    const page = await loadAgreements(USER_ID);
    expect(page.totals.agreements).toBe(1);
    expect(page.totals.active).toBe(1);
    expect(page.totals.unlinkedCustomers).toBe(0);
    expect(page.totals.unlinkedOfferings).toBe(1);

    const row = page.agreements[0];
    expect(row?.customerName).toBe("Acme");
    expect(row?.offeringName).toBeNull();
    expect(row?.externalOfferingId).toBe("price_missing");
    // No offering means no price to format, rather than a zero.
    expect(row?.price).toBeUndefined();
  });

  it("formats the price from the linked offering", async () => {
    await seedParents();
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);
    await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", "sub_1", { itemCount: "2" })],
      agreements.externalToInternal
    );

    const page = await loadAgreements(USER_ID);
    // Read through the join rather than stored on the agreement: the price
    // belongs to what was sold, and a copy here would be one to keep in step.
    expect(page.agreements[0]?.price).toBe("$49/month");
    expect(page.agreements[0]?.currentPeriodEnd).not.toBeNull();
    expect(page.totals.multiItem).toBe(1);
  });

  it("counts only agreements that are in force as active", async () => {
    for (const [id, status] of [
      ["sub_a", "active"],
      ["sub_b", "trialing"],
      ["sub_c", "past_due"],
      ["sub_d", "canceled"],
      ["sub_e", "expired"],
      ["sub_f", "draft"],
    ] as const) {
      await writeAgreements(INTEGRATION_ID, [
        agreementRecord(id, {}, { status }),
      ]);
    }

    const page = await loadAgreements(USER_ID);
    expect(page.totals.agreements).toBe(6);
    // Trialing and past_due are in force; draft never started and the two
    // terminal states are over.
    expect(page.totals.active).toBe(3);
  });
});
