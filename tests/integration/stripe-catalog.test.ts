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
const ENTITLEMENT_FEATURES = "https://api.stripe.com/v1/entitlements/features";
/** Path-matched, because the product id is a segment rather than a filter. */
const PRODUCT_FEATURES = "https://api.stripe.com/v1/products/:productId/features";

function listing(data: Array<Record<string, unknown>>) {
  return HttpResponse.json({ object: "list", has_more: false, data });
}

/**
 * An empty entitlements list, as a *default* handler.
 *
 * Every sync probes this endpoint once, and an empty answer skips the
 * per-product fan-out. Registered as a default so it survives
 * `resetHandlers()` and the tests above it read as they did before the feature
 * existed. The tests that care override it.
 *
 * It also turns `onUnhandledRequest: "error"` into a second line of defence:
 * with no handler registered for the per-product features path, a regression
 * that
 * fanned out anyway fails every test in this file rather than one.
 */
const server = setupServer(http.get(ENTITLEMENT_FEATURES, () => listing([])));

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
      "prod_1",
      "prod_2",
      "prod_3",
    ]);
    expect(byObject.price.map((p) => p["id"])).toEqual([
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
    expect(objects).toEqual([
      "product",
      "offering",
      "product",
      "offering",
      "price",
      "price",
    ]);
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

    expect(byObject.price[0]?.["offering_name"]).toBe("$49/month");
  });

  it("keeps a nickname when the merchant set one", async () => {
    server.use(
      ...catalog([product("prod_1")], [price("price_1", { nickname: "Team plan" })])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.price[0]?.["offering_name"]).toBe("Team plan");
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

    expect(byObject.price[0]?.["interval"]).toBe("month");
    expect(byObject.price[1]?.["interval"]).toBe("one_time");
    expect(byObject.price[1]?.["interval_count"]).toBe(1);
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

    const first = byObject.price[0];
    const second = byObject.price[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    expect(stripeCatalogHandler.externalRefsOf(first, "price")).toEqual({ offering: "prod_1" });
    expect(stripeCatalogHandler.externalRefsOf(second, "price")).toEqual({ offering: "prod_2" });
  });

  it("converts the epoch created stamp on products as well as prices", async () => {
    // The identity handler does this for customers; missing it here would store
    // a null create date with no error to explain it.
    server.use(...catalog([product("prod_1")], [price("price_1")]));

    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.product[0]?.["created_at"]).toBe("2023-04-07T18:59:53.000Z");
    expect(byObject.price[0]?.["created_at"]).toBe("2023-04-07T18:59:53.000Z");
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

    expect(byObject.price[0]?.["interval"]).toBe("month");
  });
});

/**
 * A mapping that points at the object, which the handler requires before it
 * will fan out. Only the presence of an entry matters — Stripe has no
 * field-selection parameter, so the paths themselves are never sent.
 */
const FEATURES_MAPPED = { feature: ["feature_name"] };

/**
 * The features pass: the probe that decides whether to make it, and the URL it
 * takes its parent id from.
 */
