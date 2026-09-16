/**
 * The catalog writers against a real database.
 *
 * The behaviour worth pinning is the association, because its failure mode is
 * quiet. A price can arrive before the product it belongs to — Stripe pages the
 * two resources separately, and an archived or filtered product may simply not
 * come back on a given run. The writer keeps that offering rather than dropping
 * it, retains the provider's product id, and links it on a later run once the
 * product exists. Get any of that wrong and the catalog looks fine: rows are
 * present, nothing errors, the product column is just empty forever.
 *
 * The rest is the writer's rejected/warned split, which differs per field on
 * purpose and is easy to invert by accident.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  relinkOrphanedOfferings,
  writeOfferings,
  writeProducts,
  writeRecordsForFunction,
  type CollectedRecord,
} from "@/core/sync/record-writer";
import type { TargetObject } from "@/core/types/common";
import type { MappedRecord } from "@/core/types/mapping";
import { loadCatalog } from "@/core/repositories/catalog-repository";

const USER_ID = "user-catalog-writer";
const INTEGRATION_ID = "integration-catalog-writer";

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "catalog-writer@example.test" },
    update: {},
  });
  await prisma.integration.upsert({
    where: { id: INTEGRATION_ID },
    create: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Catalog writer",
    },
    update: {},
  });
});

beforeEach(async () => {
  await prisma.offering.deleteMany({ where: { integrationId: INTEGRATION_ID } });
  await prisma.product.deleteMany({ where: { integrationId: INTEGRATION_ID } });
});

afterAll(async () => {
  await prisma.integration
    .delete({ where: { id: INTEGRATION_ID } })
    .catch(() => {});
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

function productRecord(
  externalSourceId: string,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    mapped: {
      object: "product",
      fields: { name: `Product ${externalSourceId}`, ...fields },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

function offeringRecord(
  externalSourceId: string,
  externalParentId: string | undefined,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalParentId,
    mapped: {
      object: "offering",
      fields: {
        name: `Offering ${externalSourceId}`,
        amountMinor: "4900",
        currency: "usd",
        interval: "month",
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

describe("writing products and offerings", () => {
  it("links an offering to the product written in the same run", async () => {
    const products = await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", "prod_1")],
      products.externalToInternal
    );

    expect(offerings.written).toBe(1);
    expect(offerings.issues).toEqual([]);

    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true },
    });
    expect(row.product?.externalSourceId).toBe("prod_1");
    expect(row.amountMinor).toBe(4900);
    expect(row.currency).toBe("usd");
    expect(row.interval).toBe("month");
  });

  it("keeps an offering whose product is missing, and says so", async () => {
    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_orphan", "prod_absent")],
      new Map()
    );

    expect(offerings.written).toBe(1);
    // A warning, not a rejection: the offering is real and the link may still
    // arrive. Dropping it would lose the price too.
    expect(offerings.issues).toHaveLength(1);
    expect(offerings.issues[0]?.severity).toBe("warning");
    expect(offerings.issues[0]?.fieldName).toBe("associatedProductId");

    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.productId).toBeNull();
    // Retained, which is the whole basis of the relink below.
    expect(row.externalProductId).toBe("prod_absent");
  });

  it("links an orphaned offering once its product arrives on a later run", async () => {
    // Run one: the price, with no product.
    await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", "prod_late")],
      new Map()
    );

    // Run two: the product shows up.
    await writeProducts(INTEGRATION_ID, [productRecord("prod_late")]);
    const relinked = await relinkOrphanedOfferings(INTEGRATION_ID);

    expect(relinked).toBe(1);

    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true },
    });
    expect(row.product?.externalSourceId).toBe("prod_late");
  });

  it("finds a product written by an earlier run, not just this one", async () => {
    // Without the database fallback in `resolveAssociation`, an offering whose
    // product did not change would lose its link on every subsequent sync —
    // the failure that only shows up on the second run.
    await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);

    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", "prod_1")],
      new Map() // Empty: nothing was written in "this run".
    );

    expect(offerings.issues).toEqual([]);
    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true },
    });
    expect(row.product?.externalSourceId).toBe("prod_1");
  });

  it("updates rather than duplicating on a re-sync", async () => {
    await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    const first = await prisma.product.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });

    await writeProducts(INTEGRATION_ID, [
      productRecord("prod_1", { name: "Renamed" }),
    ]);

    const rows = await prisma.product.findMany({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(rows).toHaveLength(1);
    // The same internal id: a reissued id would orphan every offering pointing
    // at the old one.
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.name).toBe("Renamed");
  });
});

describe("catalog validation policy", () => {
  it("rejects a record with no provider id", async () => {
    const result = await writeProducts(INTEGRATION_ID, [
      { externalSourceId: undefined, mapped: productRecord("x").mapped },
    ]);
    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("rejects a nameless offering", async () => {
    const result = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", undefined, { name: null })],
      new Map()
    );
    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
    expect(result.issues[0]?.fieldName).toBe("name");
  });

  it("warns and unsets an amount that is not a whole number", async () => {
    // Not rejected: the offering still has a name, a currency and an interval
    // worth keeping. Same policy `customer.type` gets.
    const result = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", undefined, { amountMinor: "49.99" })],
      new Map()
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.fieldName).toBe("amountMinor");

    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    // Null, not 49 — truncating a major-unit price into the minor-unit column
    // would be wrong by a factor of a hundred and look entirely plausible.
    expect(row.amountMinor).toBeNull();
  });

  it("warns and unsets an unrecognised billing interval", async () => {
    const result = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", undefined, { interval: "fortnight" })],
      new Map()
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.fieldName).toBe("interval");
    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.interval).toBeNull();
  });

  it("keeps one_time as a value rather than treating it as absent", async () => {
    await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("price_1", undefined, { interval: "one_time" })],
      new Map()
    );
    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.interval).toBe("one_time");
  });

  it("distinguishes an unstated active flag from a false one", async () => {
    await writeProducts(INTEGRATION_ID, [
      productRecord("prod_told", { active: "false" }),
      productRecord("prod_untold"),
    ]);

    const told = await prisma.product.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "prod_told" },
    });
    const untold = await prisma.product.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "prod_untold" },
    });

    expect(told.active).toBe(false);
    expect(untold.active).toBeNull();
  });
});

describe("per-function dispatch", () => {
  it("writes the catalog in parent-then-child order from one call", async () => {
    const collected = new Map<TargetObject, CollectedRecord[]>([
      ["offering", [offeringRecord("price_1", "prod_1")]],
      ["product", [productRecord("prod_1")]],
    ]);

    // Note the map is built child-first: ordering must come from the function's
    // declared write order, not from insertion order.
    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "catalog",
      collected
    );

    expect(result.counts).toEqual({ product: 1, offering: 1 });
    expect(result.issues).toEqual([]);

    const row = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true },
    });
    expect(row.product?.externalSourceId).toBe("prod_1");
  });

  it("reports only the objects its function writes", async () => {
    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "catalog",
      new Map()
    );
    // No `customer: 0`. An absent key means "not synced", which is what the run
    // report should say for a catalog sync.
    expect(Object.keys(result.counts).sort()).toEqual(["offering", "product"]);
  });

  it("refuses a function it has no writers for, loudly", async () => {
    // A registration mistake rather than a user error: the sync engine resolves
    // a handler before reaching the writer, so silence here would mean a
    // successful-looking run that wrote nothing.
    await expect(
      writeRecordsForFunction(INTEGRATION_ID, "agreement", new Map())
    ).rejects.toThrow(/no record writers/i);
  });
});

describe("what the catalog page reads", () => {
  it("reports products with their offering counts, and unlinked offerings", async () => {
    await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    const products = await prisma.product.findMany({
      where: { integrationId: INTEGRATION_ID },
    });
    const index = new Map(products.map((p) => [p.externalSourceId, p.id]));

    await writeOfferings(
      INTEGRATION_ID,
      [
        offeringRecord("price_1", "prod_1"),
        offeringRecord("price_2", "prod_1", { amountMinor: "9900" }),
        offeringRecord("price_orphan", "prod_gone"),
      ],
      index
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals).toEqual({
      products: 1,
      offerings: 3,
      // The number the page banner exists to show. Without it, three rows look
      // like three healthy rows and one product column is silently empty.
      unlinkedOfferings: 1,
    });
    expect(page.products[0]?.offeringCount).toBe(2);

    const orphan = page.offerings.find((o) => o.externalSourceId === "price_orphan");
    expect(orphan?.productName).toBeNull();
    expect(orphan?.externalProductId).toBe("prod_gone");
  });

  it("scopes to the requesting user", async () => {
    // The rule every request-scoped read here follows. A catalog leaking across
    // tenants would be the same class of failure the identity layer guards
    // against, and it is one forgotten `where` away.
    await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);

    const other = await loadCatalog("user-who-owns-nothing");
    expect(other.totals.products).toBe(0);
    expect(other.products).toEqual([]);
  });
});
