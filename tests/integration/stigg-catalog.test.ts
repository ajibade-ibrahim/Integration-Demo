/**
 * Stigg catalog handler against a mocked API.
 *
 * What carries the risk here: the version dedupe (a newer draft must not hide
 * the published package), the per-package charge and entitlement fan-outs
 * (gated on what was mapped), and the single-response entitlement read (no
 * cursor exists on those endpoints).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stiggCatalogHandler } from "@/core/providers/stigg/catalog-handler";
import { stiggFieldDiscovery } from "@/core/providers/stigg/discovery";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const BASE = "https://api.stigg.io/api/v1";

const PRODUCTS = `${BASE}/products`;
const PLANS = `${BASE}/plans`;
const ADDONS = `${BASE}/addons`;
const FEATURES = `${BASE}/features`;
const PLAN_CHARGES = `${BASE}/plans/plan-pro/charges`;
const ADDON_CHARGES = `${BASE}/addons/addon-seats/charges`;
const PLAN_ENTITLEMENTS = `${BASE}/plans/plan-pro/entitlements`;
const ADDON_ENTITLEMENTS = `${BASE}/addons/addon-seats/entitlements`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["STIGG_PAGE_SIZE"];
});
afterAll(() => {
  server.close();
});

function product(metadata: Record<string, string> = {}) {
  return {
    id: "prod-1",
    displayName: "Acme Platform",
    description: "The platform",
    status: "PUBLISHED",
    metadata,
  };
}

const PLAN_PRO = {
  id: "plan-pro",
  displayName: "Professional",
  productId: "prod-1",
  status: "PUBLISHED",
  versionNumber: 1,
};

const ADDON_SEATS = {
  id: "addon-seats",
  displayName: "Extra seats",
  productId: "prod-1",
  status: "PUBLISHED",
};

const API_CALLS = {
  id: "api-calls",
  displayName: "API Calls",
  meterType: "INCREMENTAL",
};

const SEATS = {
  id: "seats",
  displayName: "Seats",
  meterType: "None",
};

const PLAN_CHARGE = {
  id: "chg-1",
  billingModel: "FLAT_FEE",
  billingPeriod: "MONTHLY",
  billingCadence: "RECURRING",
  price: { amount: 4900, currency: "USD" },
};

const ADDON_CHARGE = {
  id: "chg-2",
  billingModel: "PER_UNIT",
  billingCadence: "RECURRING",
  price: { amount: 500, currency: "USD" },
};

/** Every endpoint the handler reads, with optional request-count tracking. */
function catalogHandlers(counts: Record<string, number> = {}) {
  const bump = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };

  return [
    http.get(PRODUCTS, () => {
      bump("products");
      return HttpResponse.json({
        data: [product()],
        pagination: { next: null },
      });
    }),
    http.get(PLANS, () => {
      bump("plans");
      return HttpResponse.json({
        data: [PLAN_PRO],
        pagination: { next: null },
      });
    }),
    http.get(ADDONS, () => {
      bump("addons");
      return HttpResponse.json({
        data: [ADDON_SEATS],
        pagination: { next: null },
      });
    }),
    http.get(FEATURES, () => {
      bump("features");
      return HttpResponse.json({
        data: [API_CALLS, SEATS],
        pagination: { next: null },
      });
    }),
    http.get(PLAN_CHARGES, () => {
      bump("planCharges");
      return HttpResponse.json({
        data: [PLAN_CHARGE],
        pagination: { next: null },
      });
    }),
    http.get(ADDON_CHARGES, () => {
      bump("addonCharges");
      return HttpResponse.json({
        data: [ADDON_CHARGE],
        pagination: { next: null },
      });
    }),
    http.get(PLAN_ENTITLEMENTS, () => {
      bump("planEntitlements");
      return HttpResponse.json({
        data: [
          { id: "api-calls", type: "FEATURE", isGranted: true, usageLimit: 50 },
          { id: "credits", type: "CREDIT", amount: 100 },
        ],
        pagination: { next: null },
      });
    }),
    http.get(ADDON_ENTITLEMENTS, () => {
      bump("addonEntitlements");
      return HttpResponse.json({
        data: [{ id: "seats", type: "FEATURE", isGranted: true }],
        pagination: { next: null },
      });
    }),
  ];
}

const ALL_SOURCES = {
  product: ["x"],
  offering: ["x"],
  price: ["x"],
  feature: ["x"],
  entitlement: ["x"],
};

