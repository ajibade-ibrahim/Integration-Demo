import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  activeFromStatus,
  addonChargesUrl,
  addonEntitlementsUrl,
  bestCatalogVersion,
  flattenCharge,
  flattenEntitlement,
  flattenFeature,
  parseCustomersPage,
  parseStiggPage,
  planChargesUrl,
  planEntitlementsUrl,
  productsUrl,
  publishedOnly,
  stiggBillingModel,
  stiggEntitlementExternalId,
  stiggInterval,
} from "@/core/providers/stigg/api";
import { stiggCatalogHandler } from "@/core/providers/stigg/catalog-handler";
import { STIGG_PROVIDER_NAME } from "@/core/providers/stigg/provider";
import { functionNamesForProvider } from "@/core/registries/function-registry";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("Stigg catalog URLs", () => {
  it("applies limit, and echoes an opaque cursor only when there is one", () => {
    const first = productsUrl(25);
    expect(first).toContain("https://api.stigg.io/api/v1/products");
    expect(first).toContain("limit=25");
    expect(first).not.toContain("after=");

    expect(productsUrl(25, "cursor-abc")).toContain("after=cursor-abc");
  });

  it("encodes a package id used as a path segment", () => {
    // A path segment built from response data must not escape its segment.
    expect(planChargesUrl("a/../../x", 10)).toBe(
      "https://api.stigg.io/api/v1/plans/a%2F..%2F..%2Fx/charges?limit=10",
    );
    expect(addonChargesUrl("a/../../x", 10)).toContain(
      "/api/v1/addons/a%2F..%2F..%2Fx/charges",
    );
  });

  it("builds entitlement URLs with no limit or cursor", () => {
    // These endpoints document no pagination parameters, so applying either
    // would be a request the API does not understand.
    expect(planEntitlementsUrl("plan-pro")).toBe(
      "https://api.stigg.io/api/v1/plans/plan-pro/entitlements",
    );
    expect(addonEntitlementsUrl("addon-seats")).toBe(
      "https://api.stigg.io/api/v1/addons/addon-seats/entitlements",
    );
    expect(planEntitlementsUrl("plan-pro")).not.toContain("limit=");
  });
});

describe("Stigg catalog parsing", () => {
  it("parses the shared envelope and its next cursor", () => {
    const page = parseStiggPage({
      data: [{ id: "p1" }, { id: "p2" }],
      pagination: { next: "cursor-2", prev: null },
    });
    expect(page.records.map((r) => r["id"])).toEqual(["p1", "p2"]);
    expect(page.nextCursor).toBe("cursor-2");
    expect(parseStiggPage({ data: [] }).nextCursor).toBeUndefined();
  });

  it("keeps the customers alias working", () => {
    expect(parseCustomersPage({ data: [{ id: "p1" }] }).records).toHaveLength(1);
  });
});

