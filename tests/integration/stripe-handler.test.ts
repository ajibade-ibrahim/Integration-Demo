/**
 * Stripe handler against a mocked API.
 *
 * Three things here are specific to this provider and carry most of the risk:
 * the `starting_after` cursor (which is derived from our own reading of the
 * response, so termination is partly our responsibility), the synthesized
 * contacts (an unstable id silently duplicates every contact on every sync
 * rather than erroring), and the epoch-seconds `created` field (which is stored
 * as null rather than failing if the ISO synthesis is missed).
 *
 * The records are built inline rather than imported from
 * `scripts/stripe-sandbox-fixtures.json`. That file exists to be edited against
 * a live sandbox; coupling these assertions to it would mean a demo-data tweak
 * breaking the test suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stripeIdentityHandler } from "@/core/providers/stripe/identity-handler";
import { stripeFieldDiscovery } from "@/core/providers/stripe/discovery";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const CUSTOMERS = "https://api.stripe.com/v1/customers";

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

interface CustomerOverrides {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  created?: number | string | null;
  metadata?: Record<string, string>;
}

function customer(id: string, overrides: CustomerOverrides = {}) {
  return {
    id,
    object: "customer",
    name: overrides.name === undefined ? `Name of ${id}` : overrides.name,
    email: overrides.email === undefined ? `${id}@example.test` : overrides.email,
    phone: overrides.phone ?? null,
    description: null,
    balance: 0,
    delinquent: false,
    currency: "usd",
    created: overrides.created === undefined ? 1_680_893_993 : overrides.created,
    metadata: overrides.metadata ?? { arr_band: "growth" },
  };
}

/**
 * Serve pages keyed on `?starting_after=`, the way Stripe does: each response
 * carries `has_more`, and the client is expected to send back the last id it saw.
 */
function pagedEndpoint(pages: Array<Array<ReturnType<typeof customer>>>, seen?: string[]) {
  return http.get(CUSTOMERS, ({ request }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("starting_after");
    seen?.push(cursor ?? "(none)");

    const index =
      cursor === null
        ? 0
        : pages.findIndex((page) => page.at(-1)?.id === cursor) + 1;
    const data = pages[index] ?? [];

    return HttpResponse.json({
      object: "list",
      url: "/v1/customers",
      has_more: index < pages.length - 1,
      data,
    });
  });
}

describe("Stripe pagination", () => {
  it("follows starting_after and stops when has_more is false", async () => {
    const seen: string[] = [];
    server.use(
      pagedEndpoint(
        [
          [customer("cus_1"), customer("cus_2")],
          [customer("cus_3")],
        ],
        seen
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(seen).toEqual(["(none)", "cus_2"]);
    expect(byObject.customer.map((c) => c["id"])).toEqual(["cus_1", "cus_2", "cus_3"]);
  });

  it("requests the configured page size, clamped to Stripe's maximum", async () => {
    const limits: string[] = [];
    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        limits.push(new URL(request.url).searchParams.get("limit") ?? "(none)");
        return HttpResponse.json({ has_more: false, data: [] });
      })
    );

    process.env["STRIPE_PAGE_SIZE"] = "500";
    const { ctx } = testContext();
    await collect(stripeIdentityHandler, ctx);

    expect(limits).toEqual(["100"]);
  });

  it("stops rather than looping when the cursor does not advance", async () => {
    let requests = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        requests += 1;
        // Always the same last id, with has_more still true: the cursor
        // equivalent of a provider echoing the page number it was given.
        return HttpResponse.json({ has_more: true, data: [customer("cus_1")] });
      })
    );

    const { ctx } = testContext();
    await collect(stripeIdentityHandler, ctx);

    expect(requests).toBe(2);
  });

  it("stops when has_more is true but the page carries no usable id", async () => {
    let requests = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        requests += 1;
        return HttpResponse.json({
          has_more: true,
          data: [{ object: "customer", name: "No id at all" }],
        });
      })
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(requests).toBe(1);
    // Yielded anyway — the record writer is what refuses an id-less record, and
    // it reports why. Dropping it here would hide the problem.
    expect(byObject.customer).toHaveLength(1);
  });
});

