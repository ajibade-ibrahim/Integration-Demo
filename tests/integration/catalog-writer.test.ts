/**
 * The catalog writers against a real database.
 *
 * The behaviour worth pinning is the association, because its failure mode is
 * quiet. A price can arrive before the offering it belongs to — Stripe pages the
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
  relinkOrphanedPrices,
  writeEntitlements,
  writeFeatureDefinitions,
  writeOfferings,
  writePrices,
  writeProducts,
  writeRecordsForFunction,
  type CollectedRecord,
} from "@/core/sync/record-writer";
import type { TargetObject } from "@/core/types/common";
import type { MappedRecord } from "@/core/types/mapping";
import { loadCatalog } from "@/core/repositories/catalog-repository";

const USER_ID = "user-catalog-writer";
const INTEGRATION_ID = "integration-catalog-writer";
// A second connection for the same user, so the "two catalogs do not merge"
// read can be exercised against a real second integration rather than asserted
// in the abstract.
const OTHER_INTEGRATION_ID = "integration-catalog-writer-other";

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
  await prisma.integration.upsert({
    where: { id: OTHER_INTEGRATION_ID },
    create: {
      id: OTHER_INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      // Deliberately the same label as the first connection: grouping is keyed
      // on the integration id, not the name a person reads.
      instanceLabel: "Catalog writer",
    },
    update: {},
  });
});

beforeEach(async () => {
  for (const integrationId of [INTEGRATION_ID, OTHER_INTEGRATION_ID]) {
    await prisma.price.deleteMany({ where: { integrationId } });
    await prisma.entitlement.deleteMany({ where: { integrationId } });
    await prisma.feature.deleteMany({ where: { integrationId } });
    await prisma.offering.deleteMany({ where: { integrationId } });
    await prisma.product.deleteMany({ where: { integrationId } });
  }
});

afterAll(async () => {
  await prisma.integration
    .delete({ where: { id: OTHER_INTEGRATION_ID } })
    .catch(() => {});
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
  externalProductId: string | undefined,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: { product: externalProductId },
    mapped: {
      object: "offering",
      fields: {
        name: `Offering ${externalSourceId}`,
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

function priceRecord(
  externalSourceId: string,
  externalOfferingId: string | undefined,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: { offering: externalOfferingId },
    mapped: {
      object: "price",
      fields: {
        name: `Price ${externalSourceId}`,
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

function featureDefinitionRecord(
  externalSourceId: string,
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    mapped: {
      object: "feature",
      fields: {
        name: `Feature ${externalSourceId}`,
        lookupKey: `key-${externalSourceId}`,
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

function entitlementRecord(
  externalSourceId: string,
  externalRefs: { offering?: string; feature?: string },
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs,
    mapped: {
      object: "entitlement",
      fields,
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
    // Run one: the offering, with no product.
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

describe("writing prices", () => {
  it("links a price to the offering written in the same run", async () => {
    const products = await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("off_1", "prod_1")],
      products.externalToInternal
    );
    const prices = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", "off_1")],
      offerings.externalToInternal
    );

    expect(prices.written).toBe(1);
    expect(prices.issues).toEqual([]);

    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(row.offering?.externalSourceId).toBe("off_1");
    expect(row.amountMinor).toBe(4900);
    expect(row.currency).toBe("usd");
    expect(row.interval).toBe("month");
  });

  it("keeps a price whose offering is missing, and says so", async () => {
    const prices = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_orphan", "off_absent")],
      new Map()
    );

    expect(prices.written).toBe(1);
    expect(prices.issues).toHaveLength(1);
    expect(prices.issues[0]?.severity).toBe("warning");
    expect(prices.issues[0]?.fieldName).toBe("associatedOfferingId");

    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
    expect(row.externalOfferingId).toBe("off_absent");
  });

  it("links an orphaned price once its offering arrives on a later run", async () => {
    // Run one: the price, with no offering.
    await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", "off_late")],
      new Map()
    );

    // Run two: the offering shows up.
    const products = await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("off_late", "prod_1")],
      products.externalToInternal
    );
    const relinked = await relinkOrphanedPrices(INTEGRATION_ID);

    expect(relinked).toBe(1);

    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(row.offering?.externalSourceId).toBe("off_late");
  });

  it("finds an offering written by an earlier run, not just this one", async () => {
    const products = await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("off_1", "prod_1")],
      products.externalToInternal
    );

    const prices = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", "off_1")],
      new Map() // Empty: nothing was written in "this run".
    );

    expect(prices.issues).toEqual([]);
    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(row.offering?.externalSourceId).toBe("off_1");
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

  it("rejects a nameless price", async () => {
    const result = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", undefined, { name: null })],
      new Map()
    );
    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
    expect(result.issues[0]?.fieldName).toBe("name");
  });

  it("warns and unsets an amount that is not a whole number", async () => {
    // Not rejected: the price still has a name, a currency and an interval
    // worth keeping. Same policy `customer.type` gets.
    const result = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", undefined, { amountMinor: "49.99" })],
      new Map()
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.fieldName).toBe("amountMinor");

    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    // Null, not 49 — truncating a major-unit price into the minor-unit column
    // would be wrong by a factor of a hundred and look entirely plausible.
    expect(row.amountMinor).toBeNull();
  });

  it("warns and unsets an unrecognised billing interval", async () => {
    const result = await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", undefined, { interval: "fortnight" })],
      new Map()
    );

    expect(result.written).toBe(1);
    expect(result.issues[0]?.fieldName).toBe("interval");
    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.interval).toBeNull();
  });

  it("keeps one_time as a value rather than treating it as absent", async () => {
    await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", undefined, { interval: "one_time" })],
      new Map()
    );
    const row = await prisma.price.findFirstOrThrow({
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
      ["price", [priceRecord("price_1", "off_1")]],
      ["offering", [offeringRecord("off_1", "prod_1")]],
      ["product", [productRecord("prod_1")]],
    ]);

    // Note the map is built child-first: ordering must come from the function's
    // declared write order, not from insertion order.
    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "catalog",
      collected
    );

    expect(result.counts).toEqual({
      product: 1,
      offering: 1,
      price: 1,
      feature: 0,
      entitlement: 0,
    });
    expect(result.issues).toEqual([]);

    const row = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: { include: { product: true } } },
    });
    expect(row.offering?.externalSourceId).toBe("off_1");
    expect(row.offering?.product?.externalSourceId).toBe("prod_1");
  });

  it("reports only the objects its function writes", async () => {
    const result = await writeRecordsForFunction(
      INTEGRATION_ID,
      "catalog",
      new Map()
    );
    // No `customer: 0`. An absent key means "not synced", which is what the run
    // report should say for a catalog sync.
    expect(Object.keys(result.counts).sort()).toEqual([
      "entitlement",
      "feature",
      "offering",
      "price",
      "product",
    ]);
  });

  it("refuses a function it has no writers for, loudly", async () => {
    // A registration mistake rather than a user error: the sync engine resolves
    // a handler before reaching the writer, so silence here would mean a
    // successful-looking run that wrote nothing.
    //
    // `usage` rather than `agreement`, which this used to name: agreement has
    // writers now. Any declared-but-unbuilt function does, so this test needs
    // one and will need re-pointing again when `usage` is built.
    await expect(
      writeRecordsForFunction(INTEGRATION_ID, "usage", new Map())
    ).rejects.toThrow(/no record writers/i);
  });
});

/**
 * The feature definition writer.
 *
 * Modelled on the product writer — a root object, keyed on its provider id,
 * with nothing to resolve — so what is pinned here is mostly that: the id is the
 * provider's `feat_…`, the name is required and rejected when blank, and the
 * metered flag distinguishes "not metered" from "we were not told".
 */
