/**
 * Stripe's agreement synthesis — the fields the handler invents because the raw
 * subscription cannot survive the trip through the mapper.
 *
 * `agreementDisplayName` carries the same risk `offeringDisplayName` does, one
 * object over and worse. `Agreement.name` is required and the record writer
 * rejects a record without one, while a Stripe subscription has **no name field
 * at all** — not an empty one, none. So if this function ever returns an empty
 * string, every subscription in the account is rejected on every sync, forever,
 * with a `partial` run status as the only evidence.
 *
 * The status map is the other half. Stripe has eight statuses and we have
 * seven, the collapses are lossy on purpose, and getting one wrong means
 * reporting revenue or churn that did not happen.
 */

import { describe, expect, it } from "vitest";
import {
  agreementDisplayName,
  agreementStatusOf,
  flattenSubscription,
  listUrl,
  offeringDisplayName,
  subscriptionCustomerId,
  subscriptionOfferingId,
} from "@/core/providers/stripe/api";
import { stripeAgreementHandler } from "@/core/providers/stripe/agreement-handler";

const PRICE = {
  id: "price_monthly",
  object: "price",
  product: "prod_widget",
  currency: "usd",
  unit_amount: 4900,
  nickname: null,
  recurring: { interval: "month", interval_count: 1 },
};

function subscription(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    start_date: 1_680_893_993,
    current_period_start: 1_699_000_000,
    current_period_end: 1_701_678_400,
    items: {
      object: "list",
      data: [{ id: "si_1", price: PRICE, quantity: 1 }],
    },
    ...overrides,
  };
}

/** A subscription with no items at all — the shape every fallback must survive. */
function bare(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return subscription({ items: { object: "list", data: [] }, ...overrides });
}

describe("agreementStatusOf", () => {
  it("passes through the statuses that mean the same thing in both vocabularies", () => {
    for (const status of ["trialing", "active", "past_due", "paused", "canceled"]) {
      expect(agreementStatusOf(subscription({ status }))).toBe(status);
    }
  });

  it("folds unpaid into past_due", () => {
    // Both mean "owes money and is still on the books". Stripe separates them
    // by how long that has been true and what dunning did about it, which is a
    // billing-workflow detail rather than a fact about the agreement.
    expect(agreementStatusOf(subscription({ status: "unpaid" }))).toBe(
      "past_due"
    );
  });

  it("treats both incomplete states as draft, not as active or canceled", () => {
    // A subscription whose first payment never completed was never agreed to.
    // Calling it active would put revenue in the total that nobody committed
    // to; calling it canceled would count a churn with nothing to churn from.
    expect(agreementStatusOf(subscription({ status: "incomplete" }))).toBe(
      "draft"
    );
    expect(
      agreementStatusOf(subscription({ status: "incomplete_expired" }))
    ).toBe("draft");
  });

  it("returns undefined for a status it does not know, rather than guessing", () => {
    // A status added in a future Stripe API version must read as "we do not
    // know" and leave the column unset. Mapping it to whichever of ours sorts
    // first would be silently wrong in reports.
    expect(agreementStatusOf(subscription({ status: "renegotiating" }))).toBeUndefined();
    expect(agreementStatusOf(subscription({ status: null }))).toBeUndefined();
    expect(agreementStatusOf({})).toBeUndefined();
  });
});

describe("agreementDisplayName", () => {
  it("prefers the nickname the merchant set on the price", () => {
    expect(
      agreementDisplayName(
        subscription({
          items: {
            object: "list",
            data: [{ id: "si_1", price: { ...PRICE, nickname: "Team annual" } }],
          },
        })
      )
    ).toBe("Team annual");
  });

  it("ignores a blank nickname rather than returning it", () => {
    // A whitespace nickname would pass a truthiness check and then be trimmed
    // to nothing by the record writer, which rejects the record for a missing
    // name — the exact failure this function exists to prevent.
    expect(
      agreementDisplayName(
        subscription({
          items: {
            object: "list",
            data: [{ id: "si_1", price: { ...PRICE, nickname: "   " } }],
          },
        })
      )
    ).toBe("$49/month");
  });

  it("builds a name from the price nested inside the item", () => {
    // The price is expanded inside subscription items by default, which is what
    // makes this possible without a second request per subscription.
    expect(agreementDisplayName(subscription())).toBe("$49/month");
  });

  it("falls back to the subscription id when there is no price to read", () => {
    expect(agreementDisplayName(bare())).toBe("sub_1");
  });

  it("never returns a blank string for any shape tried here", () => {
    // The guarantee the record writer depends on. Whatever Stripe sends, this
    // returns something non-blank — otherwise the row is rejected.
    const shapes: Array<Record<string, unknown>> = [
      {},
      { id: "" },
      { items: null },
      { items: { data: null } },
      { items: { data: [{}] } },
      { items: { data: [{ price: {} }] } },
      { items: { data: [{ price: { unit_amount: 4900 } }] } },
      { items: { data: [{ price: { currency: "usd" } }] } },
      { items: { data: [{ price: { unit_amount: 4900, currency: "zzz" } }] } },
      subscription(),
      bare(),
    ];

    for (const shape of shapes) {
      const name = agreementDisplayName(shape);
      expect(typeof name, JSON.stringify(shape)).toBe("string");
      expect(name.trim(), JSON.stringify(shape)).not.toBe("");
    }
  });
});

