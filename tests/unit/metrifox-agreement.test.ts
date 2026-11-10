/**
 * Metrifox agreement helpers and handler contracts.
 *
 * The risky pieces here are all pure but load-bearing, and two are worth naming
 * because they are invisible in a happy-path sync:
 *
 *   - `limit_value`. The writer derives `limitValue` from `limitValue ?? value`,
 *     so an entitlement whose limit is not mapped silently turns the purchased
 *     quantity into a hard limit. These tests pin the sentinel that prevents it.
 *   - The synthetic ids. `AgreementItem` and `AgreementEntitlement` are unique
 *     on `(integrationId, externalSourceId)` and the payload has almost no ids,
 *     so an unstable key would duplicate rows rather than error.
 */

import { describe, expect, it } from "vitest";

import {
  customerDetailsUrl,
  flattenMetrifoxAgreementEntitlement,
  flattenMetrifoxSubscription,
  flattenMetrifoxSubscriptionItem,
  metrifoxAgreementItemId,
  metrifoxAgreementName,
  metrifoxAgreementStatus,
  metrifoxJson,
  parseCustomerDetails,
  parseEntitlementsSummary,
  subscriptionEntitlementsSummaryUrl,
} from "@/core/providers/metrifox/api";
import { metrifoxAgreementHandler } from "@/core/providers/metrifox/agreement-handler";

describe("Metrifox agreement status", () => {
  it("maps the documented words, both cancellation spellings and separators", () => {
    expect(metrifoxAgreementStatus("active")).toBe("active");
    expect(metrifoxAgreementStatus("trial")).toBe("trialing");
    expect(metrifoxAgreementStatus("trialing")).toBe("trialing");
    expect(metrifoxAgreementStatus("in trial")).toBe("trialing");
    expect(metrifoxAgreementStatus("paused")).toBe("paused");
    expect(metrifoxAgreementStatus("canceled")).toBe("canceled");
    // The webhook samples use one L; the docs use two. Both are accepted.
    expect(metrifoxAgreementStatus("cancelled")).toBe("canceled");
    expect(metrifoxAgreementStatus("expired")).toBe("expired");
  });

  it("translates the two judgement calls rather than inventing enum members", () => {
    // Docs: a payment could not be collected.
    expect(metrifoxAgreementStatus("delinquent")).toBe("past_due");
    // Docs: ended, typically after a cancellation took effect.
    expect(metrifoxAgreementStatus("deactivated")).toBe("canceled");
    // Docs: still in service.
    expect(metrifoxAgreementStatus("grace")).toBe("active");
    expect(metrifoxAgreementStatus("Grace Period")).toBe("active");
  });

  it("normalises case and hyphens", () => {
    expect(metrifoxAgreementStatus("ACTIVE")).toBe("active");
    expect(metrifoxAgreementStatus("IN-TRIAL")).toBe("trialing");
  });

  it("omits an unknown word rather than guessing", () => {
    expect(metrifoxAgreementStatus("teleported")).toBeUndefined();
    expect(metrifoxAgreementStatus("")).toBeUndefined();
    expect(metrifoxAgreementStatus(null)).toBeUndefined();
  });
});

describe("Metrifox agreement name", () => {
  it("prefers the plan name and falls back to the product name", () => {
    expect(
      metrifoxAgreementName({ plan_name: "  Growth  ", product_name: "Core" })
    ).toBe("Growth");
    expect(metrifoxAgreementName({ product_name: "Core" })).toBe("Core");
  });

  it("treats a blank plan name as absent", () => {
    expect(
      metrifoxAgreementName({ plan_name: "   ", product_name: "Core" })
    ).toBe("Core");
  });

  it("returns undefined when neither is stated, so the writer rejects visibly", () => {
    expect(metrifoxAgreementName({})).toBeUndefined();
    expect(metrifoxAgreementName({ plan_name: "", product_name: "  " })).toBeUndefined();
  });
});

describe("Metrifox URL builders", () => {
  it("percent-encodes the customer key as a path segment", () => {
    const url = customerDetailsUrl("ACME/001 test");
    expect(url).toContain("/api/v1/customers/ACME%2F001%20test/details");
  });

  it("percent-encodes the subscription id", () => {
    const url = subscriptionEntitlementsSummaryUrl("sub/1");
    expect(url).toContain("/api/v1/subscriptions/sub%2F1/v2/entitlements-summary");
  });
});