describe("Stigg catalog synthesis", () => {
  it("derives active from status, writing nothing when status is absent", () => {
    expect(activeFromStatus({ status: "PUBLISHED" })).toEqual({ active: true });
    expect(activeFromStatus({ status: "ARCHIVED" })).toEqual({ active: false });
    expect(activeFromStatus({ status: "DRAFT" })).toEqual({ active: false });
    expect(activeFromStatus({})).toEqual({});
  });

  it("keeps only published packages", () => {
    expect(
      publishedOnly([
        { id: "a", status: "PUBLISHED" },
        { id: "b", status: "DRAFT" },
        { id: "c", status: "ARCHIVED" },
        { id: "d" },
      ]).map((r) => r["id"]),
    ).toEqual(["a"]);
  });

  it("keeps the published version over a newer draft", () => {
    const chosen = bestCatalogVersion([
      { id: "p1", status: "PUBLISHED", versionNumber: 1 },
      { id: "p1", status: "DRAFT", versionNumber: 2 },
    ]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.["versionNumber"]).toBe(1);
  });

  it("takes the highest version when nothing is published", () => {
    const chosen = bestCatalogVersion([
      { id: "p1", status: "DRAFT", versionNumber: 1 },
      { id: "p1", status: "DRAFT", versionNumber: 3 },
    ]);
    expect(chosen[0]?.["versionNumber"]).toBe(3);
  });

  it("breaks a version tie with isLatest", () => {
    const chosen = bestCatalogVersion([
      { id: "p1", status: "PUBLISHED", versionNumber: 2, isLatest: false },
      { id: "p1", status: "PUBLISHED", versionNumber: 2, isLatest: true },
    ]);
    expect(chosen[0]?.["isLatest"]).toBe(true);
  });

  it("keeps one record per id and drops records with no id", () => {
    const chosen = bestCatalogVersion([
      { id: "p1", versionNumber: 1 },
      { id: "p2", versionNumber: 1 },
      { versionNumber: 9 },
    ]);
    expect(chosen.map((r) => r["id"])).toEqual(["p1", "p2"]);
  });

  it("maps cadence and period onto our intervals", () => {
    expect(stiggInterval({ billingPeriod: "MONTHLY" })).toBe("month");
    expect(stiggInterval({ billingPeriod: "ANNUALLY" })).toBe("year");
    // Cadence wins: a one-off does not recur even if a period is present.
    expect(
      stiggInterval({ billingCadence: "ONE_OFF", billingPeriod: "MONTHLY" }),
    ).toBe("one_time");
    expect(stiggInterval({ billingPeriod: "WEEKLY" })).toBeUndefined();
    expect(stiggInterval({})).toBeUndefined();
  });

  it("maps Stigg's billing model onto the canonical vocabulary", () => {
    expect(stiggBillingModel({ billingModel: "FLAT_FEE" })).toBe("flat_fee");
    expect(stiggBillingModel({ billingModel: "PER_UNIT" })).toBe("per_unit");
    expect(stiggBillingModel({ billingModel: "USAGE_BASED" })).toBe(
      "usage_based",
    );
    expect(stiggBillingModel({ billingModel: "MINIMUM_SPEND" })).toBe(
      "minimum_spend",
    );
    expect(stiggBillingModel({ billingModel: "CREDIT_BASED" })).toBe(
      "credit_based",
    );
    // An unrecognised value is "not told", never a word we invented.
    expect(stiggBillingModel({ billingModel: "SOMETHING_ELSE" })).toBeUndefined();
    expect(stiggBillingModel({})).toBeUndefined();
  });

  it("names a flat charge from its amount and recurrence", () => {
    const flat = flattenCharge(
      {
        price: { amount: 49, currency: "USD" },
        billingPeriod: "MONTHLY",
        billingCadence: "RECURRING",
      },
      { id: "plan-pro", name: "Professional", kind: "plan", active: true },
    );

    // `priceLabel` renders whole dollars without cents and appends the
    // recurrence unspaced, which is what the Stripe catalog shows.
    expect(flat["price_name"]).toBe("Professional — $49/month");
    // Stigg states 49 (major units); the synthesized field is 4900 (minor).
    expect(flat["amount_minor"]).toBe(4900);
    expect(flat["offering_id"]).toBe("plan-pro");
    expect(flat["interval"]).toBe("month");
    expect(flat["interval_count"]).toBe(1);
    expect(flat["active"]).toBe(true);
  });

  it("keeps a zero-decimal currency's amount unchanged", () => {
    const flat = flattenCharge(
      { price: { amount: 4900, currency: "JPY" }, billingCadence: "RECURRING" },
      { id: "plan-pro", name: "Pro", kind: "plan" },
    );

    // JPY has no minor unit, so 4900 major is 4900 minor — not 490000.
    expect(flat["amount_minor"]).toBe(4900);
    expect(flat["price_name"]).toBe("Pro — ¥4,900");
  });

  it("names a price-less charge by its billing model and feature", () => {
    const flat = flattenCharge(
      {
        price: null,
        billingModel: "USAGE_BASED",
        billingCadence: "RECURRING",
        featureId: "api-calls",
      },
      { id: "plan-pro", name: "Pro", kind: "plan" },
    );

    expect(flat["price_name"]).toBe("Pro — usage-based · api-calls");
    expect(flat["billing_model"]).toBe("usage_based");
    // No amount fields are invented for a charge that states none.
    expect(flat).not.toHaveProperty("interval");
    expect(flat).not.toHaveProperty("active");
  });

  it("appends the country and resolves a one-off cadence", () => {
    const flat = flattenCharge(
      {
        price: { amount: 10, currency: "USD" },
        billingCadence: "ONE_OFF",
        billingCountryCode: "eu",
      },
      { id: "plan-pro", name: "Pro", kind: "plan" },
    );

    expect(flat["price_name"]).toBe("Pro — $10 (eu)");
    expect(flat["interval"]).toBe("one_time");
  });

  it("falls back to custom pricing when nothing is stated", () => {
    const flat = flattenCharge(
      { billingModel: "MINIMUM_SPEND" },
      { id: "plan-pro", name: "Pro", kind: "plan" },
    );
    expect(flat["price_name"]).toBe("Pro — minimum spend");
    expect(flat["billing_model"]).toBe("minimum_spend");
  });

  it("reads isMetered from the meter type only when it is present", () => {
    expect(flattenFeature({ meterType: "INCREMENTAL" })).toEqual({
      isMetered: true,
    });
    expect(flattenFeature({ meterType: "FLUCTUATING" })).toEqual({
      isMetered: true,
    });
    expect(flattenFeature({ meterType: "None" })).toEqual({ isMetered: false });
    expect(flattenFeature({})).toEqual({});
  });

  it("keys an entitlement on the package and feature pair", () => {
    expect(stiggEntitlementExternalId("plan-pro", "api-calls")).toBe(
      "plan-pro:api-calls",
    );
  });

  it("maps the entitlement value matrix", () => {
    const value = (entitlement: Record<string, unknown>) =>
      flattenEntitlement({ id: "api-calls", ...entitlement }, "plan-pro")?.[
        "value"
      ];

    expect(value({ isGranted: true, usageLimit: 50 })).toBe("50");
    expect(value({ isGranted: true, hasUnlimitedUsage: true })).toBe(
      "unlimited",
    );
    expect(value({ isGranted: false })).toBe("false");
    expect(value({ isGranted: true })).toBe("true");
  });

  it("drops an entitlement that names no feature", () => {
    expect(flattenEntitlement({ isGranted: true }, "plan-pro")).toBeUndefined();
  });
});