describe("writing feature definitions", () => {
  it("writes a definition keyed on its own provider id", async () => {
    const result = await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_1", { unit: "dashboard" }),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.feature.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.externalSourceId).toBe("feat_1");
    expect(row.name).toBe("Feature feat_1");
    expect(row.lookupKey).toBe("key-feat_1");
    expect(row.unit).toBe("dashboard");
  });

  it("upserts a definition that arrives again instead of duplicating it", async () => {
    // The handler dedupes a feature shared by two products before it is ever
    // yielded, but the writer must not depend on that: two identical upsert
    // keys have to converge on one row.
    await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_1"),
    ]);
    const second = await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_1", { name: "Renamed" }),
    ]);

    expect(second.written).toBe(1);
    const rows = await prisma.feature.findMany({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
  });

  it("records whether a feature is metered, keeping unknown distinct from false", async () => {
    await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_metered", { isMetered: "true" }),
      featureDefinitionRecord("feat_flag", { isMetered: "false" }),
      featureDefinitionRecord("feat_unstated"),
    ]);

    const rows = await prisma.feature.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { externalSourceId: "asc" },
    });
    const metered = new Map(rows.map((r) => [r.externalSourceId, r.isMetered]));
    expect(metered.get("feat_metered")).toBe(true);
    expect(metered.get("feat_flag")).toBe(false);
    // Unmapped is "we were not told", which the nullable column exists to hold.
    expect(metered.get("feat_unstated")).toBeNull();
  });

  it("rejects a definition with no id and one with a blank name", async () => {
    const result = await writeFeatureDefinitions(INTEGRATION_ID, [
      { ...featureDefinitionRecord("feat_1"), externalSourceId: undefined },
      featureDefinitionRecord("feat_2", { name: "   " }),
    ]);

    expect(result.written).toBe(0);
    expect(result.issues.map((i) => [i.sourceRecordId, i.severity, i.reason])).toEqual([
      ["(unknown)", "rejected", "Source record has no id"],
      ["feat_2", "rejected", "Name is required"],
    ]);
    expect(
      await prisma.feature.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });
});