describe("parseCustomerDetails", () => {
  it("keeps the current subscription beside its history", () => {
    const parsed = parseCustomerDetails({
      data: {
        subscriptions: [
          {
            subscription: { id: "sub_current" },
            subscriptions_history: [{ id: "sub_old" }],
          },
        ],
      },
    });

    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups?.[0]?.current?.["id"]).toBe("sub_current");
    expect(parsed.groups?.[0]?.history.map((s) => s["id"])).toEqual(["sub_old"]);
  });

  it("degrades a missing current and missing history to empty", () => {
    const parsed = parseCustomerDetails({
      data: { subscriptions: [{ product_key: "core" }] },
    });

    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups?.[0]?.current).toBeUndefined();
    expect(parsed.groups?.[0]?.history).toEqual([]);
  });

  it("treats a missing data.subscriptions as an empty account", () => {
    expect(parseCustomerDetails({ data: {} }).groups).toEqual([]);
    expect(parseCustomerDetails({}).groups).toEqual([]);
  });

  it("reports a non-array data.subscriptions as malformed, not empty", () => {
    // The distinction the handler's all-unusable guard exists for: "we could
    // not read this customer" is not "this customer has no subscriptions".
    expect(parseCustomerDetails({ data: { subscriptions: null } }).groups).toBeUndefined();
    expect(parseCustomerDetails({ data: { subscriptions: {} } }).groups).toBeUndefined();
  });
});

describe("parseEntitlementsSummary", () => {
  it("returns the rows when data is an array", () => {
    expect(
      parseEntitlementsSummary({ data: [{ id: "e1" }, "junk"] })
    ).toEqual([{ id: "e1" }]);
  });

  it("returns undefined for a 200 whose data is not an array", () => {
    expect(parseEntitlementsSummary({ data: null })).toBeUndefined();
    expect(parseEntitlementsSummary({})).toBeUndefined();
    expect(parseEntitlementsSummary({ data: {} })).toBeUndefined();
  });
});

