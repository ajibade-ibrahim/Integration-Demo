/**
 * Chargebee's agreement function: URL building, envelope parsing, and the
 * translations the handler performs before the mapper ever sees a record.
 *
 * The flattener tests matter more than they look. Every one of these values is
 * a provider word being turned into ours at the only place that is allowed to
 * do it — a `FieldTransform` cannot remap an enum — so a regression here puts
 * Chargebee's vocabulary straight into a column the writer will then reject.
 */

import { describe, expect, it } from "vitest";

import {
  chargebeeAgreementNameOf,
  chargebeeAgreementStatusOf,
  chargebeeBillingPeriodOf,
  chargebeeCollectionMethodOf,
  chargebeeItemTypeOf,
  flattenChargebeeDiscount,
  flattenChargebeeSubscription,
  flattenChargebeeSubscriptionEntitlement,
  flattenChargebeeSubscriptionItem,
  hasDiscountsKey,
  hasSubscriptionItemsKey,
  parseSubscriptionEntitlementsPage,
  parseSubscriptionsPage,
  subscriptionEntitlementsUrl,
  subscriptionItems,
  subscriptionsUrl,
} from "@/core/providers/chargebee/api";
import {
  CHARGEBEE_FIXTURE_SUBSCRIPTION_1,
  CHARGEBEE_FIXTURE_SUBSCRIPTION_2,
  CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1,
  CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1,
} from "@/core/providers/chargebee/fixtures";
import { chargebeeAgreementHandler } from "@/core/providers/chargebee/agreement-handler";
import { billingModelOf, collectionMethodOf } from "@/core/providers/stripe/api";

const SITE = "acme-test";

describe("Chargebee agreement URLs", () => {
  it("builds the subscriptions URL, asking for discounts inline", () => {
    // `include_discounts` is not optional garnish: without it Chargebee omits
    // the `discounts` key, the handler reads that as "not told" and the discount
    // pass can never declare completeness.
    expect(subscriptionsUrl(SITE, 25)).toBe(
      "https://acme-test.chargebee.com/api/v2/subscriptions?limit=25&include_discounts=true"
    );
    expect(subscriptionsUrl(SITE, 25, "off_1")).toBe(
      "https://acme-test.chargebee.com/api/v2/subscriptions?limit=25&include_discounts=true&next_offset=off_1"
    );
  });

  it("builds the entitlement URL, encoding the subscription id", () => {
    expect(subscriptionEntitlementsUrl(SITE, "cb_sub_1", 10)).toBe(
      "https://acme-test.chargebee.com/api/v2/subscriptions/cb_sub_1/subscription_entitlements?limit=10"
    );
    // A path segment built from response data must not be able to escape it.
    expect(subscriptionEntitlementsUrl(SITE, "a/../../customers", 10)).toBe(
      "https://acme-test.chargebee.com/api/v2/subscriptions/a%2F..%2F..%2Fcustomers/subscription_entitlements?limit=10"
    );
  });
});

describe("Chargebee agreement parsing", () => {
  it("unwraps the nested subscription envelope", () => {
    const page = parseSubscriptionsPage(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1);
    expect(page.records.map((r) => r["id"])).toEqual([
      "cb_sub_acme",
      "cb_sub_globex",
    ]);
    expect(page.nextOffset).toBeUndefined();
  });

  it("unwraps the nested subscription_entitlement envelope", () => {
    const page = parseSubscriptionEntitlementsPage(
      CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1
    );
    expect(page.records.map((r) => r["feature_id"])).toEqual([
      "cb_feat_dashboards",
      "cb_feat_advanced_reports",
    ]);
  });
});

describe("Chargebee status translation", () => {
  it("maps every stated status, including the two that fold in", () => {
    expect(chargebeeAgreementStatusOf({ status: "future" })).toBe("scheduled");
    expect(chargebeeAgreementStatusOf({ status: "in_trial" })).toBe("trialing");
    expect(chargebeeAgreementStatusOf({ status: "active" })).toBe("active");
    // Cancels at term end, but still in force — a flag, not a lifecycle state.
    expect(chargebeeAgreementStatusOf({ status: "non_renewing" })).toBe("active");
    expect(chargebeeAgreementStatusOf({ status: "paused" })).toBe("paused");
    expect(chargebeeAgreementStatusOf({ status: "cancelled" })).toBe("canceled");
    // Business-entity bookkeeping, not lifecycle.
    expect(chargebeeAgreementStatusOf({ status: "transferred" })).toBe("active");
  });

  it("returns undefined for a word we do not know", () => {
    // Undefined, not a guess: the writer warns and leaves the column null.
    expect(chargebeeAgreementStatusOf({ status: "hibernating" })).toBeUndefined();
    expect(chargebeeAgreementStatusOf({})).toBeUndefined();
  });
});

