/**
 * Stripe's catalog synthesis — the fields the handler invents because the raw
 * response cannot survive the trip through the mapper.
 *
 * `offeringDisplayName` carries the most risk in the file it lives in.
 * `Offering.name` is required and the record writer rejects a record without
 * one, while Stripe's `nickname` is optional and in practice usually null. So
 * if this function ever returns an empty string, every unnamed price in the
 * account is rejected on every sync, forever, with the only evidence being a
 * `partial` run status. The layered fallback exists so that cannot happen, and
 * these tests exercise each layer.
 */

import { describe, expect, it } from "vitest";
import {
  flattenPrice,
  offeringDisplayName,
  listUrl,
  parseListPage,
  priceProductId,
} from "@/core/providers/stripe/api";
import { formatMoney } from "@/core/price-format";
import { stripeCatalogHandler } from "@/core/providers/stripe/catalog-handler";

function price(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "price_1",
    object: "price",
    product: "prod_1",
    currency: "usd",
    unit_amount: 4900,
    recurring: { interval: "month", interval_count: 1 },
    ...overrides,
  };
}

describe("formatMoney", () => {
  it("divides by the right power of ten for the currency", () => {
    expect(formatMoney(4999, "usd")).toBe("$49.99");
  });

  it("drops the cents when a price has none, and only then", () => {
    // "$49" is how a price is written where a person rather than a ledger is
    // reading it, and it can only have come from 4900 minor units — so nothing
    // is lost. The test above is the other half: cents that exist are kept.
    expect(formatMoney(4900, "usd")).toBe("$49");
    expect(formatMoney(4901, "usd")).toBe("$49.01");
  });

  it("does not divide a zero-decimal currency", () => {
    // The whole reason this goes through Intl rather than `/ 100`. JPY has no
    // minor unit, so 4900 yen is ¥4,900 — dividing would misprice it by a
    // factor of a hundred, and quietly, because the result still looks like
    // money.
    expect(formatMoney(4900, "jpy")).toBe("¥4,900");
  });

  it("is case-insensitive about the currency code", () => {
    expect(formatMoney(100, "USD")).toBe(formatMoney(100, "usd"));
  });

  it("returns undefined for a code Intl rejects, rather than NaN", () => {
    expect(formatMoney(4900, "not-a-currency")).toBeUndefined();
  });
});

describe("offeringDisplayName", () => {
  it("prefers the merchant's own nickname", () => {
    expect(offeringDisplayName(price({ nickname: "Team annual" }))).toBe(
      "Team annual"
    );
  });

  it("ignores a blank nickname rather than returning it", () => {
    // A whitespace nickname would pass a truthiness check and then be trimmed
    // to nothing by the record writer, which rejects the record for a missing
    // name — the exact failure this function exists to prevent.
    expect(offeringDisplayName(price({ nickname: "   " }))).toBe("$49/month");
  });

  it("builds a name from the amount and interval", () => {
    expect(offeringDisplayName(price())).toBe("$49/month");
  });

  it("pluralises a multi-unit interval", () => {
    expect(
      offeringDisplayName(
        price({ recurring: { interval: "month", interval_count: 3 } })
      )
    ).toBe("$49/3 months");
  });

  it("omits the interval for a one-time price", () => {
    expect(offeringDisplayName(price({ recurring: null }))).toBe("$49");
  });

  it("says custom pricing when there is no unit amount", () => {
    // Tiered and metered prices carry no `unit_amount` at all.
    expect(
      offeringDisplayName(
        price({ unit_amount: null, billing_scheme: "tiered" })
      )
    ).toBe("Custom pricing/month");
  });

  it("falls back to the id rather than ever returning empty", () => {
    // The guarantee the record writer depends on. Whatever Stripe sends, this
    // returns something non-blank.
    expect(
      offeringDisplayName({ id: "price_odd", object: "price" })
    ).toBe("price_odd");
  });

  it("never returns a blank string for any shape tried here", () => {
    const shapes = [
      price(),
      price({ nickname: "" }),
      price({ unit_amount: null }),
      price({ currency: null }),
      price({ recurring: null, unit_amount: null }),
      { id: "price_bare" },
    ];
    for (const shape of shapes) {
      expect(offeringDisplayName(shape).trim()).not.toBe("");
    }
  });
});