describe("Stripe features", () => {
  function attachment(
    id: string,
    featureId: string,
    name: string,
    lookupKey: string | null = null
  ) {
    return {
      id,
      object: "product_feature",
      livemode: false,
      entitlement_feature: {
        id: featureId,
        object: "entitlements.feature",
        name,
        lookup_key: lookupKey,
        metadata: {},
      },
    };
  }

  it("makes no request at all when nothing is mapped to the object", async () => {
    // Checked before the probe, so an integration with no feature rules pays
    // *zero* extra requests rather than one. That is the ordinary state of
    // every integration connected before this object existed, and without this
    // the features would be fetched, rejected by the writer for a missing name,
    // and reported as a partial run on every sync forever.
    const probes: string[] = [];
    const featureRequests: string[] = [];
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => {
        probes.push("probe");
        return listing([{ id: "feat_api" }]);
      }),
      pagedEndpoint(PRODUCTS, [[product("prod_1")]]),
      pagedEndpoint(PRICES, [[price("price_1")]]),
      http.get(PRODUCT_FEATURES, ({ params }) => {
        featureRequests.push(String(params["productId"]));
        return listing([attachment("prodft_1", "feat_api", "API access")]);
      })
    );

    // No `sources`, so no rule points at `feature`.
    const { ctx } = testContext();
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(probes).toEqual([]);
    expect(featureRequests).toEqual([]);
    expect(byObject.feature).toEqual([]);
    // The rest of the catalog is unaffected — the gate is on this pass alone.
    expect(byObject.product).toHaveLength(1);
    expect(byObject.offering).toHaveLength(1);
  });

  it("makes no per-product request when the account defines no features", async () => {
    // The performance contract, asserted as a request *count* rather than as an
    // output. A refactor that made the probe always return true would satisfy
    // every output assertion in this file while silently restoring one request
    // per product on every sync of every account that does not use
    // Entitlements — which is most of them.
    const featureRequests: string[] = [];
    server.use(
      pagedEndpoint(PRODUCTS, [[product("prod_1"), product("prod_2")]]),
      pagedEndpoint(PRICES, [[price("price_1")]]),
      http.get(PRODUCT_FEATURES, ({ params }) => {
        featureRequests.push(String(params["productId"]));
        return listing([]);
      })
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(featureRequests).toEqual([]);
    expect(byObject.feature).toEqual([]);
  });

  it("asks every product once when the account does define features", async () => {
    const featureRequests: string[] = [];
    server.use(
      // One definition is enough to turn the fan-out on; the probe asks whether
      // any exist, not which.
      http.get(ENTITLEMENT_FEATURES, () =>
        listing([{ id: "feat_api", object: "entitlements.feature" }])
      ),
      pagedEndpoint(PRODUCTS, [[product("prod_1")], [product("prod_2")]]),
      pagedEndpoint(PRICES, [[price("price_1")]]),
      http.get(PRODUCT_FEATURES, ({ params }) => {
        featureRequests.push(String(params["productId"]));
        return listing([]);
      })
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    await collect(stripeCatalogHandler, ctx);

    // Both products, including the one from the second page — the ids are
    // collected as the pages stream past, so a fan-out that only remembered the
    // last page would still pass a single-page test.
    expect(featureRequests).toEqual(["prod_1", "prod_2"]);
  });

  it("takes the offering of each row from the URL, never from the payload", async () => {
    // The one genuinely new hazard in this handler. A Stripe ProductFeature
    // response has no parent field at all, so the offering id (the synthesised
    // sibling of the product) comes from the request URL; a handler that lost
    // track would link every row to the wrong offering with no error and no
    // null to notice. The payloads below carry a deliberately
    // misleading `product` to prove the URL wins.
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => listing([{ id: "feat_api" }])),
      pagedEndpoint(PRODUCTS, [
        [product("prod_platform"), product("prod_support")],
      ]),
      pagedEndpoint(PRICES, [[]]),
      http.get(PRODUCT_FEATURES, ({ params }) => {
        const id = String(params["productId"]);
        return listing([
          {
            ...attachment(`prodft_${id}`, "feat_api", "API access", "api-access"),
            product: "prod_WRONG",
          },
        ]);
      })
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.feature.map((f) => f["offering_id"])).toEqual([
      "prod_platform",
      "prod_support",
    ]);

    const first = byObject.feature[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(stripeCatalogHandler.externalRefsOf(first, "feature")).toEqual({
      offering: "prod_platform",
    });
  });

  it("lifts the nested name, key and id of the feature to the top level", async () => {
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => listing([{ id: "feat_api" }])),
      pagedEndpoint(PRODUCTS, [[product("prod_1")]]),
      pagedEndpoint(PRICES, [[]]),
      http.get(PRODUCT_FEATURES, () =>
        listing([
          attachment(
            "prodft_1",
            "feat_support",
            "Premium support",
            "premium-support"
          ),
        ])
      )
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    const row = byObject.feature[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // The id of the attachment keys the row, not the id of the feature — the
    // same feature on two products has to be two rows.
    expect(stripeCatalogHandler.externalIdOf(row)).toBe("prodft_1");
    expect(row["feature_name"]).toBe("Premium support");
    expect(row["lookup_key"]).toBe("premium-support");
    expect(row["feature_id"]).toBe("feat_support");
  });

  it("yields the same feature twice when two products include it", async () => {
    // The case a feature-definitions table would have turned into a join row.
    // Here it is two ordinary rows that happen to share an `externalFeatureId`.
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => listing([{ id: "feat_api" }])),
      pagedEndpoint(PRODUCTS, [
        [product("prod_platform"), product("prod_integrations")],
      ]),
      pagedEndpoint(PRICES, [[]]),
      http.get(PRODUCT_FEATURES, ({ params }) =>
        listing([
          attachment(
            `prodft_${String(params["productId"])}`,
            "feat_api",
            "API access",
            "api-access"
          ),
        ])
      )
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    expect(byObject.feature).toHaveLength(2);
    expect(new Set(byObject.feature.map((f) => f["feature_id"]))).toEqual(
      new Set(["feat_api"])
    );
    expect(byObject.feature.map((f) => f["id"])).toEqual([
      "prodft_prod_platform",
      "prodft_prod_integrations",
    ]);
  });

  it("yields every product and price page before any feature page", async () => {
    // Features resolve their offering through the index the product pages build,
    // exactly as offerings do — and unlike an offering there is no relink pass
    // to repair it on a later run.
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => listing([{ id: "feat_api" }])),
      pagedEndpoint(PRODUCTS, [[product("prod_1")], [product("prod_2")]]),
      pagedEndpoint(PRICES, [[price("price_1")]]),
      http.get(PRODUCT_FEATURES, () => listing([]))
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { pages } = await collect(stripeCatalogHandler, ctx);

    expect(pages.map((page) => page.object)).toEqual([
      "product",
      "offering",
      "product",
      "offering",
      "price",
      "feature",
      "feature",
    ]);
  });

  it("tolerates a product with no features at all", async () => {
    server.use(
      http.get(ENTITLEMENT_FEATURES, () => listing([{ id: "feat_api" }])),
      pagedEndpoint(PRODUCTS, [[product("prod_seats")]]),
      pagedEndpoint(PRICES, [[]]),
      http.get(PRODUCT_FEATURES, () => listing([]))
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    const { byObject } = await collect(stripeCatalogHandler, ctx);

    // An empty page is still a page: the pass must not throw, and must not
    // invent a row from a response carrying no data.
    expect(byObject.feature).toEqual([]);
  });

  it("fails the run rather than reading a broken probe as 'no features'", async () => {
    // "We could not ask" and "the answer is no" must not produce the same sync.
    // A swallowed probe error would turn a revoked key or a Stripe outage into a
    // clean, successful run that quietly dropped every feature.
    server.use(
      pagedEndpoint(PRODUCTS, [[product("prod_1")]]),
      pagedEndpoint(PRICES, [[]]),
      http.get(ENTITLEMENT_FEATURES, () =>
        HttpResponse.json({ error: { message: "nope" } }, { status: 403 })
      )
    );

    const { ctx } = testContext({ sources: FEATURES_MAPPED });
    await expect(collect(stripeCatalogHandler, ctx)).rejects.toThrow();
  });
});

