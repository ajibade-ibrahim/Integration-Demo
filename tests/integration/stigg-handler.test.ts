/**
 * Stigg handler against a mocked API.
 *
 * Three things here carry most of the risk: the opaque cursor contract (echoed
 * verbatim, with a non-advancing guard), the customers-before-contacts ordering
 * (the contact is derived, so the handler buffers it), and the synthesized
 * contact id (an unstable id silently duplicates every contact on every sync).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stiggIdentityHandler } from "@/core/providers/stigg/identity-handler";
import { stiggFieldDiscovery } from "@/core/providers/stigg/discovery";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const CUSTOMERS = "https://api.stigg.io/api/v1/customers";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["STIGG_PAGE_SIZE"];
});
afterAll(() => {
  server.close();
});

function customer(id: string, name: string, email: string | null = null) {
  return { id, name, email, metadata: { arr_band: "growth" } };
}

describe("Stigg pagination", () => {
  it("follows pagination.next via after and stops when it is null", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        seen.push(after);

        if (after === null) {
          return HttpResponse.json({
            data: [customer("c1", "Alpha"), customer("c2", "Beta")],
            pagination: { next: "cursor-2", prev: null },
          });
        }
        if (after === "cursor-2") {
          return HttpResponse.json({
            data: [customer("c3", "Gamma")],
            pagination: { next: null, prev: "cursor-1" },
          });
        }
        return HttpResponse.json({ data: [], pagination: { next: null } });
      })
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    expect(seen).toEqual([null, "cursor-2"]);
    expect(byObject.customer.map((c) => c["id"])).toEqual(["c1", "c2", "c3"]);
  });

  it("stops rather than looping when the cursor echoes", async () => {
    let requests = 0;
    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        requests += 1;
        // Echoes `after` once there is one, so the second request repeats the
        // cursor it was just handed.
        const after = new URL(request.url).searchParams.get("after");
        return HttpResponse.json({
          data: [customer("c1", "Alpha")],
          pagination: { next: after ?? "cursor-1", prev: null },
        });
      })
    );

    const { ctx } = testContext();
    await collect(stiggIdentityHandler, ctx);

    expect(requests).toBe(2);
  });
});

describe("Stigg contact synthesis", () => {
  it("yields every customer page before any contact page", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [
            customer("c1", "Alpha", "a@x.example"),
            customer("c2", "Beta", "b@x.example"),
          ],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const { pages } = await collect(stiggIdentityHandler, ctx);

    const objects = pages.map((p) => p.object);
    expect(objects.lastIndexOf("customer")).toBeLessThan(
      objects.indexOf("contact")
    );
    expect(objects.filter((o) => o === "customer")).toHaveLength(1);
  });

  it("links each contact to its parent and resolves the reference", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [customer("c1", "Alpha", "a@x.example")],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    expect(byObject.contact).toHaveLength(1);
    const [contact] = byObject.contact;
    expect(contact?.["contact_id"]).toBe("c1:contact");
    expect(contact?.["customer_id"]).toBe("c1");
    expect(stiggIdentityHandler.externalRefsOf(contact!, "contact")).toEqual({
      customer: "c1",
    });
  });

  it("names a nameless customer by its id, and derives its contact", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [customer("c1", "", null)],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    // `Customer.name` is required, so the customer id stands in for a name
    // Stigg did not supply, rather than the record being rejected forever.
    expect(byObject.customer[0]?.["name"]).toBe("c1");
    expect(byObject.contact).toHaveLength(1);
    expect(byObject.contact[0]?.["contact_name"]).toBe("c1");
    expect(byObject.contact[0]?.["customer_name"]).toBe("c1");
  });

  it("prefers the email local part for a contact name over the id fallback", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [customer("c2", "", "billing@acme.example")],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    // The customer is named by its id, but the contact keeps the recognisable
    // mailbox name rather than inheriting the id.
    expect(byObject.customer[0]?.["name"]).toBe("c2");
    expect(byObject.contact[0]?.["contact_name"]).toBe("billing");
  });

  it("flattens the Stripe link onto the customer record", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [
            {
              ...customer("c1", "Alpha", "a@x.example"),
              integrations: [
                { vendorIdentifier: "STRIPE", syncedEntityId: "cus_123" },
              ],
            },
          ],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    expect(byObject.customer[0]?.["stripe_customer_id"]).toBe("cus_123");
  });
});

describe("Stigg authentication", () => {
  it("sends the key as X-API-KEY and no Authorization header", async () => {
    let apiKey: string | null = null;
    let authorization: string | null = null;

    server.use(
      http.get(CUSTOMERS, ({ request }) => {
        apiKey = request.headers.get("x-api-key");
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ data: [], pagination: { next: null } });
      })
    );

    const { ctx } = testContext({ accessToken: "server-abc123" });
    await collect(stiggIdentityHandler, ctx);

    expect(apiKey).toBe("server-abc123");
    expect(authorization).toBeNull();
  });
});

describe("Stigg failure policy", () => {
  it("treats a 401 as terminal and names the API key", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse(null, { status: 401 }))
    );

    // No `refresh` — an API key has nothing to exchange, which is exactly what
    // the sync engine arranges for this provider.
    await expect(
      collect(stiggIdentityHandler, testContext().ctx)
    ).rejects.toThrow(ReauthorizationRequiredError);
    await expect(
      collect(stiggIdentityHandler, testContext().ctx)
    ).rejects.toThrow(/API key/);
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
          data: [customer("c1", "Alpha")],
          pagination: { next: null },
        });
      })
    );

    const { ctx, clock } = testContext();
    const { byObject } = await collect(stiggIdentityHandler, ctx);

    expect(clock.sleeps).toEqual([7000]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("classifies 5xx as retryable and other 4xx as fatal", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse("boom", { status: 503 }))
    );
    await expect(
      collect(stiggIdentityHandler, testContext().ctx)
    ).rejects.toThrow(RetryableSyncError);

    server.resetHandlers();
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse("nope", { status: 400 }))
    );
    await expect(
      collect(stiggIdentityHandler, testContext().ctx)
    ).rejects.toThrow(ProviderHttpError);
  });
});

describe("Stigg field discovery", () => {
  it("describes contacts without calling the API", async () => {
    // No msw handler registered: onUnhandledRequest is "error", so a request
    // here would fail the test. Contacts are synthesized, so their shape is
    // known statically.
    const { ctx } = testContext();
    const fields = await stiggFieldDiscovery.discover(ctx, "contact");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("contact_id");
    expect(paths).toContain("contact_name");
  });

  it("surfaces environment-specific metadata keys alongside the fixed fields", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({
          data: [
            { id: "c1", metadata: { arr_band: "growth", csm_owner: "r.okafor" } },
            { id: "c2", metadata: { arr_band: "trial" } },
          ],
          pagination: { next: null },
        })
      )
    );

    const { ctx } = testContext();
    const fields = await stiggFieldDiscovery.discover(ctx, "customer");
    const paths = fields.map((f) => f.path);

    expect(paths).toContain("billingId");
    expect(paths).toContain("metadata.arr_band");
    expect(paths).toContain("metadata.csm_owner");
    // Deduplicated across the sample, not one entry per record.
    expect(paths.filter((p) => p === "metadata.arr_band")).toHaveLength(1);
  });

  it("returns an empty list for an object Stigg does not serve", async () => {
    const { ctx } = testContext();
    const fields = await stiggFieldDiscovery.discover(ctx, "invoice");
    expect(fields).toEqual([]);
  });
});