describe("flattenPrice", () => {
  it("lifts the interval out of the nested recurring object", () => {
    const flat = flattenPrice(price());
    expect(flat["interval"]).toBe("month");
    expect(flat["interval_count"]).toBe(1);
  });

  it("reports one_time rather than null when a price does not recur", () => {
    // A value, not an absence. The writer reads null as "the provider told us
    // nothing", which is a different claim from "this does not recur", and the
    // catalog page renders the two differently.
    const flat = flattenPrice(price({ recurring: null }));
    expect(flat["interval"]).toBe("one_time");
    expect(flat["interval_count"]).toBe(1);
  });

  it("converts the epoch created stamp to something the date parse accepts", () => {
    const flat = flattenPrice(price({ created: 1_700_000_000 }));
    expect(flat["created_at"]).toBe("2023-11-14T22:13:20.000Z");
    expect(new Date(String(flat["created_at"])).getTime()).not.toBeNaN();
  });

  it("omits created_at entirely when created is unusable", () => {
    // Rather than writing `created_at: undefined`, which the mapping editor
    // would then offer as a field that is always blank.
    expect(flattenPrice(price({ created: "yesterday" }))).not.toHaveProperty(
      "created_at"
    );
  });
});

describe("priceProductId", () => {
  it("reads a bare product id", () => {
    expect(priceProductId(price())).toBe("prod_1");
  });

  it("reads an expanded product object", () => {
    // Stripe sends the id normally and the whole object when expansion is
    // requested. Handling both means turning expansion on later cannot
    // silently break every offering's association.
    expect(
      priceProductId(price({ product: { id: "prod_9", object: "product" } }))
    ).toBe("prod_9");
  });

  it("is undefined when there is no product at all", () => {
    expect(priceProductId(price({ product: null }))).toBeUndefined();
  });
});

describe("the catalog handler's record shape", () => {
  it("reads Stripe's own id as the upsert key for both objects", () => {
    expect(stripeCatalogHandler.externalIdOf({ id: "prod_1" })).toBe("prod_1");
    expect(stripeCatalogHandler.externalIdOf({ id: "price_1" })).toBe("price_1");
    expect(stripeCatalogHandler.externalIdOf({})).toBeUndefined();
  });

  it("gives an offering its product as parent, a price its offering, and a product none", () => {
    // In the 3-tier model, an offering is derived from the product with product_id set.
    expect(
      stripeCatalogHandler.externalRefsOf(
        { id: "prod_1", product_id: "prod_1" },
        "offering"
      )
    ).toEqual({ product: "prod_1" });

    // A price references its parent offering via the product field (priceProductId).
    expect(stripeCatalogHandler.externalRefsOf(price(), "price")).toEqual({
      offering: "prod_1",
    });

    // A product is a root record, so it claims no references at all — an empty
    // map rather than a map with an empty value. Returning an id here would try
    // to link a product to itself.
    expect(
      stripeCatalogHandler.externalRefsOf({ id: "prod_1" }, "product")
    ).toEqual({});
  });
});

describe("list URLs and paging", () => {
  it("addresses each resource under /v1", () => {
    expect(listUrl("products", 25)).toContain("/v1/products");
    expect(listUrl("prices", 25)).toContain("/v1/prices");
    expect(listUrl("customers", 25)).toContain("/v1/customers");
  });

  it("carries the cursor only once there is one", () => {
    expect(listUrl("products", 25)).not.toContain("starting_after");
    expect(listUrl("products", 25, "prod_7")).toContain("starting_after=prod_7");
  });

  it("reads the same envelope for every resource", () => {
    // One parser for all three, which is the point: products and prices page
    // through the customer parser rather than copies that could drift.
    const page = parseListPage({
      object: "list",
      data: [{ id: "prod_1" }, { id: "prod_2" }],
      has_more: true,
    });
    expect(page.records).toHaveLength(2);
    expect(page.lastId).toBe("prod_2");
    expect(page.hasMore).toBe(true);
  });
});