describe("flattenSubscription", () => {
  it("synthesizes the fields no mapping path could reach", () => {
    const flat = flattenSubscription(subscription());

    expect(flat["agreement_name"]).toBe("$49/month");
    expect(flat["agreement_type"]).toBe("subscription");
    expect(flat["status"]).toBe("active");
    expect(flat["customer_id"]).toBe("cus_1");
    expect(flat["offering_id"]).toBe("price_monthly");
    expect(flat["item_count"]).toBe(1);
  });

  it("converts every date from epoch seconds to ISO 8601", () => {
    // Every date the record writer accepts goes through `new Date(string)`, so
    // an epoch number left alone is silently dropped.
    const flat = flattenSubscription(
      subscription({ trial_end: 1_699_500_000, canceled_at: 1_700_500_000 })
    );

    expect(flat["effective_date"]).toBe(
      new Date(1_680_893_993 * 1000).toISOString()
    );
    expect(flat["current_period_end"]).toBe(
      new Date(1_701_678_400 * 1000).toISOString()
    );
    expect(flat["trial_ends_at"]).toBe(
      new Date(1_699_500_000 * 1000).toISOString()
    );
    expect(flat["canceled_at"]).toBe(
      new Date(1_700_500_000 * 1000).toISOString()
    );
  });

  it("omits a date Stripe left null instead of inventing one", () => {
    const flat = flattenSubscription(subscription({ trial_end: null }));
    expect("trial_ends_at" in flat).toBe(false);
  });

  it("omits status entirely when Stripe's is unrecognised", () => {
    // Omitted rather than null: no mapping rule fires, so the writer never sees
    // a value to warn about. The unknown status is the handler's problem.
    const flat = flattenSubscription(subscription({ status: "renegotiating" }));
    expect("status" in flat).toBe(false);
    // But Stripe's own word survives, so nothing is lost.
    expect(flat["raw_status"]).toBe("renegotiating");
  });

  it("keeps Stripe's status beside ours where the mapping is lossy", () => {
    const flat = flattenSubscription(subscription({ status: "unpaid" }));
    expect(flat["status"]).toBe("past_due");
    expect(flat["raw_status"]).toBe("unpaid");
  });

  it("counts every priced item, not just the linkable one", () => {
    const flat = flattenSubscription(
      subscription({
        items: {
          object: "list",
          data: [
            { id: "si_1", price: PRICE, quantity: 1 },
            { id: "si_2", price: { ...PRICE, id: "price_seat" }, quantity: 25 },
          ],
        },
      })
    );

    expect(flat["item_count"]).toBe(2);
    // The first item's price is the one linked, and its quantity is the one
    // carried — both stated so the arbitrariness is at least documented.
    expect(flat["offering_id"]).toBe("price_monthly");
    expect(flat["quantity"]).toBe(1);
  });
});

describe("reading the two ids", () => {
  it("reads a customer id in both the bare and expanded forms", () => {
    // Bare normally, an object when the caller asked for expansion. Reading
    // both means the association does not silently break if expansion is ever
    // turned on for this endpoint.
    expect(subscriptionCustomerId(subscription())).toBe("cus_1");
    expect(
      subscriptionCustomerId(
        subscription({ customer: { id: "cus_2", object: "customer" } })
      )
    ).toBe("cus_2");
    expect(subscriptionCustomerId(subscription({ customer: null }))).toBeUndefined();
  });

  it("reads the offering id off the first item, and nothing when there are none", () => {
    expect(subscriptionOfferingId(subscription())).toBe("price_monthly");
    expect(subscriptionOfferingId(bare())).toBeUndefined();
  });
});

describe("the handler's references", () => {
  it("gives an agreement two parents and a subscription one", () => {
    // The only record in the system with two, and neither is primary: an
    // agreement is an arrangement between a customer and something sold.
    expect(
      stripeAgreementHandler.externalRefsOf(subscription(), "agreement")
    ).toEqual({ customer: "cus_1", offering: "price_monthly" });

    expect(
      stripeAgreementHandler.externalRefsOf(subscription(), "subscription")
    ).toEqual({ agreement: "sub_1" });
  });

  it("claims no references for an object it does not serve", () => {
    expect(
      stripeAgreementHandler.externalRefsOf(subscription(), "customer")
    ).toEqual({});
  });

  it("keys both halves by the same subscription id", () => {
    // Two rows, two tables, one provider id. Nothing has to tell them apart,
    // because nothing ever sees them in the same table.
    expect(stripeAgreementHandler.externalIdOf(subscription())).toBe("sub_1");
  });
});

