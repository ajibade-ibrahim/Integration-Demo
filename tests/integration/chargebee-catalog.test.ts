/**
 * Chargebee catalog handler integration tests against a mocked API.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { chargebeeCatalogHandler } from "@/core/providers/chargebee/catalog-handler";
import { chargebeeCatalogDefaults } from "@/core/providers/chargebee/defaults";
import { chargebeeFieldDiscovery } from "@/core/providers/chargebee/discovery";
import {
  CHARGEBEE_FIXTURE_ADVANCED_REPORTS_ENTITLEMENTS,
  CHARGEBEE_FIXTURE_DASHBOARDS_ENTITLEMENTS,
  CHARGEBEE_FIXTURE_FEATURES_PAGE_1,
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
const FEATURES_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/features`;
const FEATURE_ENTITLEMENTS_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/features/:featureId/item_entitlements`;

/** What the default mapping requests — enough to switch the features pass on. */
const FEATURES_MAPPED = { feature: ["feature_name"] };

const CREDENTIALS = {
  accessToken: `${SITE}:chb_test_key`,
  metadata: { site: SITE },
};

/** The three catalog endpoints every run reads, before any feature request. */
function catalogEndpoints() {
  return [
    http.get(ITEM_FAMILIES_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1)
    ),
    http.get(ITEMS_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_ITEMS_PAGE_1)
    ),
    http.get(ITEM_PRICES_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1)
    ),
  ];
}

const ENTITLEMENTS_BY_FEATURE: Record<string, unknown> = {
  cb_feat_advanced_reports: CHARGEBEE_FIXTURE_ADVANCED_REPORTS_ENTITLEMENTS,
  cb_feat_dashboards: CHARGEBEE_FIXTURE_DASHBOARDS_ENTITLEMENTS,
};

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
  it("yields products, offerings, and prices", async () => {
    server.use(...catalogEndpoints());

    const { ctx } = testContext(CREDENTIALS);

    const { pages, byObject } = await collect(chargebeeCatalogHandler, ctx);

    const objects = pages.map((p) => p.object);
    expect(objects).toEqual(["product", "offering", "price"]);

    // Products (Item Families)
    expect(byObject.product).toHaveLength(1);
    expect(byObject.product[0]?.["id"]).toBe("cb_family_analytics");
    expect(byObject.product[0]?.["name"]).toBe("Analytics Suite");

    // Offerings (Items of every type: plan, addon, charge)
    expect(byObject.offering).toHaveLength(2);
    expect(byObject.offering[0]?.["id"]).toBe("cb_item_analytics_pro");
    expect(byObject.offering[0]?.["product_id"]).toBe("cb_family_analytics");

    // Prices (Item Prices)
    expect(byObject.price).toHaveLength(2);
    expect(byObject.price[0]?.["id"]).toBe("cb_price_analytics_pro_monthly");
    expect(byObject.price[0]?.["price_name"]).toBe("Analytics Pro Monthly");
    expect(byObject.price[0]?.["price"]).toBe(9900);
    expect(byObject.price[0]?.["currency_code"]).toBe("USD");
  });
});

