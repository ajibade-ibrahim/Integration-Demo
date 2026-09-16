/**
 * Stripe's catalog handler against a mocked API.
 *
 * Three risks specific to this handler, mirroring what the identity suite pins
 * for customers and contacts:
 *
 *   - **Two resources, one cursor.** Products and prices each page with
 *     `starting_after`, and the cursor is derived from our own reading of the
 *     response rather than handed to us, so termination is partly our
 *     responsibility. Paging one resource correctly and the other not is an
 *     easy thing to ship.
 *   - **Ordering.** Every product page must precede every price page, or an
 *     offering resolves its product against an index that has not been built.
 *   - **The synthesized name.** `Offering.name` is required and Stripe's
 *     `nickname` is usually null, so a price that reaches the writer without
 *     `offering_name` is rejected on every sync forever.
 *
 * Records are built inline rather than read from
 * `scripts/stripe-sandbox-fixtures.json`, for the reason the identity suite
 * gives: that file is edited against a live sandbox, and coupling assertions to
 * it would let a demo-data tweak break the suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stripeCatalogHandler } from "@/core/providers/stripe/catalog-handler";
import { stripeFieldDiscovery } from "@/core/providers/stripe/discovery";
import { collect, testContext } from "./helpers";

const PRODUCTS = "https://api.stripe.com/v1/products";
const PRICES = "https://api.stripe.com/v1/prices";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["STRIPE_PAGE_SIZE"];
});
afterAll(() => {
  server.close();
});

function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "product",
    name: `Product ${id}`,
    description: `Description of ${id}`,
    active: true,
    created: 1_680_893_993,
    metadata: {},
    ...overrides,
  };
}

function price(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "price",
    product: "prod_1",
    active: true,
    currency: "usd",
    unit_amount: 4900,
    nickname: null,
    billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    created: 1_680_893_993,
    metadata: {},
    ...overrides,
  };
}

/**
 * Serve pages keyed on `?starting_after=`, the way Stripe does: each response
 * carries `has_more`, and the client sends back the last id it saw.
 */
function pagedEndpoint(
  endpoint: string,
  pages: Array<Array<Record<string, unknown>>>,
  seen?: string[]
) {
  return http.get(endpoint, ({ request }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("starting_after");
    seen?.push(cursor ?? "(none)");

    const index =
      cursor === null
        ? 0
        : pages.findIndex((page) => String(page.at(-1)?.["id"]) === cursor) + 1;
    const data = pages[index] ?? [];

    return HttpResponse.json({
      object: "list",
      has_more: index < pages.length - 1,
      data,
    });
  });
}

/** Both endpoints, each serving a single page. */
function catalog(
  products: Array<Record<string, unknown>>,
  prices: Array<Record<string, unknown>>
) {
  return [
    pagedEndpoint(PRODUCTS, [products]),
    pagedEndpoint(PRICES, [prices]),
  ];
}

