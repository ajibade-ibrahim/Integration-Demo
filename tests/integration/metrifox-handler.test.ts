/**
 * Metrifox handler against a mocked API.
 *
 * Two things here are specific to this provider and carry most of the risk:
 * the customers-before-contacts ordering (contacts arrive nested, so the
 * handler has to buffer them), and the synthesized contact ids (an unstable id
 * silently duplicates every contact on every sync rather than erroring).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { metrifoxIdentityHandler } from "@/core/providers/metrifox/identity-handler";
import { metrifoxFieldDiscovery } from "@/core/providers/metrifox/discovery";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const CUSTOMERS = "https://api.metrifox.com/api/v1/customers";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["METRIFOX_PAGE_SIZE"];
});
afterAll(() => {
  server.close();
});

interface Person {
  first_name?: string;
  last_name?: string;
  email_address?: string | null;
  designation?: string | null;
}

function customer(id: string, name: string, people: Person[] = []) {
  return {
    id,
    customer_key: `KEY-${id}`,
    display_name: name,
    website_url: `https://${name.toLowerCase()}.example/pricing`,
    metadata: { arr_band: "growth" },
    contact_people: people.map((p) => ({
      is_primary: false,
      first_name: p.first_name ?? "",
      last_name: p.last_name ?? "",
      email_address: p.email_address ?? null,
      designation: p.designation ?? null,
      department: null,
      phone_number: null,
    })),
  };
}

/** Serve pages keyed on `?page=`, following Metrifox's meta.next_page. */
function pagedEndpoint(pages: unknown[][], seen?: string[]) {
  return http.get(CUSTOMERS, ({ request }) => {
    const url = new URL(request.url);
    seen?.push(url.searchParams.get("page") ?? "(none)");

    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const data = pages[page - 1] ?? [];

    return HttpResponse.json({
      statusCode: 200,
      message: "Customers fetched",
      meta: {
        current_page: page,
        prev_page: page > 1 ? page - 1 : null,
        next_page: page < pages.length ? page + 1 : null,
        per_page: data.length,
        total_pages: pages.length,
        total_records: pages.flat().length,
      },
      data,
    });
  });
}

describe("Metrifox pagination", () => {
  it("follows meta.next_page and stops when it is null", async () => {
    const seen: string[] = [];
    server.use(
      pagedEndpoint(
        [
          [customer("c1", "Alpha"), customer("c2", "Beta")],
          [customer("c3", "Gamma")],
        ],
        seen
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxIdentityHandler, ctx);

    expect(seen).toEqual(["1", "2"]);
    expect(byObject.customer.map((c) => c["id"])).toEqual(["c1", "c2", "c3"]);
  });

  it("stops rather than looping when next_page does not advance", async () => {
    let requests = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        requests += 1;
        return HttpResponse.json({
          meta: { next_page: 1 }, // Echoes the page we just asked for.
          data: [customer("c1", "Alpha")],
        });
      })
    );

    const { ctx } = testContext();
    await collect(metrifoxIdentityHandler, ctx);

    expect(requests).toBe(1);
  });
});