describe("Chargebee features (item entitlements)", () => {
  it("makes no entitlement request when nothing is mapped to the object", async () => {
    // `onUnhandledRequest: "error"` would fail the run on any /features call,
    // but the count is asserted too so the intent survives a config change.
    let entitlementRequests = 0;
    server.use(
      ...catalogEndpoints(),
      http.get(FEATURES_ENDPOINT, () => {
        entitlementRequests += 1;
        return HttpResponse.json(CHARGEBEE_FIXTURE_FEATURES_PAGE_1);
      })
    );

    const { ctx } = testContext(CREDENTIALS);
    const { byObject } = await collect(chargebeeCatalogHandler, ctx);

    expect(entitlementRequests).toBe(0);
    expect(byObject.feature).toEqual([]);
  });

  it("makes one request, and no fan-out, when the site defines no features", async () => {
    const featureRequests: string[] = [];
    server.use(
      ...catalogEndpoints(),
      http.get(FEATURES_ENDPOINT, () => HttpResponse.json({ list: [] })),
      http.get(FEATURE_ENTITLEMENTS_ENDPOINT, ({ params }) => {
        featureRequests.push(String(params["featureId"]));
        return HttpResponse.json({ list: [] });
      })
    );

    const { ctx } = testContext({ ...CREDENTIALS, sources: FEATURES_MAPPED });
    const { byObject } = await collect(chargebeeCatalogHandler, ctx);

    expect(featureRequests).toEqual([]);
    expect(byObject.feature).toEqual([]);
  });

  it("yields one row per item entitlement, after every catalog page", async () => {
    const featureRequests: string[] = [];
    server.use(
      ...catalogEndpoints(),
      http.get(FEATURES_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_FEATURES_PAGE_1)
      ),
      http.get(FEATURE_ENTITLEMENTS_ENDPOINT, ({ params }) => {
        const id = String(params["featureId"]);
        featureRequests.push(id);
        return HttpResponse.json(ENTITLEMENTS_BY_FEATURE[id] ?? { list: [] });
      })
    );

    const { ctx } = testContext({ ...CREDENTIALS, sources: FEATURES_MAPPED });
    const { pages, byObject } = await collect(chargebeeCatalogHandler, ctx);

    // Last, so every offering a feature names is already in the index.
    expect(pages.map((p) => p.object)).toEqual([
      "product",
      "offering",
      "price",
      "feature",
      "feature",
    ]);
    expect(featureRequests).toEqual([
      "cb_feat_advanced_reports",
      "cb_feat_dashboards",
    ]);

    // Keyed on the attachment, so one feature on two items is two rows.
    expect(byObject.feature.map((f) => f["id"])).toEqual([
      "item-ent-reports-pro",
      "item-ent-dash-pro",
      "item-ent-dash-seats",
    ]);

    const [reports, dashPro, dashSeats] = byObject.feature;
    expect(reports?.["feature_name"]).toBe("Advanced Reports");
    expect(reports?.["feature_id"]).toBe("cb_feat_advanced_reports");

    // The offering comes from the payload's own `item_id`.
    expect(
      byObject.feature.map((f) => chargebeeCatalogHandler.externalRefsOf(f, "feature"))
    ).toEqual([
      { offering: "cb_item_analytics_pro" },
      { offering: "cb_item_analytics_pro" },
      { offering: "cb_item_extra_seats" },
    ]);

    // The entitlement level travels with the row, for a custom-field mapping.
    expect([dashPro?.["value"], dashPro?.["name"]]).toEqual(["50", "Maximum"]);
    expect([dashSeats?.["value"], dashSeats?.["name"]]).toEqual(["1", "Minimum"]);
  });

  it("follows next_offset on both the feature list and each feature's entitlements", async () => {
    const featureOffsets: (string | null)[] = [];
    const entitlementOffsets: (string | null)[] = [];
    server.use(
      ...catalogEndpoints(),
      http.get(FEATURES_ENDPOINT, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("next_offset");
        featureOffsets.push(offset);
        return HttpResponse.json(
          offset === null
            ? { list: [{ feature: { id: "cb_feat_a" } }], next_offset: "f2" }
            : { list: [{ feature: { id: "cb_feat_b" } }] }
        );
      }),
      http.get(FEATURE_ENTITLEMENTS_ENDPOINT, ({ params, request }) => {
        const id = String(params["featureId"]);
        const offset = new URL(request.url).searchParams.get("next_offset");
        entitlementOffsets.push(`${id}:${offset}`);
        const entitlement = (n: number) => ({
          item_entitlement: {
            id: `ent-${id}-${n}`,
            item_id: "cb_item_analytics_pro",
            feature_id: id,
            feature_name: id,
          },
        });
        // Only feature A has a second page.
        if (id === "cb_feat_a" && offset === null) {
          return HttpResponse.json({ list: [entitlement(1)], next_offset: "e2" });
        }
        return HttpResponse.json({ list: [entitlement(offset === null ? 1 : 2)] });
      })
    );

    const { ctx } = testContext({ ...CREDENTIALS, sources: FEATURES_MAPPED });
    const { byObject } = await collect(chargebeeCatalogHandler, ctx);

    expect(featureOffsets).toEqual([null, "f2"]);
    expect(entitlementOffsets).toEqual([
      "cb_feat_a:null",
      "cb_feat_a:e2",
      "cb_feat_b:null",
    ]);
    expect(byObject.feature.map((f) => f["id"])).toEqual([
      "ent-cb_feat_a-1",
      "ent-cb_feat_a-2",
      "ent-cb_feat_b-1",
    ]);
  });

  it("fails the run rather than reading a broken feature list as 'no features'", async () => {
    server.use(
      ...catalogEndpoints(),
      http.get(FEATURES_ENDPOINT, () => new HttpResponse("Error", { status: 503 }))
    );

    const { ctx } = testContext({ ...CREDENTIALS, sources: FEATURES_MAPPED });
    await expect(collect(chargebeeCatalogHandler, ctx)).rejects.toThrow(
      RetryableSyncError
    );
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

    const featureFields = await chargebeeFieldDiscovery.discover(ctx, "feature");
    expect(featureFields.map((f) => f.path)).toContain("feature_name");
  });

  it("offers every source path the default feature mapping names", async () => {
    // Otherwise the editor would show a shipped rule pointing at a field it
    // claims does not exist.
    const { ctx } = testContext(CREDENTIALS);
    const paths = (await chargebeeFieldDiscovery.discover(ctx, "feature")).map(
      (f) => f.path
    );
    const defaultSources = chargebeeCatalogDefaults
      .filter((rule) => rule.targetObject === "feature")
      .map((rule) => rule.sourceFieldPath);

    expect(defaultSources.length).toBeGreaterThan(0);
    for (const source of defaultSources) {
      expect(paths).toContain(source);
    }
  });
});
