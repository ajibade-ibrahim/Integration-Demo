/**
 * The pure pieces of the product-feature pass: the URL that names the parent,
 * and the two builders that split one attachment into a definition and a link.
 *
 * Unit-tested apart from the handler because between them they carry the one
 * hazard this object introduced. A ProductFeature response contains no
 * reference to the product it belongs to, so the link's association is built
 * entirely from a string the caller was holding. Every other association in
 * this system is read from the payload and therefore fails loudly when it is
 * wrong; this one fails silently, producing a full table of rows linked to the
 * wrong products with no error and no null anywhere.
 *
 * The split adds a second hazard of the same kind: a definition record must be
 * keyed on the nested `feat_…`, not on the attachment's `prodft_…`.
 *
 * `tests/integration/stripe-catalog.test.ts` pins the handler keeping track.
 * These tests pin the functions it keeps track *with*.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  entitlementFeaturesUrl,
  flattenFeatureDefinition,
  flattenFeatureEntitlement,
  listUrl,
  productFeaturesUrl,
} from "@/core/providers/stripe/api";

afterEach(() => {
  delete process.env["STRIPE_API_BASE"];
});

describe("productFeaturesUrl", () => {
  it("puts the product id in the path and the cursor in the query", () => {
    const url = new URL(productFeaturesUrl("prod_platform", 25, "prodft_9"));

    expect(url.pathname).toBe("/v1/products/prod_platform/features");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("starting_after")).toBe("prodft_9");
  });

  it("omits starting_after on the first page", () => {
    // Stripe treats an empty `starting_after` as a cursor rather than as its
    // absence, so sending one would ask for the page after a row with no id.
    const url = new URL(productFeaturesUrl("prod_platform", 25));
    expect(url.searchParams.has("starting_after")).toBe(false);
  });

  it("percent-encodes the product id", () => {
    // Stripe's own ids are alphanumeric, so this is belt and braces for them —
    // and load-bearing for anything a mock, proxy or hand-written fixture
    // returns. This is the only path segment in the system built from data
    // rather than from a literal, which makes it the only one where a value
    // could otherwise reach into the URL structure.
    const url = new URL(productFeaturesUrl("prod/../../account", 25));

    expect(url.pathname).toBe("/v1/products/prod%2F..%2F..%2Faccount/features");
  });

  it("keeps the base path a mock or proxy is mounted under", () => {
    // The reason both builders concatenate rather than use `new URL(path, base)`:
    // a leading-slash path replaces the base's own path entirely, which would
    // silently strip the prefix and send every request to the wrong host root.
    process.env["STRIPE_API_BASE"] = "https://example.test/api/fake/stripe";

    expect(productFeaturesUrl("prod_1", 10)).toContain(
      "/api/fake/stripe/v1/products/prod_1/features"
    );
    // Asserted alongside, because this is the property the extraction of
    // `paginatedUrl` had to preserve rather than one it introduced.
    expect(listUrl("products", 10)).toContain("/api/fake/stripe/v1/products");
  });
});

describe("entitlementFeaturesUrl", () => {
  it("names the flat definitions endpoint and carries the limit", () => {
    const url = new URL(entitlementFeaturesUrl(1));

    expect(url.pathname).toBe("/v1/entitlements/features");
    // `limit=1` is the whole point of the sync's use of it: the request exists
    // only to learn whether the list is empty, never to read it. (Discovery
    // samples the same endpoint with a larger limit, for metadata keys.)
    expect(url.searchParams.get("limit")).toBe("1");
  });
});

describe("listUrl after the paginatedUrl extraction", () => {
  it("still refuses to let an extra parameter clobber the cursor", () => {
    // A filter that could overwrite `starting_after` would page the same rows
    // forever. Kept as an assertion rather than trusted to the extraction,
    // because the guard now lives one function further away from the caller.
    const url = new URL(
      listUrl("products", 25, "prod_5", {
        starting_after: "prod_HIJACK",
        limit: "999",
        active: "true",
      })
    );

    expect(url.searchParams.get("starting_after")).toBe("prod_5");
    expect(url.searchParams.get("limit")).toBe("25");
    // The parameters that are not pagination still apply.
    expect(url.searchParams.get("active")).toBe("true");
  });
});

describe("flattenFeatureDefinition", () => {
  const attachment = {
    id: "prodft_1",
    object: "product_feature",
    livemode: false,
    entitlement_feature: {
      id: "feat_support",
      object: "entitlements.feature",
      name: "Premium support",
      lookup_key: "premium-support",
      metadata: { tier: "gold" },
    },
  };

  it("keys the definition on the feature id, not the attachment id", () => {
    // The whole hazard of the split. `externalIdOf` reads a bare `id` and knows
    // nothing about the object, so a definition record left carrying the
    // attachment's `prodft_…` would be upserted under the wrong key — silently,
    // and for every row.
    const definition = flattenFeatureDefinition(attachment);

    expect(definition?.["id"]).toBe("feat_support");
    expect(definition?.["feature_name"]).toBe("Premium support");
    expect(definition?.["lookup_key"]).toBe("premium-support");
  });

  it("returns nothing for an attachment with no definition", () => {
    // A definitionless attachment is not a feature, and writing it with no id
    // would only produce a rejection.
    expect(flattenFeatureDefinition({ id: "prodft_1" })).toBeUndefined();
    expect(
      flattenFeatureDefinition({ id: "prodft_1", entitlement_feature: { name: "x" } })
    ).toBeUndefined();
  });

  it("returns undefined for a lookup key the merchant left unset", () => {
    // Stripe sends `lookup_key: null` for a feature created without one, and
    // null must not become the string "null" in a column code gates on.
    const noKey = {
      ...attachment,
      entitlement_feature: { ...attachment.entitlement_feature, lookup_key: null },
    };

    expect(flattenFeatureDefinition(noKey)?.["lookup_key"]).toBeUndefined();
    expect(flattenFeatureDefinition(noKey)?.["feature_name"]).toBe(
      "Premium support"
    );
  });

  it("keeps the nested feature metadata reachable", () => {
    // Discovery offers `entitlement_feature.metadata.*` for the definition, so
    // the nested object has to travel with the record.
    expect(
      (flattenFeatureDefinition(attachment)?.["entitlement_feature"] as
        | Record<string, unknown>
        | undefined)?.["metadata"]
    ).toEqual({ tier: "gold" });
  });
});

describe("flattenFeatureEntitlement", () => {
  const attachment = {
    id: "prodft_1",
    object: "product_feature",
    livemode: false,
    entitlement_feature: {
      id: "feat_support",
      object: "entitlements.feature",
      name: "Premium support",
      lookup_key: "premium-support",
    },
  };

  it("keys the link on the attachment id and names the feature", () => {
    // The link is the attachment: the same feature on two products is two
    // links, so the id has to be the `prodft_…`.
    const link = flattenFeatureEntitlement(attachment, "prod_support");

    expect(link["id"]).toBe("prodft_1");
    expect(link["feature_id"]).toBe("feat_support");
    expect(link["offering_id"]).toBe("prod_support");
  });

  it("takes the offering id from the argument", () => {
    expect(flattenFeatureEntitlement(attachment, "prod_support")["offering_id"]).toBe(
      "prod_support"
    );
  });

  it("ignores a parent id the record carries itself", () => {
    // The hazard, stated as a test. Stripe sends no `product` on this object
    // today; if a future version, a proxy or a fixture ever did, the URL the
    // caller actually requested must still win — otherwise a record could
    // reassign itself to another offering and nothing would notice.
    const misleading = {
      ...attachment,
      product: "prod_WRONG",
      product_id: "prod_ALSO_WRONG",
      offering_id: "prod_STILL_WRONG",
    };

    const link = flattenFeatureEntitlement(misleading, "prod_support");
    expect(link["offering_id"]).toBe("prod_support");
    expect(link["id"]).toBe("prodft_1");
  });
});
