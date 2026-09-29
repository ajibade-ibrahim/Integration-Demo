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
  writeOfferings,
  writePrices,
  writeFeatures,
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
  await prisma.price.deleteMany({ where: { integrationId: INTEGRATION_ID } });
  await prisma.feature.deleteMany({
    where: { integrationId: INTEGRATION_ID },
  });
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

    expect(result.counts).toEqual({ product: 1, offering: 1, price: 1, feature: 0 });
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
 * The feature writer.
 *
 * Shaped like the price writer and validated the same way round, so most of
 * what is pinned here is that the resemblance is real. The two differences are
 * the interesting part: two offerings can legitimately produce two rows for the
 * same feature, and an unresolved offering is a symptom of something worse here
 * than it is for a price, because no relink pass will ever clear it.
 */
describe("writing features", () => {
  function featureRecord(
    externalSourceId: string,
    externalOfferingId: string | undefined,
    fields: Record<string, string | null> = {}
  ): CollectedRecord {
    return {
      externalSourceId,
      externalRefs: { offering: externalOfferingId },
      mapped: {
        object: "feature",
        fields: {
          name: `Feature ${externalSourceId}`,
          lookupKey: `key-${externalSourceId}`,
          externalFeatureId: `feat_${externalSourceId}`,
          ...fields,
        },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    };
  }

  async function offeringIndex(...externalIds: string[]) {
    const written = await writeOfferings(
      INTEGRATION_ID,
      externalIds.map((id) => offeringRecord(id, undefined)),
      new Map()
    );
    return written.externalToInternal;
  }

  it("links a feature to the offering written in the same run", async () => {
    const index = await offeringIndex("off_1");
    const result = await writeFeatures(
      INTEGRATION_ID,
      [featureRecord("prodft_1", "off_1")],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.feature.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(row.offering?.externalSourceId).toBe("off_1");
    expect(row.name).toBe("Feature prodft_1");
    expect(row.lookupKey).toBe("key-prodft_1");
    expect(row.externalFeatureId).toBe("feat_prodft_1");
  });

  it("records whether a feature is metered, keeping unknown distinct from false", async () => {
    const index = await offeringIndex("off_1");
    await writeFeatures(
      INTEGRATION_ID,
      [
        featureRecord("prodft_metered", "off_1", { isMetered: "true" }),
        featureRecord("prodft_flag", "off_1", { isMetered: "false" }),
        featureRecord("prodft_unstated", "off_1"),
      ],
      index
    );

    const rows = await prisma.feature.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { externalSourceId: "asc" },
    });
    const metered = new Map(rows.map((r) => [r.externalSourceId, r.isMetered]));
    expect(metered.get("prodft_metered")).toBe(true);
    expect(metered.get("prodft_flag")).toBe(false);
    // Unmapped is "we were not told", which the nullable column exists to hold.
    expect(metered.get("prodft_unstated")).toBeNull();
  });

  it("keeps a feature whose offering did not resolve, and says so", async () => {
    const result = await writeFeatures(
      INTEGRATION_ID,
      [featureRecord("prodft_1", "off_gone")],
      new Map()
    );

    // Kept rather than dropped, matching the offering policy: a feature with no
    // offering link is still a real feature, and discarding it would lose the
    // name and the lookup key along with the link.
    expect(result.written).toBe(1);
    expect(result.issues).toEqual([
      {
        sourceRecordId: "prodft_1",
        targetObject: "feature",
        reason: "Offering 'off_gone' not found; feature saved without a link",
        fieldName: "associatedOfferingId",
        severity: "warning",
      },
    ]);

    const row = await prisma.feature.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
    // Retained for the warning and the data browser, not for a relink pass.
    expect(row.externalOfferingId).toBe("off_gone");
  });

  it("is not repaired by the catalog relink pass, deliberately", async () => {
    // A feature cannot arrive before its parent — the handler builds its URL
    // from an offering it listed moments earlier — so an unresolved offering
    // means that offering was *rejected*, and a relink pass would be machinery
    // for a state that cannot occur. Pinned so that adding one later is a
    // decision rather than a reflex.
    await writeFeatures(
      INTEGRATION_ID,
      [featureRecord("prodft_1", "off_late")],
      new Map()
    );
    await offeringIndex("off_late");

    const relinked =
      (await relinkOrphanedOfferings(INTEGRATION_ID)) +
      (await relinkOrphanedPrices(INTEGRATION_ID));
    expect(relinked).toBe(0);

    const row = await prisma.feature.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.offeringId).toBeNull();
  });

  it("rejects a feature with no id and one with a blank name", async () => {
    const result = await writeFeatures(
      INTEGRATION_ID,
      [
        { ...featureRecord("prodft_1", undefined), externalSourceId: undefined },
        featureRecord("prodft_2", undefined, { name: "   " }),
      ],
      new Map()
    );

    expect(result.written).toBe(0);
    expect(result.issues.map((i) => [i.sourceRecordId, i.severity, i.reason])).toEqual([
      ["(unknown)", "rejected", "Source record has no id"],
      ["prodft_2", "rejected", "Name is required"],
    ]);
    expect(
      await prisma.feature.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });

  it("writes two rows when two offerings include the same feature", async () => {
    // The whole reason a row is keyed on the attachment id rather than the
    // feature id. Keyed the other way, the second offering would overwrite the
    // first and the catalog would claim the feature belongs to one offering.
    const index = await offeringIndex("off_platform", "off_integrations");
    const result = await writeFeatures(
      INTEGRATION_ID,
      [
        featureRecord("prodft_a", "off_platform", {
          name: "API access",
          lookupKey: "api-access",
          externalFeatureId: "feat_api",
        }),
        featureRecord("prodft_b", "off_integrations", {
          name: "API access",
          lookupKey: "api-access",
          externalFeatureId: "feat_api",
        }),
      ],
      index
    );

    expect(result.written).toBe(2);

    const rows = await prisma.feature.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
      orderBy: { externalSourceId: "asc" },
    });
    expect(rows.map((r) => r.externalFeatureId)).toEqual(["feat_api", "feat_api"]);
    expect(rows.map((r) => r.offering?.externalSourceId)).toEqual([
      "off_platform",
      "off_integrations",
    ]);
  });

  it("re-links a feature on a later run with an empty index", async () => {
    // The ordinary second-sync case: the offering did not change, so nothing
    // put it in this run's map and the only route to the link is the database
    // fallback in `resolveAssociation`. Without it every unchanged feature would
    // silently lose its offering on every sync after the first.
    const index = await offeringIndex("off_1");
    await writeFeatures(
      INTEGRATION_ID,
      [featureRecord("prodft_1", "off_1")],
      index
    );

    const again = await writeFeatures(
      INTEGRATION_ID,
      [featureRecord("prodft_1", "off_1")],
      new Map()
    );

    expect(again.issues).toEqual([]);
    const rows = await prisma.feature.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    // Upserted, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.offering?.externalSourceId).toBe("off_1");
  });

  it("surfaces features on the catalog page, with their counts", async () => {
    const index = await offeringIndex("off_1");
    await writeFeatures(
      INTEGRATION_ID,
      [
        featureRecord("prodft_1", "off_1"),
        featureRecord("prodft_2", "off_1"),
        featureRecord("prodft_orphan", "off_gone"),
      ],
      index
    );

    const page = await loadCatalog(USER_ID);

    expect(page.totals.features).toBe(3);
    // Reported separately from unlinked offerings, because it means something
    // different: the offering was rejected, not merely absent from this page.
    expect(page.totals.unlinkedFeatures).toBe(1);
    expect(page.offerings[0]?.featureCount).toBe(2);

    const orphan = page.features.find(
      (f) => f.externalSourceId === "prodft_orphan"
    );
    expect(orphan?.offeringName).toBeNull();
    expect(orphan?.externalOfferingId).toBe("off_gone");
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
      unlinkedFeatures: 0,
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
