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
  relinkOrphanedAgreementItems,
  relinkOrphanedAgreements,
  writeAgreementItems,
  writeAgreements,
  writeCustomers,
  writeOfferings,
  writePrices,
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
  await prisma.agreementItem.deleteMany(where);
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

function itemRecord(
  externalSourceId: string,
  refs: { agreement?: string; offering?: string; price?: string },
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: refs,
    mapped: {
      object: "agreementItem",
      fields: { quantity: "1", position: "0", ...fields },
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
  const offerings = await writeOfferings(
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

  // The money lives on the price now, not on the offering: the offering is what
  // was sold and the price is what it bills at, so an agreement's displayed
  // price is formatted from its line's price row.
  await writePrices(
    INTEGRATION_ID,
    [
      {
        externalSourceId: "price_1",
        externalRefs: { offering: "price_1" },
        mapped: {
          object: "price",
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
    offerings.externalToInternal
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

describe("writing line items", () => {
  /** Write one agreement and hand back the index its items resolve through. */
  async function seedAgreement(
    externalSourceId = "sub_1"
  ): Promise<Map<string, string>> {
    await seedParents();
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord(externalSourceId, {
        customer: "cus_1",
        offering: "price_1",
      }),
    ]);
    return agreements.externalToInternal;
  }

  it("links a line to its agreement and its offering", async () => {
    const index = await seedAgreement();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_1", { agreement: "sub_1", offering: "price_1" })],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.agreementItem.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { agreement: true, offering: true },
    });
    expect(row.agreement.externalSourceId).toBe("sub_1");
    expect(row.offering?.externalSourceId).toBe("price_1");
    expect(row.quantity).toBe(1);
    expect(row.position).toBe(0);
    // Unset, because the default rules map `item_type` and Stripe sends none
    // for a licensed line. Null here means "the provider did not say".
    expect(row.itemType).toBeNull();
  });

  it("rejects a line with no id", async () => {
    const index = await seedAgreement();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("", { agreement: "sub_1" })],
      index
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("rejects a line whose agreement was not written", async () => {
    // The required-FK case, and the one place this family breaks the house
    // pattern on purpose: every other unresolvable parent keeps the row.
    // There is no row to keep here — the column is required and the foreign
    // key cascades, so a line with no agreement is a quantity about nothing.
    const index = await seedAgreement();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_1", { agreement: "sub_MISSING", offering: "price_1" })],
      index
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
    expect(result.issues[0]?.fieldName).toBe("associatedAgreementId");
    expect(
      await prisma.agreementItem.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });

  it("keeps a line whose offering did not resolve, and warns", async () => {
    // The nullable edge, and the opposite answer: the catalog function may
    // simply not be on this integration, and a line that knows its quantity
    // and its position is worth keeping until it is.
    const index = await seedAgreement();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_1", { agreement: "sub_1", offering: "price_GHOST" })],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.fieldName).toBe("associatedOfferingId");

    const row = await prisma.agreementItem.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
    // Retained, which is what makes the repair possible at all.
    expect(row.externalOfferingId).toBe("price_GHOST");
  });

  it("relinks an offering that arrives later", async () => {
    const index = await seedAgreement();
    await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_1", { agreement: "sub_1", offering: "price_LATE" })],
      index
    );

    // The catalog function connects and the price shows up.
    const products = await writeProducts(INTEGRATION_ID, [
      {
        externalSourceId: "prod_2",
        mapped: {
          object: "product",
          fields: { name: "Seats" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ]);
    await writeOfferings(
      INTEGRATION_ID,
      [
        {
          externalSourceId: "price_LATE",
          externalRefs: { product: "prod_2" },
          mapped: {
            object: "offering",
            fields: { name: "$10/seat" },
            customFields: {},
            crossRefs: {},
          } as MappedRecord,
        },
      ],
      products.externalToInternal
    );

    expect(await relinkOrphanedAgreementItems(INTEGRATION_ID)).toBe(1);

    const row = await prisma.agreementItem.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(row.offering?.externalSourceId).toBe("price_LATE");
  });

  it("warns and leaves the type unset for a word it does not know", async () => {
    // The policy every enum on this function gets: a line whose type we
    // cannot read is still a line. Null already means "the provider did not
    // say", so an unreadable value lands in exactly the right state.
    const index = await seedAgreement();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord(
          "si_1",
          { agreement: "sub_1", offering: "price_1" },
          { itemType: "overage" }
        ),
      ],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues.map((i) => i.fieldName)).toEqual(["itemType"]);
    expect(
      (await prisma.agreementItem.findFirstOrThrow({
        where: { integrationId: INTEGRATION_ID },
      })).itemType
    ).toBeNull();
  });

  it("stores a type the provider did give, case-insensitively", async () => {
    const index = await seedAgreement();

    await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord(
          "si_1",
          { agreement: "sub_1", offering: "price_1" },
          { itemType: "Add_On" }
        ),
      ],
      index
    );

    expect(
      (await prisma.agreementItem.findFirstOrThrow({
        where: { integrationId: INTEGRATION_ID },
      })).itemType
    ).toBe("add_on");
  });

  it("is idempotent across runs", async () => {
    const index = await seedAgreement();
    const records = [
      itemRecord("si_1", { agreement: "sub_1", offering: "price_1" }),
      itemRecord(
        "si_2",
        { agreement: "sub_1", offering: "price_1" },
        { position: "1", quantity: "25" }
      ),
    ];

    await writeAgreementItems(INTEGRATION_ID, records, index);
    await writeAgreementItems(INTEGRATION_ID, records, new Map(index));

    // Two rows, not four — and crucially the second run's reconciliation did
    // not delete the rows the second run had just written.
    expect(
      await prisma.agreementItem.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(2);
  });
});

/**
 * The reconciliation matrix — the only place in this system where a sync
 * deletes a synced row.
 *
 * Four cases, and only the first deletes. The other three are the guard: an
 * agreement is reconciled only if at least one of its lines was written this
 * run, so an empty page, a rejected parent, a filtered-out subscription or a
 * handler bug can none of them remove anything.
 *
 * Written before the writer was, because getting these backwards is not a
 * failing test — it is a sync that quietly destroys a customer's line items
 * and reports success.
 */
describe("reconciling line items", () => {
  async function seedTwoLines(): Promise<Map<string, string>> {
    await seedParents();
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
      agreementRecord("sub_2", { customer: "cus_1", offering: "price_1" }),
    ]);
    await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord("si_plan", { agreement: "sub_1", offering: "price_1" }),
        itemRecord(
          "si_seats",
          { agreement: "sub_1", offering: "price_1" },
          { position: "1" }
        ),
        itemRecord("si_other", { agreement: "sub_2", offering: "price_1" }),
      ],
      agreements.externalToInternal
    );
    return agreements.externalToInternal;
  }

  const idsFor = async (externalSourceId: string): Promise<string[]> =>
    (
      await prisma.agreementItem.findMany({
        where: {
          integrationId: INTEGRATION_ID,
          agreement: { externalSourceId },
        },
        select: { externalSourceId: true },
        orderBy: { externalSourceId: "asc" },
      })
    ).map((r) => r.externalSourceId);

  it("deletes a line the agreement no longer has", async () => {
    // The add-on was removed at the provider. The whole point: without this,
    // the line list says three where the subscription has two, and nothing on
    // the row contradicts it.
    const index = await seedTwoLines();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_plan", { agreement: "sub_1", offering: "price_1" })],
      index
    );

    expect(await idsFor("sub_1")).toEqual(["si_plan"]);
    // Reported, not silent. This is the one writer that can lose data, and a
    // run whose numbers changed without saying why is the failure this
    // codebase warns about everywhere else.
    expect(result.issues.map((i) => i.severity)).toEqual(["warning"]);
    expect(result.issues[0]?.reason).toContain("no longer on this agreement");
  });

  it("leaves another agreement's lines alone", async () => {
    const index = await seedTwoLines();

    await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("si_plan", { agreement: "sub_1", offering: "price_1" })],
      index
    );

    expect(await idsFor("sub_2")).toEqual(["si_other"]);
  });

  it("keeps every line when the run yielded none at all", async () => {
    // The guard that matters most. A handler bug, a provider outage mid-page,
    // or a subscription filtered out of this run all arrive here as an empty
    // list — and an empty list must never be read as "this agreement has no
    // lines any more".
    const index = await seedTwoLines();

    const result = await writeAgreementItems(INTEGRATION_ID, [], index);

    expect(result.written).toBe(0);
    expect(result.issues).toEqual([]);
    expect(await idsFor("sub_1")).toEqual(["si_plan", "si_seats"]);
    expect(await idsFor("sub_2")).toEqual(["si_other"]);
  });

  it("keeps every line when this run's lines were all rejected", async () => {
    // Nothing written means nothing to reconcile against, so the guard holds
    // here for the same reason — and this is the case that would otherwise
    // turn a mapping mistake into data loss.
    const index = await seedTwoLines();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [itemRecord("", { agreement: "sub_1", offering: "price_1" })],
      index
    );

    expect(result.written).toBe(0);
    expect(await idsFor("sub_1")).toEqual(["si_plan", "si_seats"]);
  });

  it("keeps every line of an agreement absent from this run", async () => {
    // sub_2 is not mentioned. Reconciliation is per agreement and keyed on
    // what was written, so an agreement nobody wrote a line for is not
    // reconciled at all.
    const index = await seedTwoLines();

    await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord("si_plan", { agreement: "sub_1", offering: "price_1" }),
        itemRecord(
          "si_seats",
          { agreement: "sub_1", offering: "price_1" },
          { position: "1" }
        ),
      ],
      index
    );

    expect(await idsFor("sub_2")).toEqual(["si_other"]);
  });

  it("reports nothing when the lines are unchanged", async () => {
    const index = await seedTwoLines();

    const result = await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord("si_plan", { agreement: "sub_1", offering: "price_1" }),
        itemRecord(
          "si_seats",
          { agreement: "sub_1", offering: "price_1" },
          { position: "1" }
        ),
      ],
      index
    );

    // A steady-state sync must be quiet. A removal warning that fired every
    // run would be the "warning that appears once and then goes quiet" problem
    // in reverse — noise that trains people to ignore the real one.
    expect(result.issues).toEqual([]);
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

    expect(result.counts).toEqual({
      agreement: 1,
      subscription: 1,
      agreementItem: 0,
    });
    const row = await prisma.subscription.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { agreement: true },
    });
    expect(row.agreement.externalSourceId).toBe("sub_1");
  });

  it("counts its own three objects, and no others", async () => {
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
      "agreementItem",
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

  it("formats the price from the line's linked price", async () => {
    await seedParents();
    const agreements = await writeAgreements(INTEGRATION_ID, [
      agreementRecord("sub_1", { customer: "cus_1", offering: "price_1" }),
    ]);
    await writeSubscriptions(
      INTEGRATION_ID,
      [subscriptionRecord("sub_1", "sub_1", { itemCount: "2" })],
      agreements.externalToInternal
    );
    await writeAgreementItems(
      INTEGRATION_ID,
      [
        itemRecord("si_1", {
          agreement: "sub_1",
          offering: "price_1",
          price: "price_1",
        }),
      ],
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