describe("the subscriptions list URL", () => {
  it("asks for canceled subscriptions as well as live ones", () => {
    // Stripe's default omits canceled subscriptions, and this system has no
    // absence detection to notice a row that stopped arriving — so the row
    // would read active forever.
    const url = new URL(listUrl("subscriptions", 25, undefined, { status: "all" }));
    expect(url.pathname).toBe("/v1/subscriptions");
    expect(url.searchParams.get("status")).toBe("all");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("refuses to let a filter overwrite the pagination parameters", () => {
    // A filter that could clobber `starting_after` would page forever.
    const url = new URL(
      listUrl("subscriptions", 25, "sub_9", {
        status: "all",
        starting_after: "sub_1",
        limit: "1",
      })
    );
    expect(url.searchParams.get("starting_after")).toBe("sub_9");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("status")).toBe("all");
  });
});

describe("flattenSubscription — where the period dates live", () => {
  /**
   * Stripe moved `current_period_start` / `current_period_end` off the
   * subscription and onto each item. Both shapes are in service: a sandbox
   * created today sends the item form, an account pinned to an older API
   * version sends the subscription form.
   *
   * Reading only one is the failure this suite exists to prevent, and it is a
   * silent one — the column goes null, the "Renews" column empties, and the
   * `currentPeriodEnd` ordering and index quietly stop meaning anything, with
   * no error anywhere, because a subscription may legitimately have no period.
   * Verified against a live sandbox before these were written.
   */
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

  it("reads the period off the subscription, the older API shape", () => {
    const flat = flattenSubscription(subscription());

    expect(flat["current_period_start"]).toBe(iso(1_699_000_000));
    expect(flat["current_period_end"]).toBe(iso(1_701_678_400));
  });

  it("reads the period off the first item, the current API shape", () => {
    // No period on the subscription at all — exactly what /v1/subscriptions
    // returns today.
    const { current_period_start, current_period_end, ...rest } = subscription();
    void current_period_start;
    void current_period_end;

    const flat = flattenSubscription({
      ...rest,
      items: {
        object: "list",
        data: [
          {
            id: "si_1",
            price: PRICE,
            quantity: 1,
            current_period_start: 1_699_000_000,
            current_period_end: 1_701_678_400,
          },
        ],
      },
    });

    expect(flat["current_period_start"]).toBe(iso(1_699_000_000));
    expect(flat["current_period_end"]).toBe(iso(1_701_678_400));
  });

  it("prefers the subscription's own value when a payload carries both", () => {
    // Not arbitrary: the subscription-level value is the subscription-wide
    // fact, where an item's is that line's. They agree in practice, and if
    // they ever disagree the wider one is the one this row is about.
    const flat = flattenSubscription(
      subscription({
        items: {
          object: "list",
          data: [
            {
              id: "si_1",
              price: PRICE,
              quantity: 1,
              current_period_end: 1_800_000_000,
            },
          ],
        },
      })
    );

    expect(flat["current_period_end"]).toBe(iso(1_701_678_400));
  });

  it("omits the period when neither place has one", () => {
    const { current_period_start, current_period_end, ...rest } = bare();
    void current_period_start;
    void current_period_end;

    const flat = flattenSubscription(rest);

    expect("current_period_start" in flat).toBe(false);
    expect("current_period_end" in flat).toBe(false);
  });
});

describe("agreementDisplayName and offeringDisplayName agree", () => {
  /**
   * The two names for one thing.
   *
   * An agreement points at the offering its price became, and the two are
   * rendered a page apart — so a subscription reading "Custom pricing/month" on
   * /catalog and "sub_1U…" on /agreements is one row contradicting itself.
   * They were the same three layers written twice and had already drifted on
   * the tiered case, which is why this asserts the *relationship* rather than
   * either result.
   */
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["a nicknamed price", { ...PRICE, nickname: "Team annual" }],
    ["a plain monthly price", PRICE],
    ["an annual price", { ...PRICE, recurring: { interval: "year", interval_count: 1 } }],
    [
      "a multi-month price",
      { ...PRICE, recurring: { interval: "month", interval_count: 3 } },
    ],
    ["a zero-decimal currency", { ...PRICE, currency: "jpy", unit_amount: 5000 }],
    [
      "a tiered price with no unit_amount",
      { ...PRICE, unit_amount: null, billing_scheme: "tiered" },
    ],
    [
      "a metered price",
      {
        ...PRICE,
        unit_amount: null,
        recurring: { interval: "month", interval_count: 1, usage_type: "metered" },
      },
    ],
  ];

  for (const [label, price] of shapes) {
    it(`gives ${label} the same name on both objects`, () => {
      expect(
        agreementDisplayName(
          subscription({
            items: { object: "list", data: [{ id: "si_1", price }] },
          })
        )
      ).toBe(offeringDisplayName(price));
    });
  }

  it("still falls back to the subscription id when there is no price at all", () => {
    // The one case that cannot delegate — there is no price whose id to borrow,
    // and the agreement still needs a non-blank name.
    expect(agreementDisplayName(bare())).toBe("sub_1");
  });
});