describe("Metrifox contact flattening", () => {
  it("yields every customer page before any contact page", async () => {
    server.use(
      pagedEndpoint([
        [customer("c1", "Alpha", [{ first_name: "Ann", email_address: "a@x.example" }])],
        [customer("c2", "Beta", [{ first_name: "Bob", email_address: "b@x.example" }])],
        [customer("c3", "Gamma", [{ first_name: "Cal", email_address: "c@x.example" }])],
      ])
    );

    const { ctx } = testContext();
    const { pages } = await collect(metrifoxIdentityHandler, ctx);

    // The invariant the record writer depends on: it builds the external→
    // internal customer index from the customer pages, so a contact page
    // arriving early would fail to resolve its association.
    const objects = pages.map((p) => p.object);
    expect(objects.lastIndexOf("customer")).toBeLessThan(
      objects.indexOf("contact")
    );
    expect(objects.filter((o) => o === "customer")).toHaveLength(3);
  });

  it("links each contact to its parent and joins the name", async () => {
    server.use(
      pagedEndpoint([
        [
          customer("c1", "Alpha", [
            {
              first_name: "Dana",
              last_name: "Whitfield",
              email_address: "dana@alpha.example",
              designation: "VP Ops",
            },
          ]),
        ],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxIdentityHandler, ctx);

    expect(byObject.contact).toHaveLength(1);
    const [contact] = byObject.contact;
    expect(contact?.["full_name"]).toBe("Dana Whitfield");
    expect(contact?.["customer_id"]).toBe("c1");
    expect(metrifoxIdentityHandler.externalParentIdOf(contact!, "contact")).toBe("c1");
  });

  it("emits nothing for a customer with no contact people", async () => {
    server.use(pagedEndpoint([[customer("c1", "Alpha", [])]]));

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxIdentityHandler, ctx);

    expect(byObject.customer).toHaveLength(1);
    expect(byObject.contact).toHaveLength(0);
  });

  it("keeps contact ids stable when the source array is reordered", async () => {
    const ann = { first_name: "Ann", email_address: "ann@x.example" };
    const bob = { first_name: "Bob", email_address: "bob@x.example" };

    server.use(pagedEndpoint([[customer("c1", "Alpha", [ann, bob])]]));
    const first = await collect(metrifoxIdentityHandler, testContext().ctx);

    server.resetHandlers();
    server.use(pagedEndpoint([[customer("c1", "Alpha", [bob, ann])]]));
    const second = await collect(metrifoxIdentityHandler, testContext().ctx);

    // Contact is unique on (integrationId, externalSourceId): an id that moved
    // with the array position would insert duplicates on the next sync rather
    // than failing loudly.
    const ids = (r: typeof first) =>
      r.byObject.contact.map((c) => c["contact_id"]).sort();
    expect(ids(second)).toEqual(ids(first));
  });

  it("disambiguates two contact people sharing an email", async () => {
    server.use(
      pagedEndpoint([
        [
          customer("c1", "Alpha", [
            { first_name: "Marcus", email_address: "ap@alpha.example" },
            { first_name: "Priya", email_address: "ap@alpha.example" },
          ]),
        ],
      ])
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxIdentityHandler, ctx);

    const ids = byObject.contact.map((c) => c["contact_id"]);
    expect(new Set(ids).size).toBe(2);
    // First occurrence keeps the clean id, so a later duplicate never
    // destabilises a row that already exists.
    expect(ids[0]).toBe("c1:ap@alpha.example");
    expect(ids[1]).toBe("c1:ap@alpha.example#1");
  });
});

describe("Metrifox authentication", () => {
  it("sends the key as x-api-key and no Authorization header", async () => {
    let apiKey: string | null = null;
    let authorization: string | null = null;

    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        apiKey = request.headers.get("x-api-key");
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ meta: { next_page: null }, data: [] });
      })
    );

    const { ctx } = testContext({ accessToken: "sk_test_abcd1234" });
    await collect(metrifoxIdentityHandler, ctx);

    expect(apiKey).toBe("sk_test_abcd1234");
    expect(authorization).toBeNull();
  });
});

describe("Metrifox failure policy", () => {
  it("treats a 401 as terminal when refresh is impossible", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse(null, { status: 401 }))
    );

    // No `refresh` — an API key has nothing to exchange, which is exactly what
    // the sync engine arranges for this provider.
    const { ctx } = testContext();
    await expect(collect(metrifoxIdentityHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });

  it("waits out a 429 and retries the same page", async () => {
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
        return HttpResponse.json({
          meta: { next_page: null },
          data: [customer("c1", "Alpha")],
        });
      })
    );

    const { ctx, clock } = testContext();
    const { byObject } = await collect(metrifoxIdentityHandler, ctx);

    expect(clock.sleeps).toEqual([7000]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("classifies 5xx as retryable and other 4xx as fatal", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse("boom", { status: 503 }))
    );
    await expect(
      collect(metrifoxIdentityHandler, testContext().ctx)
    ).rejects.toThrow(RetryableSyncError);

    server.resetHandlers();
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse("nope", { status: 400 }))
    );
    await expect(
      collect(metrifoxIdentityHandler, testContext().ctx)
    ).rejects.toThrow(ProviderHttpError);
  });
});

describe("Metrifox field discovery", () => {
  it("surfaces tenant-specific metadata keys alongside the fixed fields", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          meta: { next_page: null },
          data: [
            { id: "c1", metadata: { arr_band: "growth", csm_owner: "r.okafor" } },
            { id: "c2", metadata: { arr_band: "trial" } },
          ],
        })
      )
    );

    const { ctx } = testContext();
    const fields = await metrifoxFieldDiscovery.discover(ctx, "customer");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("display_name");
    expect(paths).toContain("metadata.arr_band");
    expect(paths).toContain("metadata.csm_owner");
    // Deduplicated across the sample, not one entry per record.
    expect(paths.filter((p) => p === "metadata.arr_band")).toHaveLength(1);
  });

  it("describes contacts without calling the API", async () => {
    // No msw handler registered: onUnhandledRequest is "error", so a request
    // here would fail the test. Contacts are synthesized, so their shape is
    // known statically.
    const { ctx } = testContext();
    const fields = await metrifoxFieldDiscovery.discover(ctx, "contact");

    expect(fields.map((f) => f.path)).toContain("full_name");
  });
});
