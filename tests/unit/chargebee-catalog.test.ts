import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  flattenItemPrice,
  itemFamiliesUrl,
  itemPricesUrl,
  itemsUrl,
  parseItemFamiliesPage,
  parseItemPricesPage,
  parseItemsPage,
} from "@/core/providers/chargebee/api";
import { chargebeeCatalogHandler } from "@/core/providers/chargebee/catalog-handler";
import {
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

  it("parses Items page envelope", () => {
    const page = parseItemsPage(CHARGEBEE_FIXTURE_ITEMS_PAGE_1);
    expect(page.records.length).toBe(3);
    const plan = page.records.find((r) => r["id"] === "cb_item_analytics_pro");
    const feature = page.records.find(
      (r) => r["id"] === "cb_item_advanced_reports"
    );

    expect(plan?.["type"]).toBe("plan");
    expect(plan?.["item_family_id"]).toBe("cb_family_analytics");

    expect(feature?.["type"]).toBe("feature");
    expect(feature?.["name"]).toBe("Advanced Reports");
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
    expect(flattened["price"]).toBe(9900);
    expect(flattened["currency_code"]).toBe("USD");
    expect(flattened["interval"]).toBe("month");
    expect(flattened["interval_count"]).toBe(1);
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

    expect(
      chargebeeCatalogHandler.externalRefsOf(
        { id: "cb_feat_1", item_family_id: "cb_fam_1" },
        "productFeature"
      )
    ).toEqual({ product: "cb_fam_1" });
  });

  it("fetches catalog pages for products, offerings, features, and prices", async () => {
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

    const dummyCtx: HandlerContext = {
      accessToken: "acme-test:chb_dummy_key",
      metadata: { site: "acme-test" },
      options: {},
    };

    const pages = [];
    for await (const page of chargebeeCatalogHandler.fetchPages(dummyCtx)) {
      pages.push(page);
    }

    expect(pages.length).toBe(4);
    expect(pages[0]?.object).toBe("product");
    expect(pages[0]?.records.length).toBe(1);

    expect(pages[1]?.object).toBe("offering");
    expect(pages[1]?.records.length).toBe(2); // plan + addon

    expect(pages[2]?.object).toBe("productFeature");
    expect(pages[2]?.records.length).toBe(1); // feature

    expect(pages[3]?.object).toBe("price");
    expect(pages[3]?.records.length).toBe(2);

    fetchSpy.mockRestore();
  });
});
