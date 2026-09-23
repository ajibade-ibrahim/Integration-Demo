/**
 * The pure pieces of the line-item pass: the URL that completes a truncated
 * list, the check that says whether it is truncated, and the flattening that
 * decides which agreement each line belongs to.
 *
 * These are unit-tested apart from the handler because between them they carry
 * a hazard no other object in this system has. Every other association here is
 * read from the payload and so fails loudly when it is wrong. This one is
 * built from a string the caller was holding — and unlike `ProductFeature`,
 * where the payload is simply silent about its parent, a subscription item
 * *does* carry a `subscription` field that looks authoritative and is
 * deliberately ignored.
 *
 * The stakes are also higher one table over. `writeAgreementItems` is the only
 * writer that deletes, and it deletes the lines of the agreement a record
 * claims. A line that could reassign itself would take its former siblings
 * with it, silently, with no error and no null anywhere.
 *
 * `tests/integration/agreement-writer.test.ts` pins the deletion guards.
 * These tests pin the functions those guards depend on being fed correctly.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  flattenAgreementItem,
  itemTypeOf,
  subscriptionItems,
  subscriptionItemsComplete,
  subscriptionItemsUrl,
} from "@/core/providers/stripe/api";

afterEach(() => {
  delete process.env["STRIPE_API_BASE"];
});

const licensedItem = {
  id: "si_plan",
  object: "subscription_item",
  quantity: 1,
  subscription: "sub_1",
  price: {
    id: "price_monthly",
    object: "price",
    unit_amount: 4900,
    currency: "usd",
    recurring: { interval: "month", usage_type: "licensed" },
  },
};

const meteredItem = {
  id: "si_metered",
  object: "subscription_item",
  subscription: "sub_1",
  price: {
    id: "price_api_calls",
    object: "price",
    recurring: { interval: "month", usage_type: "metered" },
  },
};

describe("subscriptionItemsUrl", () => {
  it("names the list endpoint with the subscription as a filter", () => {
    const url = new URL(subscriptionItemsUrl("sub_1", 25));

    // A real list endpoint, unlike `/v1/products/{id}/features` — so the
    // parent is a query parameter and needs none of that builder's path
    // encoding.
    expect(url.pathname).toBe("/v1/subscription_items");
    expect(url.searchParams.get("subscription")).toBe("sub_1");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("carries the cursor and cannot have it clobbered by the filter", () => {
    const url = new URL(subscriptionItemsUrl("sub_1", 25, "si_10"));
    expect(url.searchParams.get("starting_after")).toBe("si_10");
  });

  it("omits starting_after on the first page", () => {
    // Stripe reads an empty `starting_after` as a cursor rather than as its
    // absence, so sending one asks for the page after a row with no id.
    const url = new URL(subscriptionItemsUrl("sub_1", 25));
    expect(url.searchParams.has("starting_after")).toBe(false);
  });

  it("escapes a subscription id rather than letting it reach the query raw", () => {
    const url = new URL(subscriptionItemsUrl("sub_1&limit=999", 25));

    expect(url.searchParams.get("subscription")).toBe("sub_1&limit=999");
    // The injected `limit` did not become a second parameter.
    expect(url.searchParams.getAll("limit")).toEqual(["25"]);
  });

  it("keeps the base path a mock or proxy is mounted under", () => {
    process.env["STRIPE_API_BASE"] = "https://example.test/api/fake/stripe";
    expect(subscriptionItemsUrl("sub_1", 10)).toContain(
      "/api/fake/stripe/v1/subscription_items"
    );
  });
});

describe("subscriptionItemsComplete", () => {
  it("is false when Stripe says there are more", () => {
    // The whole reason the handler makes a second request. Stripe inlines the
    // first ten items only, and trusting the inline list past that is what
    // would have the writer delete every line from the eleventh on, on every
    // sync.
    expect(
      subscriptionItemsComplete({ items: { data: [licensedItem], has_more: true } })
    ).toBe(false);
  });

  it("is true when Stripe says there are not", () => {
    expect(
      subscriptionItemsComplete({
        items: { data: [licensedItem], has_more: false },
      })
    ).toBe(true);
  });

  it("is true when there is no list object at all", () => {
    // Defaulting to complete, and the direction matters. Stripe always sends
    // `has_more` on a list, so its absence means the record is not a Stripe
    // list — a fixture, a mock, a hand-built row — and those carry everything
    // they have. Defaulting the other way would make every fixture trigger a
    // pagination request against a URL no mock serves.
    expect(subscriptionItemsComplete({ id: "sub_1" })).toBe(true);
    expect(subscriptionItemsComplete({ items: { data: [licensedItem] } })).toBe(
      true
    );
  });
});

describe("subscriptionItems", () => {
  it("reads the inlined list and drops anything that is not a record", () => {
    const items = subscriptionItems({
      items: { data: [licensedItem, "not-an-item", null, meteredItem] },
    });

    expect(items.map((i) => i["id"])).toEqual(["si_plan", "si_metered"]);
  });

  it("is empty rather than throwing for a subscription with no items", () => {
    expect(subscriptionItems({ id: "sub_1" })).toEqual([]);
  });
});

describe("itemTypeOf", () => {
  it("reads a metered price as a usage line", () => {
    expect(itemTypeOf(meteredItem)).toBe("usage");
  });

  it("returns undefined for a licensed price rather than guessing 'plan'", () => {
    // The decision this function exists to hold. Stripe's items are
    // undifferentiated — a base plan and a seat add-on are the same object
    // with different prices — so "the first one is the plan" is a convention
    // of how subscriptions are usually created, not something the API states.
    // Writing `"plan"` here would fill the column with a guess and destroy the
    // one thing it records: whether the provider actually said.
    expect(itemTypeOf(licensedItem)).toBeUndefined();
  });

  it("returns undefined for a one-time price with no recurring block", () => {
    expect(itemTypeOf({ id: "si_1", price: { id: "price_setup" } })).toBeUndefined();
    expect(itemTypeOf({ id: "si_1" })).toBeUndefined();
  });
});

describe("flattenAgreementItem", () => {
  it("takes the agreement id from the argument", () => {
    const flat = flattenAgreementItem(licensedItem, "sub_1", 0);
    expect(flat["agreement_id"]).toBe("sub_1");
  });

  it("ignores the subscription id the record carries itself", () => {
    // The hazard, stated as a test — and stricter than the `ProductFeature`
    // version of it, because here the misleading value is not hypothetical.
    // Stripe really does send `subscription` on this object, and it agrees
    // with the fetch today. The URL the caller actually requested must win
    // anyway, because this is the writer that deletes: a line that reassigned
    // itself to another agreement would have that agreement's remaining lines
    // deleted as no longer present.
    const misleading = { ...licensedItem, subscription: "sub_SOMEONE_ELSE" };

    expect(flattenAgreementItem(misleading, "sub_1", 0)["agreement_id"]).toBe(
      "sub_1"
    );
  });

  it("lifts the price id out as the offering reference", () => {
    expect(flattenAgreementItem(licensedItem, "sub_1", 0)["offering_id"]).toBe(
      "price_monthly"
    );
  });

  it("takes the position from the argument, counting from zero", () => {
    // Stripe sends no ordinal, so this is the caller's index across the
    // completed list — including pages fetched separately.
    expect(flattenAgreementItem(licensedItem, "sub_1", 0)["position"]).toBe(0);
    expect(flattenAgreementItem(meteredItem, "sub_1", 3)["position"]).toBe(3);
  });

  it("omits item_type rather than nulling it for a licensed line", () => {
    // Omitted, not null: no value means no mapping rule fires and the writer
    // never sees something to warn about. The same treatment an unrecognised
    // status gets in `flattenSubscription`.
    const flat = flattenAgreementItem(licensedItem, "sub_1", 0);
    expect("item_type" in flat).toBe(false);
  });

  it("sets item_type for a metered line", () => {
    expect(flattenAgreementItem(meteredItem, "sub_1", 1)["item_type"]).toBe(
      "usage"
    );
  });

  it("returns an undefined offering rather than inventing one when the price is missing", () => {
    const flat = flattenAgreementItem({ id: "si_1" }, "sub_1", 0);

    expect(flat["offering_id"]).toBeUndefined();
    // The two fields that never came from the payload are still there, which
    // is what keeps the row attachable even when its price is unreadable.
    expect(flat["agreement_id"]).toBe("sub_1");
    expect(flat["position"]).toBe(0);
  });
});