describe("Stigg catalog handler identity", () => {
  it("prefers the synthesized entitlement id", () => {
    expect(
      stiggCatalogHandler.externalIdOf({
        entitlement_id: "plan-pro:api-calls",
        id: "api-calls",
      }),
    ).toBe("plan-pro:api-calls");
    expect(stiggCatalogHandler.externalIdOf({ id: "plan-pro" })).toBe(
      "plan-pro",
    );
  });

  it("resolves each object's parent references", () => {
    expect(
      stiggCatalogHandler.externalRefsOf(
        { id: "off-1", productId: "prod-1" },
        "offering",
      ),
    ).toEqual({ product: "prod-1" });

    expect(
      stiggCatalogHandler.externalRefsOf(
        { id: "chg-1", offering_id: "off-1" },
        "price",
      ),
    ).toEqual({ offering: "off-1" });

    expect(
      stiggCatalogHandler.externalRefsOf({ id: "feat-1" }, "feature"),
    ).toEqual({});

    expect(
      stiggCatalogHandler.externalRefsOf(
        { entitlement_id: "off-1:feat-1", offering_id: "off-1", feature_id: "feat-1" },
        "entitlement",
      ),
    ).toEqual({ offering: "off-1", feature: "feat-1" });

    expect(
      stiggCatalogHandler.externalRefsOf({ id: "prod-1" }, "product"),
    ).toEqual({});
  });

  it("is registered for catalog and identity", () => {
    expect(functionNamesForProvider(STIGG_PROVIDER_NAME)).toEqual([
      "catalog",
      "identity",
    ]);
  });
});
