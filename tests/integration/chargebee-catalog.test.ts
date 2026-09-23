/**
 * Chargebee catalog handler integration tests against a mocked API.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { chargebeeCatalogHandler } from "@/core/providers/chargebee/catalog-handler";
import { chargebeeFieldDiscovery } from "@/core/providers/chargebee/discovery";
import {
  CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1,
  CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1,
  CHARGEBEE_FIXTURE_ITEMS_PAGE_1,
} from "@/core/providers/chargebee/fixtures";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const SITE = "acme-test";
const ITEM_FAMILIES_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/item_families`;
const ITEMS_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/items`;
const ITEM_PRICES_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/item_prices`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  delete process.env["CHARGEBEE_PAGE_SIZE"];
  delete process.env["CHARGEBEE_API_BASE"];
});

afterAll(() => {
  server.close();
});

describe("Chargebee Catalog Handler Sync & Pagination", () => {
  it("yields products, offerings, productFeatures, and prices", async () => {
    server.use(
      http.get(ITEM_FAMILIES_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1)
      ),
      http.get(ITEMS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_ITEMS_PAGE_1)
      ),
      http.get(ITEM_PRICES_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1)
      )
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:chb_test_key`,
      metadata: { site: SITE },
    });

    const { pages, byObject } = await collect(chargebeeCatalogHandler, ctx);

    const objects = pages.map((p) => p.object);
    expect(objects).toEqual(["product", "offering", "productFeature", "price"]);

    // Products (Item Families)
    expect(byObject.product).toHaveLength(1);
    expect(byObject.product[0]?.["id"]).toBe("cb_family_analytics");
    expect(byObject.product[0]?.["name"]).toBe("Analytics Suite");

    // Offerings (Items with type === plan or addon)
    expect(byObject.offering).toHaveLength(2);
    expect(byObject.offering[0]?.["id"]).toBe("cb_item_analytics_pro");
    expect(byObject.offering[0]?.["product_id"]).toBe("cb_family_analytics");

    // Product Features (Items with type === feature)
    expect(byObject.productFeature).toHaveLength(1);
    expect(byObject.productFeature[0]?.["id"]).toBe("cb_item_advanced_reports");
    expect(byObject.productFeature[0]?.["feature_name"]).toBe("Advanced Reports");
    expect(byObject.productFeature[0]?.["lookup_key"]).toBe("cb_item_advanced_reports");

    // Prices (Item Prices)
    expect(byObject.price).toHaveLength(2);
    expect(byObject.price[0]?.["id"]).toBe("cb_price_analytics_pro_monthly");
    expect(byObject.price[0]?.["price_name"]).toBe("Analytics Pro Monthly");
    expect(byObject.price[0]?.["price"]).toBe(9900);
    expect(byObject.price[0]?.["currency_code"]).toBe("USD");
  });
});

describe("Chargebee Catalog Failure Policy", () => {
  it("treats 401 as terminal ReauthorizationRequiredError", async () => {
    server.use(
      http.get(ITEM_FAMILIES_ENDPOINT, () => new HttpResponse(null, { status: 401 }))
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:invalid_key`,
      metadata: { site: SITE },
    });

    await expect(collect(chargebeeCatalogHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });

  it("classifies 5xx as RetryableSyncError", async () => {
    server.use(
      http.get(ITEM_FAMILIES_ENDPOINT, () => new HttpResponse("Error", { status: 503 }))
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:key`,
      metadata: { site: SITE },
    });

    await expect(collect(chargebeeCatalogHandler, ctx)).rejects.toThrow(
      RetryableSyncError
    );
  });
});

describe("Chargebee Catalog Field Discovery", () => {
  it("discovers catalog fields for all 4 target objects", async () => {
    const { ctx } = testContext({
      accessToken: `${SITE}:key`,
      metadata: { site: SITE },
    });

    const productFields = await chargebeeFieldDiscovery.discover(ctx, "product");
    expect(productFields.map((f) => f.path)).toContain("name");
    expect(productFields.map((f) => f.path)).toContain("description");

    const offeringFields = await chargebeeFieldDiscovery.discover(ctx, "offering");
    expect(offeringFields.map((f) => f.path)).toContain("name");

    const priceFields = await chargebeeFieldDiscovery.discover(ctx, "price");
    expect(priceFields.map((f) => f.path)).toContain("price_name");
    expect(priceFields.map((f) => f.path)).toContain("price");
    expect(priceFields.map((f) => f.path)).toContain("currency_code");

    const featureFields = await chargebeeFieldDiscovery.discover(ctx, "productFeature");
    expect(featureFields.map((f) => f.path)).toContain("feature_name");
  });
});