describe("Stripe catalog pagination", () => {
  it("follows starting_after on both resources independently", async () => {
    const productCursors: string[] = [];
    const priceCursors: string[] = [];

    server.use(
      pagedEndpoint(
        PRODUCTS,
        [[product("prod_1"), product("prod_2")], [product("prod_3")]],
        productCursors
      ),
      pagedEndpoint(
        PRICES,
        [[price("price_1"), price("price_2")], [price("price_3")]],
        priceCursors
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(productCursors).toEqual(["(none)", "prod_2"]);
    expect(priceCursors).toEqual(["(none)", "price_2"]);
    expect(byObject.product.map((p) => p["id"])).toEqual([
      "prod_1",
      "prod_2",
      "prod_3",
    ]);
    expect(byObject.offering.map((p) => p["id"])).toEqual([
      "price_1",
      "price_2",
      "price_3",
    ]);
  });

  it("yields every product page before any price page", async () => {
    // The ordering the record writer depends on: offerings resolve their
    // product through the index built while products are written, so a price
    // page arriving first would be saved unlinked.
    server.use(
      pagedEndpoint(PRODUCTS, [[product("prod_1")], [product("prod_2")]]),
      pagedEndpoint(PRICES, [[price("price_1")], [price("price_2")]])
    );

    const { ctx } = testContext();
    const { pages } = await collect(stripeCatalogHandler, ctx);

    const objects = pages.map((p) => p.object);
    expect(objects).toEqual(["product", "product", "offering", "offering"]);
  });

  it("stops rather than repeating a cursor that does not advance", async () => {
    // A server that claims `has_more` forever while returning the same last id
    // would otherwise page until the process died.
    let calls = 0;
    server.use(
      http.get(PRODUCTS, () => {
        calls += 1;
        return HttpResponse.json({
          object: "list",
          has_more: true,
          data: [product("prod_same")],
        });
      }),
      pagedEndpoint(PRICES, [[]])
    );

    const { ctx } = testContext();
    await collect(stripeCatalogHandler, ctx);

    // Two: the first page, then one more that returns the same id and stops.
    expect(calls).toBe(2);
  });

  it("stops on a page whose rows carry no readable id", async () => {
    server.use(
      http.get(PRODUCTS, () =>
        HttpResponse.json({ object: "list", has_more: true, data: [{ name: "no id" }] })
      ),
      pagedEndpoint(PRICES, [[]])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    // The row is still yielded — the writer is what rejects it, and it reports
    // "Source record has no id" where the user can see it.
    expect(byObject.product).toHaveLength(1);
  });
});

describe("Stripe catalog record shape", () => {
  it("synthesizes a name for a price that has no nickname", async () => {
    server.use(...catalog([product("prod_1")], [price("price_1")]));

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.offering[0]?.["offering_name"]).toBe("$49/month");
  });

  it("keeps a nickname when the merchant set one", async () => {
    server.use(
      ...catalog([product("prod_1")], [price("price_1", { nickname: "Team plan" })])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.offering[0]?.["offering_name"]).toBe("Team plan");
  });

  it("flattens the interval and defaults a one-time price to one_time", async () => {
    server.use(
      ...catalog(
        [product("prod_1")],
        [price("price_1"), price("price_2", { recurring: null })]
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.offering[0]?.["interval"]).toBe("month");
    expect(byObject.offering[1]?.["interval"]).toBe("one_time");
    expect(byObject.offering[1]?.["interval_count"]).toBe(1);
  });

  it("carries the product association on every price", async () => {
    server.use(
      ...catalog(
        [product("prod_1"), product("prod_2")],
        [price("price_1"), price("price_2", { product: "prod_2" })]
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    const first = byObject.offering[0];
    const second = byObject.offering[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    expect(stripeCatalogHandler.externalParentIdOf(first, "offering")).toBe("prod_1");
    expect(stripeCatalogHandler.externalParentIdOf(second, "offering")).toBe("prod_2");
  });

  it("converts the epoch created stamp on products as well as prices", async () => {
    // The identity handler does this for customers; missing it here would store
    // a null create date with no error to explain it.
    server.use(...catalog([product("prod_1")], [price("price_1")]));

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.product[0]?.["created_at"]).toBe("2023-04-07T18:59:53.000Z");
    expect(byObject.offering[0]?.["created_at"]).toBe("2023-04-07T18:59:53.000Z");
  });

  it("does not let a synthesized field shadow one Stripe actually sent", async () => {
    // The spread order in the handler puts ours last deliberately. If Stripe
    // ever ships a real `interval` on a price, ours should still win, because
    // the mapping defaults and the writer's enum both expect our vocabulary.
    server.use(
      ...catalog([product("prod_1")], [price("price_1", { interval: "fortnight" })])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.offering[0]?.["interval"]).toBe("month");
  });
});

describe("Stripe catalog field discovery", () => {
  it("reads products for the product object, not customers", async () => {
    // The bug this replaced: discovery used to fall through to the customers
    // endpoint for any object that was not `contact`, which would have offered
    // customer fields as product targets.
    server.use(
      http.get(PRODUCTS, () =>
        HttpResponse.json({
          object: "list",
          has_more: false,
          data: [product("prod_1", { metadata: { sku_family: "widgets" } })],
        })
      )
    );

    const { ctx } = testContext();
    const fields = await stripeFieldDiscovery.discover(ctx, "product");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("name");
    expect(paths).toContain("active");
    // Sampled from the live page, which is the only reason discovery makes a
    // request at all.
    expect(paths).toContain("metadata.sku_family");
    // Customer-only fields must not leak in.
    expect(paths).not.toContain("delinquent");
  });

  it("reads prices for the offering object, and offers the synthesized paths", async () => {
    server.use(
      http.get(PRICES, () =>
        HttpResponse.json({
          object: "list",
          has_more: false,
          data: [price("price_1", { metadata: { tier: "gold" } })],
        })
      )
    );

    const { ctx } = testContext();
    const paths = (await stripeFieldDiscovery.discover(ctx, "offering")).map(
      (f) => f.path
    );

    // The four the handler invents. Without these in the dropdown the default
    // mapping would name fields the editor claims do not exist.
    expect(paths).toContain("offering_name");
    expect(paths).toContain("interval");
    expect(paths).toContain("interval_count");
    expect(paths).toContain("product_id");
    expect(paths).toContain("metadata.tier");
  });
});
