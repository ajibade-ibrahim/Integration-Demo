import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  featureItemEntitlementsUrl,
  featuresUrl,
  flattenItemPrice,
  itemFamiliesUrl,
  itemPricesUrl,
  itemsUrl,
  parseFeaturesPage,
  parseItemEntitlementsPage,
  parseItemFamiliesPage,
  parseItemPricesPage,
  parseItemsPage,
} from "@/core/providers/chargebee/api";
import { chargebeeCatalogHandler } from "@/core/providers/chargebee/catalog-handler";
import {
  CHARGEBEE_FIXTURE_DASHBOARDS_ENTITLEMENTS,
  CHARGEBEE_FIXTURE_FEATURES_PAGE_1,
  CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1,
  CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1,
  CHARGEBEE_FIXTURE_ITEMS_PAGE_1,
} from "@/core/providers/chargebee/fixtures";
import type { HandlerContext } from "@/core/types/registry";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("Chargebee Catalog API & Parsing", () => {
  it("builds correct catalog URLs", () => {
    expect(itemFamiliesUrl("acme-site", 25, "off_1")).toBe(
      "https://acme-site.chargebee.com/api/v2/item_families?limit=25&next_offset=off_1"
    );
    expect(itemsUrl("acme-site", 50)).toBe(
      "https://acme-site.chargebee.com/api/v2/items?limit=50"
    );
    expect(itemPricesUrl("acme-site", 10)).toBe(
      "https://acme-site.chargebee.com/api/v2/item_prices?limit=10"
    );
  });

  it("parses Item Families page envelope", () => {
    const page = parseItemFamiliesPage(CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1);
    expect(page.records.length).toBe(1);
    expect(page.records[0]?.["id"]).toBe("cb_family_analytics");
    expect(page.records[0]?.["name"]).toBe("Analytics Suite");
  });

  it("builds entitlement URLs, encoding the feature id", () => {
    expect(featuresUrl("acme-site", 25, "off_1")).toBe(
      "https://acme-site.chargebee.com/api/v2/features?limit=25&next_offset=off_1"
    );
    expect(featureItemEntitlementsUrl("acme-site", "cb_feat_1", 10)).toBe(
      "https://acme-site.chargebee.com/api/v2/features/cb_feat_1/item_entitlements?limit=10"
    );
    // A path segment built from response data must not be able to escape it.
    expect(featureItemEntitlementsUrl("acme-site", "a/../../customers", 10)).toBe(
      "https://acme-site.chargebee.com/api/v2/features/a%2F..%2F..%2Fcustomers/item_entitlements?limit=10"
    );
  });

  it("parses Items page envelope", () => {
    const page = parseItemsPage(CHARGEBEE_FIXTURE_ITEMS_PAGE_1);
    expect(page.records.length).toBe(2);
    const plan = page.records.find((r) => r["id"] === "cb_item_analytics_pro");

    expect(plan?.["type"]).toBe("plan");
    expect(plan?.["item_family_id"]).toBe("cb_family_analytics");
  });

  it("parses Features and Item Entitlements page envelopes", () => {
    const features = parseFeaturesPage(CHARGEBEE_FIXTURE_FEATURES_PAGE_1);
    expect(features.records.map((r) => r["id"])).toEqual([
      "cb_feat_advanced_reports",
      "cb_feat_dashboards",
    ]);
    expect(features.records[0]?.["metered"]).toBe(false);

    const entitlements = parseItemEntitlementsPage(
      CHARGEBEE_FIXTURE_DASHBOARDS_ENTITLEMENTS
    );
    expect(entitlements.records.map((r) => r["id"])).toEqual([
      "item-ent-dash-pro",
      "item-ent-dash-seats",
    ]);
    expect(entitlements.records[0]?.["item_id"]).toBe("cb_item_analytics_pro");
    expect(entitlements.records[0]?.["feature_name"]).toBe("Dashboards");
    expect(entitlements.nextOffset).toBeUndefined();
  });

  it("parses Item Prices page envelope", () => {
    const page = parseItemPricesPage(CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1);
    expect(page.records.length).toBe(2);
    expect(page.records[0]?.["id"]).toBe("cb_price_analytics_pro_monthly");
  });

  it("flattens item price pricing details", () => {
    const itemPriceRecord = CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1.list[0]?.item_price;
    if (!itemPriceRecord) throw new Error("Expected item price fixture");

    const flattened = flattenItemPrice(itemPriceRecord);
    expect(flattened["price_name"]).toBe("Analytics Pro Monthly");
    expect(flattened["interval"]).toBe("month");
    expect(flattened["interval_count"]).toBe(1);
    expect(flattened).not.toHaveProperty("price");
    expect(flattened).not.toHaveProperty("currency_code");

    // The handler spreads the raw record first, so passthrough fields reach the
    // mapper from the payload; flattenItemPrice only synthesizes what the payload
    // cannot reach.
    const merged = { ...itemPriceRecord, ...flattened };
    expect(merged["price"]).toBe(9900);
    expect(merged["currency_code"]).toBe("USD");
  });
});

describe("Chargebee Catalog Handler", () => {
  it("extracts external IDs and references correctly", () => {
    expect(
      chargebeeCatalogHandler.externalIdOf({ id: "cb_family_1" })
    ).toBe("cb_family_1");

    expect(
      chargebeeCatalogHandler.externalRefsOf(
        { id: "cb_item_pro", item_family_id: "cb_fam_1" },
        "offering"
      )
    ).toEqual({ product: "cb_fam_1" });

    expect(
      chargebeeCatalogHandler.externalRefsOf(
        { id: "cb_price_1", item_id: "cb_item_pro" },
        "price"
      )
    ).toEqual({ offering: "cb_item_pro" });

    // A definition hangs off nothing; the item entitlement names both parents.
    expect(
      chargebeeCatalogHandler.externalRefsOf(
        { id: "cb_feat_1", name: "Dashboards", metered: false },
        "feature"
      )
    ).toEqual({});

    expect(
      chargebeeCatalogHandler.externalRefsOf(
        {
          id: "item-ent-1",
          item_id: "cb_item_pro",
          feature_id: "cb_feat_1",
          item_family_id: "cb_fam_1",
        },
        "entitlement"
      )
    ).toEqual({ offering: "cb_item_pro", feature: "cb_feat_1" });
  });

  it("fetches catalog pages for products, offerings, and prices", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // 1. Item Families
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1,
      } as Response)
      // 2. Items
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => CHARGEBEE_FIXTURE_ITEMS_PAGE_1,
      } as Response)
      // 3. Item Prices
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1,
      } as Response);

    // Nothing mapped to `feature`, so the entitlements pass makes no request —
    // the three mocks above are the whole conversation.
    const dummyCtx: HandlerContext = {
      integrationId: "int-test",
      accessToken: "acme-test:chb_dummy_key",
      metadata: { site: "acme-test" },
      requestedSourcePaths: new Map(),
    };

    const pages = [];
    for await (const page of chargebeeCatalogHandler.fetchPages(dummyCtx)) {
      pages.push(page);
    }

    expect(pages.map((p) => p.object)).toEqual(["product", "offering", "price"]);
    expect(pages[0]?.records.length).toBe(1);
    expect(pages[1]?.records.length).toBe(2); // plan + addon
    expect(pages[2]?.records.length).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    fetchSpy.mockRestore();
  });
});