describe("flattenMetrifoxSubscription", () => {
  const subscription = {
    id: "sub_1",
    status: "Active",
    starts_at: "2025-01-01T00:00:00.000Z",
    ends_at: "2026-01-01T00:00:00.000Z",
    cancelled_at: null,
    renews_at: "2025-12-01T00:00:00.000Z",
    trial_end_date: "2025-01-15T00:00:00.000Z",
    plan_name: "Growth",
    plan_version: 3,
    product_name: "Core",
    product_key: "core",
    offering_key: "off_growth",
    currency_code: "USD",
    current_billing_period_start: "2025-11-01T00:00:00.000Z",
    current_billing_period_end: "2025-12-01T00:00:00.000Z",
    next_billing_amount: 99.5,
    next_billing_date: "2025-12-01T00:00:00.000Z",
    subscription_items: [{ price_option_id: "po_1" }, { price_option_id: "po_2" }],
  };

  it("carries the stated dates and the translated status", () => {
    const flat = flattenMetrifoxSubscription(subscription, "cust_1");

    expect(flat["agreement_name"]).toBe("Growth");
    expect(flat["agreement_type"]).toBe("subscription");
    expect(flat["status"]).toBe("active");
    expect(flat["raw_status"]).toBe("Active");
    expect(flat["effective_date"]).toBe(subscription.starts_at);
    expect(flat["end_date"]).toBe(subscription.ends_at);
    expect(flat["current_period_start"]).toBe(
      subscription.current_billing_period_start
    );
    expect(flat["current_period_end"]).toBe(
      subscription.current_billing_period_end
    );
    expect(flat["next_billing_at"]).toBe(subscription.renews_at);
    expect(flat["trial_ends_at"]).toBe(subscription.trial_end_date);
    expect(flat["canceled_at"]).toBeUndefined();
  });

  it("uses the customers-list id for the association", () => {
    // The handler spreads the raw record first, so raw fields like
    // `offering_key` survive alongside the synthesized ones.
    const flat: Record<string, unknown> = {
      ...subscription,
      ...flattenMetrifoxSubscription(subscription, "cust_list_id"),
    };
    expect(flat["customer_id"]).toBe("cust_list_id");
    expect(
      metrifoxAgreementHandler.externalRefsOf(flat, "agreement")
    ).toEqual({ customer: "cust_list_id", offering: "off_growth" });
  });

  it("counts items only when the item list is an array", () => {
    expect(flattenMetrifoxSubscription(subscription, "c")["item_count"]).toBe(2);

    const absent = { ...subscription } as Record<string, unknown>;
    delete absent["subscription_items"];
    expect(flattenMetrifoxSubscription(absent, "c")["item_count"]).toBeUndefined();

    expect(
      flattenMetrifoxSubscription(
        { ...subscription, subscription_items: { nope: true } },
        "c"
      )["item_count"]
    ).toBeUndefined();
  });

  it("does not state fields the payload does not carry", () => {
    const flat = flattenMetrifoxSubscription(subscription, "c");
    expect(flat).not.toHaveProperty("billing_period");
    expect(flat).not.toHaveProperty("billing_period_count");
    expect(flat).not.toHaveProperty("collection_method");
    expect(flat).not.toHaveProperty("quantity");
    expect(flat).not.toHaveProperty("cancel_at");
    expect(flat).not.toHaveProperty("cancel_at_period_end");
    expect(flat).not.toHaveProperty("trial_starts_at");
  });

  it("keeps a curated provider bag and drops absent facts", () => {
    const flat = flattenMetrifoxSubscription(subscription, "c");
    expect(JSON.parse(String(flat["provider_metadata"]))).toEqual({
      product_key: "core",
      product_name: "Core",
      plan_name: "Growth",
      plan_version: 3,
      offering_key: "off_growth",
      next_billing_amount: 99.5,
      next_billing_date: "2025-12-01T00:00:00.000Z",
      raw_status: "Active",
    });

    const bare = flattenMetrifoxSubscription({ id: "s" }, "c");
    expect(bare["provider_metadata"]).toBeUndefined();
  });
});

describe("flattenMetrifoxSubscriptionItem", () => {
  it("types a plan line, injects its price and the subscription's offering", () => {
    const flat = flattenMetrifoxSubscriptionItem(
      {
        price_option_id: "po_1",
        source_type: "ProductCatalogues::Offerings::Plan",
        name: "Growth",
        quantity: 1,
        unit_price: 99.5,
        total_amount: 99.5,
        is_addon: false,
      },
      "sub_1",
      "off_growth",
      0
    );

    expect(flat["item_id"]).toBe("sub_1:po_1");
    expect(flat["agreement_id"]).toBe("sub_1");
    expect(flat["price_id"]).toBe("po_1");
    expect(flat["offering_id"]).toBe("off_growth");
    expect(flat["item_type"]).toBe("plan");
    expect(flat["position"]).toBe(0);
    // Standard units are kept in the provider bag, never in the minor-unit column.
    expect(flat["unit_price_minor"]).toBeUndefined();
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      unit_price: 99.5,
      total_amount: 99.5,
    });

    expect(
      metrifoxAgreementHandler.externalRefsOf(flat, "agreementItem")
    ).toEqual({ agreement: "sub_1", offering: "off_growth", price: "po_1" });
  });

  it("types an add-on and does not borrow the plan's offering", () => {
    const flat = flattenMetrifoxSubscriptionItem(
      { price_option_id: "po_2", is_addon: true },
      "sub_1",
      "off_growth",
      1
    );

    expect(flat["item_type"]).toBe("add_on");
    expect(flat["offering_id"]).toBeUndefined();
  });

  it("leaves an unrecognised line type null", () => {
    const flat = flattenMetrifoxSubscriptionItem(
      { price_option_id: "po_3", source_type: "ProductCatalogues::Entitlements::PaidEntitlement" },
      "sub_1",
      "off_growth",
      2
    );
    expect(flat["item_type"]).toBeUndefined();
  });

  it("falls back to the position when the price option is blank", () => {
    expect(metrifoxAgreementItemId("sub_1", "  ", 4)).toBe("sub_1:pos4");
    expect(
      flattenMetrifoxSubscriptionItem({ price_option_id: "" }, "sub_1", undefined, 4)["item_id"]
    ).toBe("sub_1:pos4");
  });

  it("keys a line by its synthetic id before any raw id", () => {
    expect(
      metrifoxAgreementHandler.externalIdOf({ item_id: "sub_1:po_1", id: "wrong" })
    ).toBe("sub_1:po_1");
  });
});