describe("Stigg catalog happy path", () => {
  it("yields objects in write order and links each association", async () => {
    server.use(...catalogHandlers());

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { pages, byObject } = await collect(stiggCatalogHandler, ctx);

    expect(pages.map((p) => p.object)).toEqual([
      "product",
      "offering",
      "price",
      "price",
      "feature",
      "entitlement",
      "entitlement",
    ]);

    expect(byObject.product.map((r) => r["id"])).toEqual(["prod-1"]);
    expect(byObject.offering.map((r) => r["id"])).toEqual([
      "plan-pro",
      "addon-seats",
    ]);
    // A price names the package it bills.
    expect(byObject.price.map((r) => r["offering_id"])).toEqual([
      "plan-pro",
      "addon-seats",
    ]);
    // The CREDIT entitlement is dropped; only FEATURE rows remain.
    expect(byObject.entitlement.map((r) => r["entitlement_id"])).toEqual([
      "plan-pro:api-calls",
      "addon-seats:seats",
    ]);

    // Every reference resolves against the ids that were yielded.
    const productIds = new Set(byObject.product.map((r) => r["id"]));
    for (const offering of byObject.offering) {
      expect(
        productIds.has(
          stiggCatalogHandler.externalRefsOf(offering, "offering").product,
        ),
      ).toBe(true);
    }

    const offeringIds = new Set(byObject.offering.map((r) => r["id"]));
    for (const price of byObject.price) {
      expect(
        offeringIds.has(
          stiggCatalogHandler.externalRefsOf(price, "price").offering,
        ),
      ).toBe(true);
    }

    const featureIds = new Set(byObject.feature.map((r) => r["id"]));
    for (const entitlement of byObject.entitlement) {
      const refs = stiggCatalogHandler.externalRefsOf(
        entitlement,
        "entitlement",
      );
      expect(offeringIds.has(refs.offering)).toBe(true);
      expect(featureIds.has(refs.feature)).toBe(true);
    }
  });
});

describe("Stigg catalog versioning", () => {
  it("collapses versions to the published package and fans out once", async () => {
    const counts: Record<string, number> = {};
    // The override is registered first, so msw matches it before the shared
    // plans handler below; the latter then never runs.
    server.use(
      http.get(PLANS, () => {
        counts["plans"] = (counts["plans"] ?? 0) + 1;
        return HttpResponse.json({
          data: [PLAN_PRO, { ...PLAN_PRO, status: "DRAFT", versionNumber: 2 }],
          pagination: { next: null },
        });
      }),
      ...catalogHandlers(counts),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { byObject } = await collect(stiggCatalogHandler, ctx);

    expect(byObject.offering).toHaveLength(2);
    const plan = byObject.offering.find((r) => r["id"] === "plan-pro");
    expect(plan?.["versionNumber"]).toBe(1);
    expect(plan?.["active"]).toBe(true);

    // The fan-out runs once per deduped id, not once per version.
    expect(counts["planCharges"]).toBe(1);
    expect(counts["planEntitlements"]).toBe(1);
  });

  it("drops draft and archived packages, with no fan-out for them", async () => {
    const counts: Record<string, number> = {};
    server.use(
      http.get(PLANS, () => {
        counts["plans"] = (counts["plans"] ?? 0) + 1;
        return HttpResponse.json({
          data: [
            { ...PLAN_PRO, status: "DRAFT" },
            {
              id: "plan-old",
              displayName: "Old",
              productId: "prod-1",
              status: "ARCHIVED",
            },
          ],
          pagination: { next: null },
        });
      }),
      http.get(ADDONS, () => {
        counts["addons"] = (counts["addons"] ?? 0) + 1;
        return HttpResponse.json({
          data: [{ ...ADDON_SEATS, status: "DRAFT" }],
          pagination: { next: null },
        });
      }),
      ...catalogHandlers(counts),
    );

    const { ctx } = testContext({
      sources: { price: ["x"], entitlement: ["x"] },
    });
    const { byObject } = await collect(stiggCatalogHandler, ctx);

    expect(byObject.offering).toEqual([]);
    // No package survived, so no charge or entitlement request was made. A
    // fan-out for a dropped id would hit a URL no handler serves, and
    // `onUnhandledRequest: "error"` would fail the test.
    expect(counts["planCharges"]).toBeUndefined();
    expect(counts["addonCharges"]).toBeUndefined();
    expect(counts["planEntitlements"]).toBeUndefined();
    expect(counts["addonEntitlements"]).toBeUndefined();
  });
});

describe("Stigg catalog pagination", () => {
  it("follows pagination.next via after and stops when it is null", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(PLAN_CHARGES, ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        seen.push(after);
        if (after === null) {
          return HttpResponse.json({
            data: [PLAN_CHARGE],
            pagination: { next: "cursor-2", prev: null },
          });
        }
        return HttpResponse.json({
          data: [{ ...PLAN_CHARGE, id: "chg-3" }],
          pagination: { next: null, prev: "cursor-1" },
        });
      }),
      ...catalogHandlers(),
    );

    const { ctx } = testContext({ sources: { price: ["x"] } });
    const { byObject } = await collect(stiggCatalogHandler, ctx);

    expect(seen).toEqual([null, "cursor-2"]);
    // Plans fan out before addons, so the addon's own charge follows.
    expect(byObject.price.map((r) => r["id"])).toEqual([
      "chg-1",
      "chg-3",
      "chg-2",
    ]);
  });

  it("stops rather than looping when the cursor echoes", async () => {
    let requests = 0;
    server.use(
      http.get(PLAN_CHARGES, ({ request }) => {
        requests += 1;
        const after = new URL(request.url).searchParams.get("after");
        return HttpResponse.json({
          data: [PLAN_CHARGE],
          pagination: { next: after ?? "cursor-1", prev: null },
        });
      }),
      ...catalogHandlers(),
    );

    const { ctx } = testContext({ sources: { price: ["x"] } });
    await collect(stiggCatalogHandler, ctx);

    expect(requests).toBe(2);
  });
});