describe("Chargebee collection method and cadence", () => {
  it("translates auto_collection on/off", () => {
    expect(chargebeeCollectionMethodOf({ auto_collection: "on" })).toBe(
      "automatic"
    );
    expect(chargebeeCollectionMethodOf({ auto_collection: "off" })).toBe(
      "manual"
    );
    expect(chargebeeCollectionMethodOf({})).toBeUndefined();
  });

  it("reads the billing period unit only when it is one of ours", () => {
    expect(chargebeeBillingPeriodOf({ billing_period_unit: "month" })).toBe(
      "month"
    );
    expect(chargebeeBillingPeriodOf({ billing_period_unit: "MONTH" })).toBe(
      "month"
    );
    expect(
      chargebeeBillingPeriodOf({ billing_period_unit: "fortnight" })
    ).toBeUndefined();
  });
});

describe("Chargebee name synthesis", () => {
  it("uses the plan line's item price id", () => {
    expect(chargebeeAgreementNameOf(CHARGEBEE_FIXTURE_SUBSCRIPTION_1)).toBe(
      "cb_price_analytics_pro_monthly"
    );
  });

  it("falls back to the subscription id when no line is a plan", () => {
    // A nicer label needs the item price object, which this payload omits; the
    // id keeps the required name non-empty rather than rejecting the record.
    const noPlan = {
      id: "cb_sub_odd",
      subscription_items: [{ item_price_id: "x", item_type: "addon" }],
    };
    expect(chargebeeAgreementNameOf(noPlan)).toBe("cb_sub_odd");
  });
});

describe("Chargebee line translation", () => {
  it("translates the three item types", () => {
    expect(chargebeeItemTypeOf({ item_type: "plan" })).toBe("plan");
    expect(chargebeeItemTypeOf({ item_type: "addon" })).toBe("add_on");
    expect(chargebeeItemTypeOf({ item_type: "charge" })).toBe("charge");
    expect(chargebeeItemTypeOf({ item_type: "mystery" })).toBeUndefined();
  });

  it("injects the agreement and the position, and reads the raw price id", () => {
    const items = subscriptionItems(CHARGEBEE_FIXTURE_SUBSCRIPTION_1);
    const flat = flattenChargebeeSubscriptionItem(items[0]!, "cb_sub_acme", 0);

    expect(flat["agreement_id"]).toBe("cb_sub_acme");
    expect(flat["price_id"]).toBe("cb_price_analytics_pro_monthly");
    expect(flat["position"]).toBe(0);
    expect(flat["item_type"]).toBe("plan");
  });

  it("does not synthesize a billing model, because the payload omits pricing_model", () => {
    const items = subscriptionItems(CHARGEBEE_FIXTURE_SUBSCRIPTION_1);
    const flat = flattenChargebeeSubscriptionItem(items[0]!, "cb_sub_acme", 0);
    expect(flat).not.toHaveProperty("billing_model");
  });
});

describe("Chargebee entitlement flattening", () => {
  it("keys a subscription entitlement as subscription:feature", () => {
    // The payload carries no id at all, so this is the upsert key.
    const record = {
      ...flattenChargebeeSubscriptionEntitlement("cb_sub_acme"),
      feature_id: "cb_feat_dashboards",
    };
    expect(chargebeeAgreementHandler.externalIdOf(record)).toBe(
      "cb_sub_acme:cb_feat_dashboards"
    );
    expect(
      chargebeeAgreementHandler.externalRefsOf(record, "agreementEntitlement")
    ).toEqual({
      agreement: "cb_sub_acme",
      feature: "cb_feat_dashboards",
    });
  });

  it("ignores the payload's own subscription_id in favour of the injected one", () => {
    const record = {
      subscription_id: "cb_sub_lie",
      ...flattenChargebeeSubscriptionEntitlement("cb_sub_acme"),
      feature_id: "cb_feat_dashboards",
    };
    expect(
      chargebeeAgreementHandler.externalRefsOf(record, "agreementEntitlement")
        .agreement
    ).toBe("cb_sub_acme");
  });
});