describe("flattenMetrifoxAgreementEntitlement", () => {
  const row = {
    id: "row_1",
    feature_key: "seats",
    feature_name: "Seats",
    active: true,
    purchased_qty: 3,
    included_allowance: 1,
    usage_limit: null,
    usage_model: "per_unit",
    price_type: "recurring",
    feature_type: "quantity",
    soft_limit_enabled: false,
    aggregation_method: "sum",
    carryover_enabled: true,
    billing_interval: "month",
    billing_interval_value: 1,
  };

  it("reports the purchased quantity as the value", () => {
    const flat = flattenMetrifoxAgreementEntitlement(row, "sub_1", 0);
    expect(flat["value"]).toBe("3");
    expect(flat["is_enabled"]).toBe(true);
    expect(flat["feature_id"]).toBe("seats");
    expect(flat["agreement_id"]).toBe("sub_1");
  });

  it("sends the unlimited sentinel rather than the purchased quantity as a limit", () => {
    // The guard the whole `limit_value` injection exists for. The writer would
    // otherwise fall back to `value` and store 3 as a hard limit.
    const flat = flattenMetrifoxAgreementEntitlement(row, "sub_1", 0);
    expect(flat["limit_value"]).toBe("unlimited");
    expect(flat["limit_value"]).not.toBe("3");
  });

  it("passes a stated limit through, numeric", () => {
    const flat = flattenMetrifoxAgreementEntitlement(
      { ...row, usage_limit: 10 },
      "sub_1",
      0
    );
    expect(flat["limit_value"]).toBe("10");
  });

  it("keeps the rest of the summary in a curated provider bag", () => {
    const flat = flattenMetrifoxAgreementEntitlement(row, "sub_1", 0);
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      included_allowance: 1,
      usage_model: "per_unit",
      billing_interval: "month",
      billing_interval_value: 1,
      price_type: "recurring",
      feature_type: "quantity",
      soft_limit_enabled: false,
      aggregation_method: "sum",
      carryover_enabled: true,
    });
  });

  it("keys by the summary row id, and synthesizes only when it is absent", () => {
    expect(flattenMetrifoxAgreementEntitlement(row, "sub_1", 0)).not.toHaveProperty(
      "entitlement_row_id"
    );

    const fallback = flattenMetrifoxAgreementEntitlement(
      { ...row, id: undefined },
      "sub_1",
      0
    );
    expect(fallback["entitlement_row_id"]).toBe("sub_1:seats");

    const positional = flattenMetrifoxAgreementEntitlement(
      { ...row, id: undefined, feature_key: undefined },
      "sub_1",
      2
    );
    expect(positional["entitlement_row_id"]).toBe("sub_1:pos2");
  });

  it("never keys an entitlement by the feature-definition id", () => {
    // `entitlement_id` repeats across subscriptions, so it must never be the
    // upsert key.
    expect(
      metrifoxAgreementHandler.externalIdOf({ id: "row_1", entitlement_id: "feat_1" })
    ).toBe("row_1");
    expect(
      metrifoxAgreementHandler.externalIdOf({ entitlement_id: "feat_1" })
    ).toBeUndefined();

    const flat = flattenMetrifoxAgreementEntitlement(row, "sub_1", 0);
    expect(
      metrifoxAgreementHandler.externalRefsOf(flat, "agreementEntitlement")
    ).toEqual({ agreement: "sub_1", feature: "seats" });
  });
});

describe("metrifoxJson", () => {
  it("drops undefined entries and returns undefined for an empty bag", () => {
    expect(metrifoxJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(metrifoxJson({ a: undefined })).toBeUndefined();
    expect(metrifoxJson({})).toBeUndefined();
  });
});