/**
 * The entitlement writer — the offering × feature join.
 *
 * Shaped like the agreement writer, because it shares the thing that makes that
 * one interesting: **two** parents, each resolved through its own index, each
 * failing independently. The differences worth pinning are that both parents are
 * written earlier in the same run (so an unresolved half means a rejection, not
 * a not-yet), and that no relink pass will ever clear it.
 */
describe("writing entitlements", () => {
  async function offeringIndex(...externalIds: string[]) {
    const written = await writeOfferings(
      INTEGRATION_ID,
      externalIds.map((id) => offeringRecord(id, undefined)),
      new Map()
    );
    return written.externalToInternal;
  }

  async function featureIndex(...externalIds: string[]) {
    const written = await writeFeatureDefinitions(
      INTEGRATION_ID,
      externalIds.map((id) => featureDefinitionRecord(id))
    );
    return written.externalToInternal;
  }

  it("links an entitlement to both parents written in the same run", async () => {
    const offerings = await offeringIndex("off_1");
    const features = await featureIndex("feat_1");

    const result = await writeEntitlements(
      INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_1" })],
      features,
      offerings
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.entitlement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true, feature: true },
    });
    expect(row.offering?.externalSourceId).toBe("off_1");
    expect(row.feature?.externalSourceId).toBe("feat_1");
    expect(row.externalOfferingId).toBe("off_1");
    expect(row.externalFeatureId).toBe("feat_1");
  });

  it("keeps an entitlement whose offering did not resolve, and says so", async () => {
    const features = await featureIndex("feat_1");

    const result = await writeEntitlements(
      INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_gone", feature: "feat_1" })],
      features,
      new Map()
    );

    // Kept rather than dropped, matching the offering policy: an entitlement
    // with one half unresolved is still a real link, and discarding it would
    // lose the other half along with the provider id.
    expect(result.written).toBe(1);
    expect(result.issues).toEqual([
      {
        sourceRecordId: "prodft_1",
        targetObject: "entitlement",
        reason: "Offering 'off_gone' not found; entitlement saved without a link",
        fieldName: "associatedOfferingId",
        severity: "warning",
      },
    ]);

    const row = await prisma.entitlement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
    // Retained for the warning and the data browser, not for a relink pass.
    expect(row.externalOfferingId).toBe("off_gone");
    // The other half is unaffected: one warning, not two.
    expect(row.featureId).not.toBeNull();
  });

  it("keeps an entitlement whose feature did not resolve, and says so", async () => {
    // The half that only the split can produce. Before the definitions table
    // existed the feature was folded into the row, so there was no second index
    // to fail.
    const offerings = await offeringIndex("off_1");

    const result = await writeEntitlements(
      INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_gone" })],
      new Map(),
      offerings
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([
      {
        sourceRecordId: "prodft_1",
        targetObject: "entitlement",
        reason: "Feature 'feat_gone' not found; entitlement saved without a link",
        fieldName: "associatedFeatureId",
        severity: "warning",
      },
    ]);

    const row = await prisma.entitlement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.featureId).toBeNull();
    expect(row.externalFeatureId).toBe("feat_gone");
    expect(row.offeringId).not.toBeNull();
  });

  it("is not repaired by the catalog relink pass, deliberately", async () => {
    // Both parents are written earlier in the same run — the handler builds
    // each entitlement from the feature list and the offering index it just
    // built — so an unresolved half means that parent was *rejected*, and a
    // relink pass would be machinery for a state that cannot occur. Pinned so
    // that adding one later is a decision rather than a reflex.
    await featureIndex("feat_late");
    await writeEntitlements(
      INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_late", feature: "feat_late" })],
      new Map(),
      new Map()
    );
    await offeringIndex("off_late");

    const relinked =
      (await relinkOrphanedOfferings(INTEGRATION_ID)) +
      (await relinkOrphanedPrices(INTEGRATION_ID));
    expect(relinked).toBe(0);

    const row = await prisma.entitlement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
  });

  it("writes two links when two offerings include the same feature", async () => {
    // The reason the definition and the link are separate tables. Two offerings
    // sharing one feature is one definition and two entitlements; keyed on the
    // feature instead, the second offering would overwrite the first and the
    // catalog would claim the feature belongs to one offering.
    const offerings = await offeringIndex("off_platform", "off_integrations");
    const features = await featureIndex("feat_api");

    const result = await writeEntitlements(
      INTEGRATION_ID,
      [
        entitlementRecord("prodft_a", {
          offering: "off_platform",
          feature: "feat_api",
        }),
        entitlementRecord("prodft_b", {
          offering: "off_integrations",
          feature: "feat_api",
        }),
      ],
      features,
      offerings
    );

    expect(result.written).toBe(2);
    // One definition, however many links point at it.
    expect(
      await prisma.feature.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);

    const rows = await prisma.entitlement.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true, feature: true },
      orderBy: { externalSourceId: "asc" },
    });
    expect(rows.map((r) => r.feature?.externalSourceId)).toEqual([
      "feat_api",
      "feat_api",
    ]);
    expect(rows.map((r) => r.offering?.externalSourceId)).toEqual([
      "off_platform",
      "off_integrations",
    ]);
  });

  it("re-links both halves on a later run with empty indexes", async () => {
    // The ordinary second-sync case: neither parent changed, so nothing put
    // either in this run's maps and the only route to the links is the database
    // fallback in `resolveAssociation`. Without it every unchanged entitlement
    // would silently lose both halves on every sync after the first.
    const offerings = await offeringIndex("off_1");
    const features = await featureIndex("feat_1");
    const records = [
      entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_1" }),
    ];

    await writeEntitlements(INTEGRATION_ID, records, features, offerings);
    const again = await writeEntitlements(
      INTEGRATION_ID,
      records,
      new Map(),
      new Map()
    );

    expect(again.issues).toEqual([]);
    const rows = await prisma.entitlement.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true, feature: true },
    });
    // Upserted, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.offering?.externalSourceId).toBe("off_1");
    expect(rows[0]?.feature?.externalSourceId).toBe("feat_1");
  });

  it("mirrors a numeric value into limitValue and leaves a boolean one null", async () => {
    // Two ordinary Chargebee shapes in one run: a numeric level ("50") and a
    // boolean switch ("true"). Neither is an error, and the boolean must not
    // warn on every sync — `true` is not a malformed limit, it is a feature
    // that has no numeric limit at all.
    const offerings = await offeringIndex("off_1");
    const features = await featureIndex("feat_1", "feat_2");

    const result = await writeEntitlements(
      INTEGRATION_ID,
      [
        entitlementRecord(
          "prodft_limit",
          { offering: "off_1", feature: "feat_1" },
          { value: "50", valueName: "Maximum" }
        ),
        entitlementRecord(
          "prodft_flag",
          { offering: "off_1", feature: "feat_2" },
          { value: "true" }
        ),
      ],
      features,
      offerings
    );

    expect(result.issues).toEqual([]);

    const rows = await prisma.entitlement.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { externalSourceId: "asc" },
    });
    const byId = new Map(rows.map((r) => [r.externalSourceId, r]));

    expect(byId.get("prodft_limit")?.value).toBe("50");
    expect(byId.get("prodft_limit")?.limitValue).toBe(50);
    expect(byId.get("prodft_limit")?.valueName).toBe("Maximum");
    expect(byId.get("prodft_flag")?.value).toBe("true");
    // Null means "no number"; `value` is what says it was a boolean rather
    // than an absence.
    expect(byId.get("prodft_flag")?.limitValue).toBeNull();
  });

  it("surfaces feature definitions on the catalog page, with their counts", async () => {
    const offerings = await offeringIndex("off_1");
    const features = await featureIndex("feat_a", "feat_b");

    await writeEntitlements(
      INTEGRATION_ID,
      [
        entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_a" }),
        entitlementRecord("prodft_2", { offering: "off_1", feature: "feat_b" }),
        // Names an offering that was never written, so the page has an
        // unresolved half to report without hiding the two healthy rows.
        entitlementRecord("prodft_orphan", {
          offering: "off_gone",
          feature: "feat_a",
        }),
      ],
      features,
      offerings
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals.features).toBe(2);
    // Counted per entitlement, not per definition: the orphan names a feature
    // that exists, but its offering half did not resolve.
    expect(page.totals.unlinkedEntitlements).toBe(1);
    expect(page.offerings[0]?.entitlementCount).toBe(2);

    const featureA = page.features.find((f) => f.externalSourceId === "feat_a");
    // Resolved offerings sort first, then unresolved ones by their provider id.
    expect(featureA?.offerings).toEqual([
      { name: "Offering off_1", externalId: "off_1" },
      { name: null, externalId: "off_gone" },
    ]);
  });

  it("lists every offering a feature belongs to, comma-separated", async () => {
    // One feature on two offerings, the case that used to be two rows. The
    // page shows it once, with every offering it belongs to in the one cell.
    const offerings = await offeringIndex("off_platform", "off_integrations");
    const features = await featureIndex("feat_api");

    await writeEntitlements(
      INTEGRATION_ID,
      [
        entitlementRecord(
          "prodft_a",
          { offering: "off_platform", feature: "feat_api" },
          { value: "5" }
        ),
        entitlementRecord("prodft_b", {
          offering: "off_integrations",
          feature: "feat_api",
        }),
      ],
      features,
      offerings
    );

    const page = await loadCatalog(USER_ID);

    // One feature, so one row.
    expect(page.totals.features).toBe(1);
    expect(page.features).toHaveLength(1);

    const row = page.features[0];
    expect(row?.lookupKey).toBe("key-feat_api");
    expect(row?.offerings).toEqual([
      { name: "Offering off_integrations", externalId: "off_integrations" },
      { name: "Offering off_platform", externalId: "off_platform" },
    ]);
  });

  it("folds definitions that share a lookup key into one row", async () => {
    // What a lookup key is *for*: two definitions carrying the same key are the
    // same feature as far as anything reading the page is concerned, so they
    // show once with both offerings. Keyed on the definition id instead, the
    // page would list "api-access" twice.
    //
    // The second definition also carries the metered flag and the unit the first
    // one omits, so the fold has to fill the gap: otherwise which definition
    // sorted first would decide whether those columns were blank.
    const offerings = await offeringIndex("off_1", "off_2");
    const features = await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_1", { lookupKey: "api-access" }),
      featureDefinitionRecord("feat_2", {
        lookupKey: "api-access",
        isMetered: "true",
        unit: "seat",
      }),
    ]);

    await writeEntitlements(
      INTEGRATION_ID,
      [
        entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_1" }),
        entitlementRecord("prodft_2", { offering: "off_2", feature: "feat_2" }),
      ],
      features.externalToInternal,
      offerings
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals.features).toBe(1);
    expect(page.features).toHaveLength(1);
    expect(page.features[0]?.lookupKey).toBe("api-access");
    expect(page.features[0]?.isMetered).toBe(true);
    expect(page.features[0]?.unit).toBe("seat");
    expect(page.features[0]?.offerings).toEqual([
      { name: "Offering off_1", externalId: "off_1" },
      { name: "Offering off_2", externalId: "off_2" },
    ]);
  });

  it("keeps a shared lookup key apart per integration", async () => {
    // The limit of the fold above: two connections to two accounts are two
    // separate catalogs, and a key they happen to share must not merge them.
    // The two connections share a display label to make the point that the
    // scope is the integration, not the label a person reads.
    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("off_1", undefined)],
      new Map()
    );
    const otherOfferings = await writeOfferings(
      OTHER_INTEGRATION_ID,
      [offeringRecord("off_1", undefined)],
      new Map()
    );
    const features = await writeFeatureDefinitions(INTEGRATION_ID, [
      featureDefinitionRecord("feat_1", { lookupKey: "api-access" }),
    ]);
    await writeFeatureDefinitions(OTHER_INTEGRATION_ID, [
      featureDefinitionRecord("feat_1", { lookupKey: "api-access" }),
    ]);

    await writeEntitlements(
      INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_1" })],
      features.externalToInternal,
      offerings.externalToInternal
    );
    await writeEntitlements(
      OTHER_INTEGRATION_ID,
      [entitlementRecord("prodft_1", { offering: "off_1", feature: "feat_1" })],
      new Map(),
      otherOfferings.externalToInternal
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals.features).toBe(2);
    expect(page.features).toHaveLength(2);
    // One offering each: merging the two integrations would have collapsed them
    // into a single row carrying both.
    expect(page.features.every((row) => row.offerings.length === 1)).toBe(true);
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
        offeringRecord("off_1", "prod_1"),
        offeringRecord("off_2", "prod_1"),
        offeringRecord("off_orphan", "prod_gone"),
      ],
      index
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals).toEqual({
      products: 1,
      offerings: 3,
      features: 0,
      // The number the page banner exists to show. Without it, three rows look
      // like three healthy rows and one product column is silently empty.
      unlinkedOfferings: 1,
      unlinkedEntitlements: 0,
    });
    expect(page.products[0]?.offeringCount).toBe(2);

    const orphan = page.offerings.find((o) => o.externalSourceId === "off_orphan");
    expect(orphan?.productName).toBeNull();
    expect(orphan?.externalProductId).toBe("prod_gone");
  });

  it("surfaces price fields from the primary price on the catalog offering row", async () => {
    const products = await writeProducts(INTEGRATION_ID, [productRecord("prod_1")]);
    const offerings = await writeOfferings(
      INTEGRATION_ID,
      [offeringRecord("off_1", "prod_1")],
      products.externalToInternal
    );
    await writePrices(
      INTEGRATION_ID,
      [priceRecord("price_1", "off_1")],
      offerings.externalToInternal
    );

    const page = await loadCatalog(USER_ID);
    const row = page.offerings[0];

    // The read model surfaces prices[0] as the primary price for display.
    expect(row?.amountMinor).toBe(4900);
    expect(row?.currency).toBe("usd");
    expect(row?.interval).toBe("month");
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