describe("Chargebee discount flattening", () => {
  it("translates kind and derives the status", () => {
    const flat = flattenChargebeeDiscount(
      {
        id: "cb_disc_1",
        coupon_id: "cb_coupon_launch",
        invoice_name: "Launch 10% off",
        type: "percentage",
        percentage: 10,
        duration_type: "forever",
        created_at: 1672531200,
      },
      "cb_sub_acme"
    );

    expect(flat["discount_id"]).toBe("cb_disc_1");
    expect(flat["discount_kind"]).toBe("percentage");
    // A listed discount is attached by definition, so status is active.
    expect(flat["discount_status"]).toBe("active");
    expect(flat["starts_at"]).toBe("2023-01-01T00:00:00.000Z");
    expect(flat).not.toHaveProperty("ends_at");
  });

  it("maps offer_quantity to free_items", () => {
    const flat = flattenChargebeeDiscount({ id: "d", type: "offer_quantity" }, "s");
    expect(flat["discount_kind"]).toBe("free_items");
    expect(flat["discount_status"]).toBeUndefined();
  });
});

describe("Chargebee subscription flattening", () => {
  it("synthesizes the dates, cadence and metadata", () => {
    const flat = flattenChargebeeSubscription(CHARGEBEE_FIXTURE_SUBSCRIPTION_1);

    expect(flat["agreement_name"]).toBe("cb_price_analytics_pro_monthly");
    expect(flat["agreement_type"]).toBe("subscription");
    expect(flat["status"]).toBe("active");
    expect(flat["chargebee_status"]).toBe("active");
    expect(flat["collection_method"]).toBe("automatic");
    expect(flat["billing_period"]).toBe("month");
    expect(flat["billing_period_count"]).toBe(1);
    expect(flat["item_count"]).toBe(2);
    expect(flat["effective_date"]).toBe("2023-01-01T00:00:00.000Z");
    expect(flat["current_period_end"]).toBe("2023-02-01T00:00:00.000Z");
    expect(flat["next_billing_at"]).toBe("2023-02-01T00:00:00.000Z");
    expect(flat["provider_metadata"]).toBe(JSON.stringify({ po: "PO-42" }));
    // Not cancelled, so there is no end date.
    expect(flat).not.toHaveProperty("ended_at");
  });

  it("flags a non-renewing subscription but gives it no end date", () => {
    const flat = flattenChargebeeSubscription(CHARGEBEE_FIXTURE_SUBSCRIPTION_2);
    expect(flat["status"]).toBe("active");
    expect(flat["cancel_at_period_end"]).toBe("true");
    // `non_renewing` is still in force, so there is no end yet even though the
    // payload carries a `cancelled_at` — only a cancelled record gets one.
    expect(flat).not.toHaveProperty("ended_at");
  });

  it("dates the end only for a cancelled subscription", () => {
    const flat = flattenChargebeeSubscription({
      id: "cb_sub_gone",
      status: "cancelled",
      cancelled_at: 1677888000,
    });
    expect(flat["ended_at"]).toBe(new Date(1677888000 * 1000).toISOString());
    expect(flat["status"]).toBe("canceled");
  });

  it("merges handler metadata over the payload's meta_data", () => {
    const flat = flattenChargebeeSubscription(
      CHARGEBEE_FIXTURE_SUBSCRIPTION_1,
      { entitlements: "site_feature_disabled" }
    );
    expect(JSON.parse(String(flat["provider_metadata"]))).toEqual({
      po: "PO-42",
      entitlements: "site_feature_disabled",
    });
  });
});

describe("Chargebee key-presence gates", () => {
  it("distinguishes an absent key from an empty array", () => {
    expect(hasSubscriptionItemsKey(CHARGEBEE_FIXTURE_SUBSCRIPTION_1)).toBe(true);
    expect(hasSubscriptionItemsKey({ id: "x" })).toBe(false);
    expect(hasDiscountsKey(CHARGEBEE_FIXTURE_SUBSCRIPTION_2)).toBe(true);
    expect(hasDiscountsKey({ id: "x" })).toBe(false);
  });
});

describe("Stripe agreement translations", () => {
  it("translates collection_method rather than storing Stripe's word", () => {
    expect(collectionMethodOf({ collection_method: "charge_automatically" })).toBe(
      "automatic"
    );
    expect(collectionMethodOf({ collection_method: "send_invoice" })).toBe(
      "manual"
    );
    expect(collectionMethodOf({})).toBeUndefined();
  });

  it("derives a billing model from the price", () => {
    expect(
      billingModelOf({ price: { type: "recurring", recurring: { usage_type: "metered" } } })
    ).toBe("usage_based");
    expect(billingModelOf({ price: { type: "one_time" } })).toBe("one_time");
    expect(
      billingModelOf({ price: { type: "recurring", billing_scheme: "tiered" } })
    ).toBe("tiered");
    expect(
      billingModelOf({ price: { type: "recurring", billing_scheme: "per_unit" } })
    ).toBe("per_unit");
    // Stripe has no spelling for flat_fee, so an unknown scheme stays unset.
    expect(billingModelOf({ price: {} })).toBeUndefined();
  });
});