describe("Stigg catalog fan-out gating", () => {
  it("makes only the spine requests when nothing is mapped", async () => {
    const counts: Record<string, number> = {};
    server.use(...catalogHandlers(counts));

    const { ctx } = testContext();
    await collect(stiggCatalogHandler, ctx);

    expect(counts).toEqual({ products: 1, plans: 1, addons: 1 });
  });

  it("fans out prices once per package, but not features or entitlements", async () => {
    const counts: Record<string, number> = {};
    server.use(...catalogHandlers(counts));

    const { ctx } = testContext({ sources: { price: ["x"] } });
    await collect(stiggCatalogHandler, ctx);

    expect(counts["planCharges"]).toBe(1);
    expect(counts["addonCharges"]).toBe(1);
    expect(counts["features"]).toBeUndefined();
    expect(counts["planEntitlements"]).toBeUndefined();
  });

  it("fans out entitlements without fetching features", async () => {
    const counts: Record<string, number> = {};
    server.use(...catalogHandlers(counts));

    const { ctx } = testContext({ sources: { entitlement: ["x"] } });
    await collect(stiggCatalogHandler, ctx);

    expect(counts["planEntitlements"]).toBe(1);
    expect(counts["addonEntitlements"]).toBe(1);
    // Independent endpoints: mapping only `entitlement` must not fetch features.
    expect(counts["features"]).toBeUndefined();
  });

  it("fetches features without fanning out charges", async () => {
    const counts: Record<string, number> = {};
    server.use(...catalogHandlers(counts));

    const { ctx } = testContext({ sources: { feature: ["x"] } });
    await collect(stiggCatalogHandler, ctx);

    expect(counts["features"]).toBe(1);
    expect(counts["planCharges"]).toBeUndefined();
  });
});

describe("Stigg catalog authentication", () => {
  it("treats a 401 as terminal and names the API key", async () => {
    server.use(http.get(PRODUCTS, () => new HttpResponse(null, { status: 401 })));

    await expect(
      collect(stiggCatalogHandler, testContext().ctx),
    ).rejects.toThrow(ReauthorizationRequiredError);
    await expect(
      collect(stiggCatalogHandler, testContext().ctx),
    ).rejects.toThrow(/API key/);
  });
});

describe("Stigg catalog field discovery", () => {
  it("surfaces product metadata keys alongside the fixed fields", async () => {
    server.use(
      http.get(PRODUCTS, () =>
        HttpResponse.json({
          data: [product({ arr_band: "growth", csm_owner: "r.okafor" })],
          pagination: { next: null },
        }),
      ),
    );

    const { ctx } = testContext();
    const fields = await stiggFieldDiscovery.discover(ctx, "product");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("displayName");
    expect(paths).toContain("metadata.arr_band");
    expect(paths).toContain("metadata.csm_owner");
  });

  it("describes price and entitlement statically, with no request", async () => {
    // No handlers registered: onUnhandledRequest is "error", so a request here
    // would fail the test. Both object shapes are known statically.
    const { ctx } = testContext();

    const pricePaths = (await stiggFieldDiscovery.discover(ctx, "price")).map(
      (f) => f.path,
    );
    expect(pricePaths).toContain("price_name");
    expect(pricePaths).toContain("offering_id");

    const entitlementPaths = (
      await stiggFieldDiscovery.discover(ctx, "entitlement")
    ).map((f) => f.path);
    expect(entitlementPaths).toContain("entitlement_id");
    expect(entitlementPaths).toContain("value");
  });

  it("returns an empty list for an object Stigg does not serve", async () => {
    const { ctx } = testContext();
    expect(await stiggFieldDiscovery.discover(ctx, "invoice")).toEqual([]);
  });
});
