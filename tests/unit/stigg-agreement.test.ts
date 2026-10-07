/**
 * Stigg agreement translation: the pure functions behind the handler.
 *
 * The handler's job is HTTP and pagination; everything here is the part that
 * decides what a Stigg subscription *means* — the status vocabulary, the
 * synthesized dates, the line and discount ids. Keeping it unit-tested means
 * the integration test can be about page order and cursors rather than about
 * seven status values.
 */

import { describe, expect, it } from "vitest";
import type { RawRecord } from "@/core/types/common";
import {
  agreementDisplayName,
  flattenAgreementDiscount,
  flattenAgreementItems,
  flattenSubscription,
  hasAddonsKey,
  hasCouponsKey,
  stiggAgreementStatus,
  stiggCollectionMethod,
  stiggDiscountExternalId,
  stiggItemExternalId,
  STIGG_SUBSCRIPTION_STATUSES,
  subscriptionCoupons,
  subscriptionCurrency,
  subscriptionsUrl,
} from "@/core/providers/stigg/api";
import { stiggAgreementHandler } from "@/core/providers/stigg/agreement-handler";

/** A minimal ACTIVE subscription, overridable per test. */
function subscription(overrides: RawRecord = {}): RawRecord {
  return {
    id: "sub-1",
    customerId: "cus-1",
    planId: "plan-pro",
    status: "ACTIVE",
    startDate: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("subscriptionsUrl", () => {
  it("carries the limit, the cursor and every status explicitly", () => {
    const url = new URL(subscriptionsUrl(50, "cursor-1"));

    expect(url.pathname).toBe("/api/v1/subscriptions");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("after")).toBe("cursor-1");
    // The load-bearing part: no reliance on an undocumented default, so a
    // canceled subscription cannot silently fail to arrive.
    expect(url.searchParams.get("status")).toBe(
      STIGG_SUBSCRIPTION_STATUSES.join(","),
    );
  });

  it("omits the cursor on the first page", () => {
    expect(new URL(subscriptionsUrl(20)).searchParams.get("after")).toBeNull();
  });
});

describe("stiggAgreementStatus", () => {
  it("maps all six statuses into our vocabulary", () => {
    const cases: Array<[string, string]> = [
      ["ACTIVE", "active"],
      ["IN_TRIAL", "trialing"],
      ["CANCELED", "canceled"],
      ["EXPIRED", "expired"],
      // Agreed but not begun, which `draft` cannot hold.
      ["NOT_STARTED", "scheduled"],
      // Provisioned but never paid for, which is Stripe's `incomplete`.
      ["PAYMENT_PENDING", "draft"],
    ];

    for (const [raw, ours] of cases) {
      expect(stiggAgreementStatus(subscription({ status: raw }))).toBe(ours);
    }
  });

  it("leaves an unknown or absent status unmapped", () => {
    expect(stiggAgreementStatus(subscription({ status: "WEIRD" }))).toBeUndefined();
    expect(stiggAgreementStatus({})).toBeUndefined();
  });
});

describe("stiggCollectionMethod", () => {
  it("translates the three methods, including none", () => {
    expect(stiggCollectionMethod(subscription({ paymentCollectionMethod: "CHARGE" }))).toBe("automatic");
    expect(stiggCollectionMethod(subscription({ paymentCollectionMethod: "INVOICE" }))).toBe("manual");
    // The value Stripe and Chargebee cannot express.
    expect(stiggCollectionMethod(subscription({ paymentCollectionMethod: "NONE" }))).toBe("none");
  });

  it("is undefined for an absent or unknown method", () => {
    expect(stiggCollectionMethod(subscription())).toBeUndefined();
    expect(stiggCollectionMethod(subscription({ paymentCollectionMethod: "WIRE" }))).toBeUndefined();
  });
});

describe("agreementDisplayName", () => {
  it("uses the plan, because Stigg gives a subscription no name", () => {
    expect(agreementDisplayName(subscription())).toBe("plan-pro");
  });

  it("appends the resource so two subscriptions on one plan differ", () => {
    expect(agreementDisplayName(subscription({ resourceId: "res-01" }))).toBe(
      "plan-pro · res-01",
    );
  });

  it("falls back to the subscription id past the 255-char column", () => {
    const planId = "p".repeat(250);
    const resourceId = "r".repeat(10);
    expect(agreementDisplayName(subscription({ planId, resourceId }))).toBe(
      "sub-1",
    );
  });

  it("falls back to the id when there is no plan", () => {
    expect(agreementDisplayName({ id: "sub-9" })).toBe("sub-9");
  });
});

describe("subscriptionCurrency", () => {
  it("reads the first price's currency", () => {
    expect(
      subscriptionCurrency(subscription({ prices: [{ amount: 10, currency: "usd" }] })),
    ).toBe("usd");
  });

  it("falls back to the minimum spend", () => {
    expect(
      subscriptionCurrency(subscription({ minimumSpend: { amount: 5, currency: "eur" } })),
    ).toBe("eur");
  });

  it("is undefined when Stigg states neither", () => {
    expect(subscriptionCurrency(subscription())).toBeUndefined();
  });
});

describe("flattenSubscription", () => {
  it("synthesizes the agreement and subscription fields of a healthy active subscription", () => {
    const flat = flattenSubscription(
      subscription({
        status: "ACTIVE",
        paymentCollectionMethod: "CHARGE",
        prices: [{ amount: 49, currency: "usd" }],
        currentBillingPeriodStart: "2024-06-01T00:00:00.000Z",
        currentBillingPeriodEnd: "2024-07-01T00:00:00.000Z",
        metadata: { tier: "gold" },
      }),
    );

    expect(flat["agreement_name"]).toBe("plan-pro");
    expect(flat["agreement_type"]).toBe("subscription");
    expect(flat["status"]).toBe("active");
    expect(flat["raw_status"]).toBe("ACTIVE");
    expect(flat["currency"]).toBe("usd");
    expect(flat["customer_id"]).toBe("cus-1");
    expect(flat["offering_id"]).toBe("plan-pro");
    expect(flat["item_count"]).toBe(1);
    expect(flat["collection_method"]).toBe("automatic");
    expect(flat["effective_date"]).toBe("2024-01-01T00:00:00.000Z");
    expect(flat["current_period_start"]).toBe("2024-06-01T00:00:00.000Z");
    expect(flat["current_period_end"]).toBe("2024-07-01T00:00:00.000Z");
    // Nothing is cancelling, so it renews at the period end.
    expect(flat["next_billing_at"]).toBe("2024-07-01T00:00:00.000Z");
    expect(flat["cancel_at_period_end"]).toBe(false);
    // No end, no cancellation and no trial.
    expect(flat["end_date"]).toBeUndefined();
    expect(flat["cancel_at"]).toBeUndefined();
    expect(flat["canceled_at"]).toBeUndefined();
    expect(flat["trial_ends_at"]).toBeUndefined();
    expect(flat["provider_metadata"]).toBe(JSON.stringify({ tier: "gold" }));
  });

  it("reads a scheduled cancellation as cancelling at period end", () => {
    const flat = flattenSubscription(
      subscription({
        status: "ACTIVE",
        cancellationDate: "2024-06-10T00:00:00.000Z",
        effectiveEndDate: "2024-07-01T00:00:00.000Z",
        currentBillingPeriodEnd: "2024-07-01T00:00:00.000Z",
      }),
    );

    expect(flat["cancel_at_period_end"]).toBe(true);
    expect(flat["canceled_at"]).toBe("2024-06-10T00:00:00.000Z");
    expect(flat["cancel_at"]).toBe("2024-07-01T00:00:00.000Z");
    // A cancelling subscription renews nothing, so there is no next billing.
    expect(flat["next_billing_at"]).toBeUndefined();
    // Still a live agreement, so no end date yet.
    expect(flat["end_date"]).toBeUndefined();
  });

  it("end-dates a canceled subscription from Stigg's own end date", () => {
    const flat = flattenSubscription(
      subscription({
        status: "CANCELED",
        endDate: "2024-07-05T00:00:00.000Z",
        effectiveEndDate: "2024-07-05T00:00:00.000Z",
        currentBillingPeriodEnd: "2024-07-01T00:00:00.000Z",
      }),
    );

    expect(flat["status"]).toBe("canceled");
    expect(flat["end_date"]).toBe("2024-07-05T00:00:00.000Z");
    expect(flat["cancel_at_period_end"]).toBe(false);
    expect(flat["next_billing_at"]).toBeUndefined();
  });

  it("falls back to the effective end date when Stigg states no end date", () => {
    const flat = flattenSubscription(
      subscription({
        status: "EXPIRED",
        effectiveEndDate: "2024-07-05T00:00:00.000Z",
      }),
    );

    expect(flat["end_date"]).toBe("2024-07-05T00:00:00.000Z");
  });

  it("keeps a trial's end and maps IN_TRIAL to trialing", () => {
    const flat = flattenSubscription(
      subscription({
        status: "IN_TRIAL",
        trialEndDate: "2024-02-01T00:00:00.000Z",
      }),
    );

    expect(flat["status"]).toBe("trialing");
    expect(flat["trial_ends_at"]).toBe("2024-02-01T00:00:00.000Z");
  });

  it("counts the plan and every addon", () => {
    const flat = flattenSubscription(
      subscription({
        addons: [
          { id: "addon-seats", quantity: 3 },
          { id: "addon-support", quantity: 1 },
        ],
      }),
    );

    expect(flat["item_count"]).toBe(3);
  });

  it("omits metadata rather than serializing an empty bag", () => {
    const flat = flattenSubscription(subscription());
    expect(flat["provider_metadata"]).toBeUndefined();
  });
});

describe("flattenAgreementItems", () => {
  it("emits the plan first, then one line per addon", () => {
    const sub = subscription({
      prices: [
        { amount: 49, currency: "usd", baseCharge: true },
        { amount: 5, currency: "usd", addonId: "addon-seats" },
      ],
      addons: [
        { id: "addon-seats", quantity: 3 },
        { id: "addon-support", quantity: 1 },
      ],
    });

    const items = flattenAgreementItems(sub, "sub-1");

    expect(items.map((item) => item["item_id"])).toEqual([
      "sub-1:plan",
      "sub-1:addon:addon-seats",
      "sub-1:addon:addon-support",
    ]);
    expect(items.map((item) => item["position"])).toEqual([0, 1, 2]);
    expect(items.map((item) => item["item_type"])).toEqual([
      "plan",
      "add_on",
      "add_on",
    ]);
    expect(items.map((item) => item["offering_id"])).toEqual([
      "plan-pro",
      "addon-seats",
      "addon-support",
    ]);

    // The plan's unit price is the base-charge override; the seats addon's is
    // its own override; the support addon has none.
    expect(items[0]?.["unit_price_minor"]).toBe(4900);
    expect(items[1]?.["unit_price_minor"]).toBe(500);
    expect(items[2]?.["unit_price_minor"]).toBeUndefined();
    // Quantity is stated per addon, never for the plan.
    expect(items[0]?.["quantity"]).toBeUndefined();
    expect(items[1]?.["quantity"]).toBe(3);
    expect(items[2]?.["quantity"]).toBe(1);
  });

  it("leaves the unit price null when localized overrides are ambiguous", () => {
    const sub = subscription({
      prices: [
        { amount: 49, currency: "usd", baseCharge: true },
        { amount: 55, currency: "eur", baseCharge: true },
      ],
    });

    const items = flattenAgreementItems(sub, "sub-1");
    expect(items).toHaveLength(1);
    expect(items[0]?.["unit_price_minor"]).toBeUndefined();
  });

  it("emits only the plan when there are no addons", () => {
    expect(flattenAgreementItems(subscription({ addons: [] }), "sub-1")).toHaveLength(1);
  });

  it("keeps an addon named plan distinct from the plan line", () => {
    const items = flattenAgreementItems(
      subscription({ addons: [{ id: "plan", quantity: 1 }] }),
      "sub-1",
    );

    expect(items.map((item) => item["item_id"])).toEqual([
      "sub-1:plan",
      "sub-1:addon:plan",
    ]);
  });

  it("drops an addon with no id rather than emitting a nameless line", () => {
    const items = flattenAgreementItems(
      subscription({ addons: [{ quantity: 2 }] }),
      "sub-1",
    );

    expect(items).toHaveLength(1);
  });
});

describe("stiggItemExternalId", () => {
  it("distinguishes the plan from an addon", () => {
    expect(stiggItemExternalId("sub-1")).toBe("sub-1:plan");
    expect(stiggItemExternalId("sub-1", "addon-seats")).toBe(
      "sub-1:addon:addon-seats",
    );
  });
});

describe("flattenAgreementDiscount", () => {
  it("reads a percentage coupon", () => {
    const flat = flattenAgreementDiscount(
      { id: "coup-1", name: "Launch", status: "ACTIVE", percentOff: 20 },
      "sub-1",
      "usd",
    );

    expect(flat?.["discount_id"]).toBe("sub-1:coupon:coup-1");
    expect(flat?.["agreement_id"]).toBe("sub-1");
    expect(flat?.["coupon_id"]).toBe("coup-1");
    expect(flat?.["coupon_name"]).toBe("Launch");
    expect(flat?.["discount_kind"]).toBe("percentage");
    expect(flat?.["discount_status"]).toBe("active");
    expect(flat?.["percent_off"]).toBe(20);
    expect(flat?.["amount_off_minor"]).toBeUndefined();
  });

  it("reads a fixed amount in the subscription's currency", () => {
    const flat = flattenAgreementDiscount(
      {
        id: "coup-2",
        name: "Credit",
        status: "EXPIRED",
        amountsOff: [
          { amount: 10, currency: "usd" },
          { amount: 9, currency: "eur" },
        ],
      },
      "sub-1",
      "usd",
    );

    expect(flat?.["discount_kind"]).toBe("fixed_amount");
    expect(flat?.["discount_status"]).toBe("expired");
    expect(flat?.["amount_off_minor"]).toBe(1000);
    // The raw array stays reachable for custom fields.
    expect(flat?.["amountsOff"]).toHaveLength(2);
  });

  it("uses the sole amount when no currency matches", () => {
    const flat = flattenAgreementDiscount(
      { id: "coup-3", name: "Solo", status: "ACTIVE", amountsOff: [{ amount: 5, currency: "gbp" }] },
      "sub-1",
      "usd",
    );

    expect(flat?.["amount_off_minor"]).toBe(500);
  });

  it("guesses no amount when several could apply and none matches", () => {
    const flat = flattenAgreementDiscount(
      {
        id: "coup-4",
        name: "Multi",
        status: "ACTIVE",
        amountsOff: [
          { amount: 5, currency: "gbp" },
          { amount: 6, currency: "eur" },
        ],
      },
      "sub-1",
      "usd",
    );

    expect(flat?.["amount_off_minor"]).toBeUndefined();
  });

  it("converts a zero-decimal currency without inflating it", () => {
    const flat = flattenAgreementDiscount(
      { id: "coup-5", name: "Yen", status: "ACTIVE", amountsOff: [{ amount: 500, currency: "jpy" }] },
      "sub-1",
      "jpy",
    );

    expect(flat?.["amount_off_minor"]).toBe(500);
  });

  it("maps REMOVED to removed", () => {
    const flat = flattenAgreementDiscount(
      { id: "coup-6", name: "Gone", status: "REMOVED", percentOff: 10 },
      "sub-1",
      "usd",
    );

    expect(flat?.["discount_status"]).toBe("removed");
  });

  it("yields nothing for a coupon with no id", () => {
    expect(
      flattenAgreementDiscount({ name: "Nameless" }, "sub-1", "usd"),
    ).toBeUndefined();
  });
});

describe("stiggDiscountExternalId", () => {
  it("namespaces the account-wide coupon id under the subscription", () => {
    expect(stiggDiscountExternalId("sub-1", "coup-1")).toBe(
      "sub-1:coupon:coup-1",
    );
  });
});

describe("key-presence helpers and coupon list", () => {
  it("distinguishes an absent addons key from an empty array", () => {
    expect(hasAddonsKey(subscription({ addons: [] }))).toBe(true);
    expect(hasAddonsKey(subscription())).toBe(false);
  });

  it("distinguishes an absent coupons key from an empty array", () => {
    expect(hasCouponsKey(subscription({ coupons: [] }))).toBe(true);
    expect(hasCouponsKey(subscription())).toBe(false);
  });

  it("tolerates a malformed coupon list", () => {
    expect(subscriptionCoupons(subscription({ coupons: [{ id: "c" }, "nope", 3] }))).toHaveLength(1);
    expect(subscriptionCoupons(subscription())).toEqual([]);
  });
});

describe("handler id and reference resolution", () => {
  it("keys a line and a discount by their synthesized ids first", () => {
    // The discount's raw `id` is the coupon's, account-wide — it must not win.
    expect(
      stiggAgreementHandler.externalIdOf({ discount_id: "d-1", id: "coup-1" }),
    ).toBe("d-1");
    expect(
      stiggAgreementHandler.externalIdOf({ item_id: "i-1", id: "coup-1" }),
    ).toBe("i-1");
    expect(stiggAgreementHandler.externalIdOf({ id: "sub-1" })).toBe("sub-1");
    expect(stiggAgreementHandler.externalIdOf({})).toBeUndefined();
  });

  it("resolves each object's parent references", () => {
    expect(
      stiggAgreementHandler.externalRefsOf(
        { customer_id: "cus-1", offering_id: "plan-pro" },
        "agreement",
      ),
    ).toEqual({ customer: "cus-1", offering: "plan-pro" });

    expect(
      stiggAgreementHandler.externalRefsOf({ id: "sub-1" }, "subscription"),
    ).toEqual({ agreement: "sub-1" });

    expect(
      stiggAgreementHandler.externalRefsOf(
        { agreement_id: "sub-1", offering_id: "addon-seats" },
        "agreementItem",
      ),
    ).toEqual({ agreement: "sub-1", offering: "addon-seats" });

    expect(
      stiggAgreementHandler.externalRefsOf(
        { agreement_id: "sub-1" },
        "agreementDiscount",
      ),
    ).toEqual({ agreement: "sub-1" });

    expect(stiggAgreementHandler.externalRefsOf({}, "invoice")).toEqual({});
  });
});