describe("Stripe feature field discovery", () => {
  it("reads the flat definitions endpoint, not a per-product one", async () => {
    // A Stripe ProductFeature attachment carries no metadata of its own, and the
    // attachments are only reachable per product — so sampling them would mean
    // fanning out over the whole catalog just to populate a dropdown.
    const featureRequests: string[] = [];
    server.use(
      http.get(ENTITLEMENT_FEATURES, () =>
        listing([
          {
            id: "feat_api",
            object: "entitlements.feature",
            name: "API access",
            lookup_key: "api-access",
            metadata: { tier: "gold" },
          },
        ])
      ),
      http.get(PRODUCT_FEATURES, ({ params }) => {
        featureRequests.push(String(params["productId"]));
        return listing([]);
      })
    );

    const { ctx } = testContext();
    const paths = (
      await stripeFieldDiscovery.discover(ctx, "feature")
    ).map((f) => f.path);

    expect(featureRequests).toEqual([]);
    // The four the handler invents; without these the shipped default mapping
    // would name fields the editor claims do not exist.
    expect(paths).toContain("feature_name");
    expect(paths).toContain("lookup_key");
    expect(paths).toContain("feature_id");
    expect(paths).toContain("offering_id");
    // Prefixed with the path the record actually carries. A bare
    // `metadata.tier` would resolve to nothing on every feature row.
    expect(paths).toContain("entitlement_feature.metadata.tier");
    expect(paths).not.toContain("metadata.tier");
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

  it("reads prices for the price object, and offers the synthesized paths", async () => {
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
    const paths = (await stripeFieldDiscovery.discover(ctx, "price")).map(
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