describe("Stripe contact synthesis", () => {
  it("yields every customer page before any contact page", async () => {
    server.use(
      pagedEndpoint([
        [customer("cus_1")],
        [customer("cus_2")],
        [customer("cus_3")],
      ])
    );

    const { ctx } = testContext();
    const { pages } = await collect(stripeIdentityHandler, ctx);

    const objects = pages.map((p) => p.object);
    expect(objects.lastIndexOf("customer")).toBeLessThan(objects.indexOf("contact"));
    expect(objects.filter((o) => o === "customer")).toHaveLength(3);
  });

  it("links each contact to its customer and names it", async () => {
    server.use(
      pagedEndpoint([
        [
          customer("cus_1", {
            name: "Acme Manufacturing",
            email: "Billing@Acme.example",
            phone: "+1 415 555 0101",
          }),
        ],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(byObject.contact).toHaveLength(1);
    const [contact] = byObject.contact;
    expect(contact?.["contact_id"]).toBe("cus_1:contact");
    expect(contact?.["contact_name"]).toBe("Acme Manufacturing");
    expect(contact?.["email"]).toBe("Billing@Acme.example");
    expect(contact?.["phone"]).toBe("+1 415 555 0101");
    expect(stripeIdentityHandler.externalCustomerIdOf(contact!)).toBe("cus_1");
    expect(stripeIdentityHandler.externalIdOf(contact!)).toBe("cus_1:contact");
  });

  it("names the contact from the email local part when there is no name", async () => {
    server.use(
      pagedEndpoint([
        [customer("cus_1", { name: null, email: "finance.team@vance.co.uk" })],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(byObject.contact[0]?.["contact_name"]).toBe("finance.team");
    expect(byObject.contact[0]?.["customer_name"]).toBeNull();
  });

  it("emits no contact when the customer has neither a name nor an email", async () => {
    server.use(
      pagedEndpoint([
        [
          customer("cus_1", { name: null, email: null }),
          // Whitespace-only: the record writer trims before checking, so this
          // would be rejected for a missing name on every sync forever.
          customer("cus_2", { name: "   ", email: null }),
        ],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(byObject.customer).toHaveLength(2);
    expect(byObject.contact).toHaveLength(0);
  });

  it("keeps contact ids stable when the email changes", async () => {
    server.use(pagedEndpoint([[customer("cus_1", { email: "old@x.example" })]]));
    const first = await collect(stripeIdentityHandler, testContext().ctx);

    server.resetHandlers();
    server.use(pagedEndpoint([[customer("cus_1", { email: "new@x.example" })]]));
    const second = await collect(stripeIdentityHandler, testContext().ctx);

    // Contact is unique on (integrationId, externalSourceId): an id derived
    // from the email would re-key the row here, inserting a duplicate person
    // and orphaning the old one rather than failing loudly.
    expect(second.byObject.contact[0]?.["contact_id"]).toBe(
      first.byObject.contact[0]?.["contact_id"]
    );
  });

  it("keeps contact ids stable when the source order changes", async () => {
    const a = customer("cus_a");
    const b = customer("cus_b");

    server.use(pagedEndpoint([[a, b]]));
    const first = await collect(stripeIdentityHandler, testContext().ctx);

    server.resetHandlers();
    server.use(pagedEndpoint([[b, a]]));
    const second = await collect(stripeIdentityHandler, testContext().ctx);

    const ids = (r: typeof first) =>
      r.byObject.contact.map((c) => c["contact_id"]).sort();
    expect(ids(second)).toEqual(ids(first));
  });
});

describe("Stripe created date", () => {
  it("synthesizes an ISO created_at from epoch seconds", async () => {
    server.use(pagedEndpoint([[customer("cus_1", { created: 1_680_893_993 })]]));

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    const createdAt = byObject.customer[0]?.["created_at"];
    expect(createdAt).toBe("2023-04-07T18:59:53.000Z");
    // The whole point: this is what the record writer's date parse receives,
    // and the raw epoch number is not parseable by it.
    expect(Number.isNaN(new Date(String(createdAt)).getTime())).toBe(false);
    expect(Number.isNaN(new Date(String(byObject.customer[0]?.["created"])).getTime())).toBe(
      true
    );
  });

  it("omits created_at rather than writing a blank when created is unusable", async () => {
    server.use(
      pagedEndpoint([
        [customer("cus_1", { created: null }), customer("cus_2", { created: "yesterday" })],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(byObject.customer[0]).not.toHaveProperty("created_at");
    expect(byObject.customer[1]).not.toHaveProperty("created_at");
  });
});

describe("Stripe authentication", () => {
  it("sends the key as a bearer token with the pinned API version", async () => {
    let authorization: string | null = null;
    let version: string | null = null;
    let apiKeyHeader: string | null = null;

    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        authorization = request.headers.get("authorization");
        version = request.headers.get("stripe-version");
        apiKeyHeader = request.headers.get("x-api-key");
        return HttpResponse.json({ has_more: false, data: [] });
      })
    );

    const { ctx } = testContext({ accessToken: "sk_test_abcd1234" });
    await collect(stripeIdentityHandler, ctx);

    expect(authorization).toBe("Bearer sk_test_abcd1234");
    expect(version).toBe("2026-08-26.dahlia");
    expect(apiKeyHeader).toBeNull();
  });
});

describe("Stripe failure policy", () => {
  it("treats a 401 as terminal when refresh is impossible", async () => {
    server.use(http.get(CUSTOMERS, () => new HttpResponse(null, { status: 401 })));

    // No `refresh` — an API key has nothing to exchange, which is exactly what
    // the sync engine arranges for this provider.
    const { ctx } = testContext();
    await expect(collect(stripeIdentityHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });

  it("treats a mid-run 403 as a failed run, not a re-authorization prompt", async () => {
    server.use(http.get(CUSTOMERS, () => new HttpResponse("forbidden", { status: 403 })));

    // A restricted key missing the customer read permission. Documented rather
    // than desirable: the shared client special-cases 401 only, and the remedy
    // is a new key in Stripe's own dashboard either way. `probeCredential`
    // catches this case at connect time, which is where it matters most.
    const { ctx } = testContext();
    await expect(collect(stripeIdentityHandler, ctx)).rejects.toThrow(ProviderHttpError);
  });

  it("waits out a 429 that carries Retry-After and retries the same page", async () => {
    let calls = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "7" },
          });
        }
        return HttpResponse.json({ has_more: false, data: [customer("cus_1")] });
      })
    );

    const { ctx, clock } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    expect(clock.sleeps).toEqual([7000]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("falls back to the configured delay on a 429 with no Retry-After", async () => {
    let calls = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        calls += 1;
        // Stripe generally does not send Retry-After, so this is the realistic
        // case rather than the edge one.
        if (calls === 1) return new HttpResponse(null, { status: 429 });
        return HttpResponse.json({ has_more: false, data: [customer("cus_1")] });
      })
    );

    const { ctx, clock } = testContext();
    const { byObject } = await collect(stripeIdentityHandler, ctx);

    // RATE_LIMIT_FALLBACK_MS, pinned to 1ms in tests/setup.ts.
    expect(clock.sleeps).toEqual([1]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("classifies 5xx as retryable and other 4xx as fatal", async () => {
    server.use(http.get(CUSTOMERS, () => new HttpResponse("boom", { status: 503 })));
    await expect(
      collect(stripeIdentityHandler, testContext().ctx)
    ).rejects.toThrow(RetryableSyncError);

    server.resetHandlers();
    // An unrecognised Stripe-Version is a 400, which is why the version is
    // env-overridable rather than a literal: this failure is not retryable.
    server.use(http.get(CUSTOMERS, () => new HttpResponse("nope", { status: 400 })));
    await expect(
      collect(stripeIdentityHandler, testContext().ctx)
    ).rejects.toThrow(ProviderHttpError);
  });
});

describe("Stripe field discovery", () => {
  it("surfaces account-specific metadata keys alongside the fixed fields", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          has_more: false,
          data: [
            { id: "cus_1", metadata: { arr_band: "growth", csm_owner: "r.okafor" } },
            { id: "cus_2", metadata: { arr_band: "trial" } },
          ],
        })
      )
    );

    const { ctx } = testContext();
    const fields = await stripeFieldDiscovery.discover(ctx, "customer");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("name");
    expect(paths).toContain("created_at");
    expect(paths).toContain("metadata.arr_band");
    expect(paths).toContain("metadata.csm_owner");
    // Deduplicated across the sample, not one entry per record.
    expect(paths.filter((p) => p === "metadata.arr_band")).toHaveLength(1);
  });

  it("warns about the raw created field rather than hiding it", async () => {
    server.use(http.get(CUSTOMERS, () => HttpResponse.json({ has_more: false, data: [] })));

    const { ctx } = testContext();
    const fields = await stripeFieldDiscovery.discover(ctx, "customer");

    // Offered, because a user will look for the field Stripe's own docs name —
    // but labelled, because mapping it stores nothing.
    expect(fields.find((f) => f.path === "created")?.label).toMatch(/created_at instead/);
  });

  it("describes contacts without calling the API", async () => {
    // No msw handler registered: onUnhandledRequest is "error", so a request
    // here would fail the test. Contacts are synthesized, so their shape is
    // known statically.
    const { ctx } = testContext();
    const fields = await stripeFieldDiscovery.discover(ctx, "contact");

    expect(fields.map((f) => f.path)).toContain("contact_name");
  });
});
