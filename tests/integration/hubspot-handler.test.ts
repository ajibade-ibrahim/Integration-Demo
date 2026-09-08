/**
 * HubSpot handler against a mocked API.
 *
 * These cover what only goes wrong against a real provider: cursor pagination,
 * association shape, and the four HTTP failure modes. They are the reason the
 * shared client exists.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { hubspotIdentityHandler } from "@/core/providers/hubspot/identity-handler";
import { hubspotFieldDiscovery } from "@/core/providers/hubspot/discovery";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const COMPANIES = "https://api.hubapi.com/crm/v3/objects/companies";
const CONTACTS = "https://api.hubapi.com/crm/v3/objects/contacts";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function company(id: string, name: string) {
  return { id, properties: { name, domain: name.toLowerCase() + ".com" } };
}

function contact(id: string, companyId?: string) {
  return {
    id,
    properties: { firstname: "Person " + id, email: "p" + id + "@example.com" },
    ...(companyId === undefined
      ? {}
      : {
          associations: {
            companies: {
              results: [{ id: companyId, type: "contact_to_company" }],
            },
          },
        }),
  };
}

/** Serve pages in order, following HubSpot's paging.next.after cursor. */
function pagedEndpoint(url: string, pages: unknown[][], seen?: string[]) {
  return http.get(url, ({ request }) => {
    const parsed = new URL(request.url);
    seen?.push(parsed.search);

    const after = parsed.searchParams.get("after");
    const index = after === null ? 0 : Number.parseInt(after, 10);
    const results = pages[index] ?? [];
    const hasNext = index + 1 < pages.length;

    return HttpResponse.json({
      results,
      ...(hasNext ? { paging: { next: { after: String(index + 1) } } } : {}),
    });
  });
}

describe("HubSpot pagination", () => {
  it("follows the cursor to the end and returns the union of all pages", async () => {
    server.use(
      pagedEndpoint(COMPANIES, [
        [company("1", "Acme"), company("2", "Globex")],
        [company("3", "Initech")],
        [company("4", "Umbrella")],
      ]),
      pagedEndpoint(CONTACTS, [[contact("c1", "1"), contact("c2", "3")]])
    );

    const { ctx } = testContext();
    const { pages, byObject } = await collect(hubspotIdentityHandler, ctx);

    // Three company pages plus one contact page — the cursor, not a count,
    // decides when to stop.
    expect(pages).toHaveLength(4);
    expect(byObject.customer.map((c) => c["id"])).toEqual(["1", "2", "3", "4"]);
    expect(byObject.contact).toHaveLength(2);
  });

  it("stops if the provider echoes the same cursor rather than looping forever", async () => {
    server.use(
      http.get(COMPANIES, () =>
        HttpResponse.json({
          results: [company("1", "Acme")],
          paging: { next: { after: "stuck" } },
        })
      ),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );

    // A repeated cursor would otherwise page indefinitely; the guard turns it
    // into a two-request stop.
    const { ctx } = testContext();
    const { byObject } = await collect(hubspotIdentityHandler, ctx);
    expect(byObject.customer).toHaveLength(2);
  });

  it("requests only mapped properties, and associations only on contacts", async () => {
    const companyQueries: string[] = [];
    const contactQueries: string[] = [];

    server.use(
      pagedEndpoint(COMPANIES, [[company("1", "Acme")]], companyQueries),
      pagedEndpoint(CONTACTS, [[contact("c1", "1")]], contactQueries)
    );

    const { ctx } = testContext({
      sources: {
        customer: ["properties.name", "properties.domain"],
        contact: ["properties.email", "id"],
      },
    });
    await collect(hubspotIdentityHandler, ctx);

    expect(companyQueries[0]).toContain("properties=domain%2Cname");
    expect(companyQueries[0]).not.toContain("associations");

    // `id` is not a property, so it must not reach the properties list.
    expect(contactQueries[0]).toContain("properties=email");
    expect(contactQueries[0]).toContain("associations=companies");
  });
});

describe("HubSpot record shape", () => {
  it("reads the association as the contact's company id", () => {
    expect(
      hubspotIdentityHandler.externalCustomerIdOf(contact("c1", "42"))
    ).toBe("42");
    expect(
      hubspotIdentityHandler.externalCustomerIdOf(contact("c2"))
    ).toBeUndefined();
    expect(hubspotIdentityHandler.externalIdOf(company("7", "Acme"))).toBe("7");
  });
});

describe("HubSpot failure handling", () => {
  it("waits the Retry-After interval on 429 and resumes at the same cursor", async () => {
    let attempts = 0;
    server.use(
      http.get(COMPANIES, () => {
        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "7" },
          });
        }
        return HttpResponse.json({ results: [company("1", "Acme")] });
      }),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );

    const { ctx, clock } = testContext();
    const { byObject } = await collect(hubspotIdentityHandler, ctx);

    expect(clock.sleeps).toEqual([7000]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("falls back to the configured wait when 429 carries no Retry-After", async () => {
    const previous = process.env["RATE_LIMIT_FALLBACK_MS"];
    process.env["RATE_LIMIT_FALLBACK_MS"] = "45000";

    try {
      let attempts = 0;
      server.use(
        http.get(COMPANIES, () => {
          attempts += 1;
          return attempts === 1
            ? new HttpResponse(null, { status: 429 })
            : HttpResponse.json({ results: [company("1", "Acme")] });
        }),
        http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
      );

      const { ctx, clock } = testContext();
      await collect(hubspotIdentityHandler, ctx);
      expect(clock.sleeps).toEqual([45_000]);
    } finally {
      if (previous === undefined) delete process.env["RATE_LIMIT_FALLBACK_MS"];
      else process.env["RATE_LIMIT_FALLBACK_MS"] = previous;
    }
  });

  it("gives up inline after a bounded number of 429s, handing back to the run retry", async () => {
    server.use(
      http.get(COMPANIES, () => new HttpResponse(null, { status: 429 })),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );

    const { ctx, clock } = testContext();
    await expect(collect(hubspotIdentityHandler, ctx)).rejects.toThrow(
      RetryableSyncError
    );
    // Bounded: two waits, then escalate rather than absorbing it forever.
    expect(clock.sleeps).toHaveLength(2);
  });

  it("refreshes on 401 and retries the same request with the new token", async () => {
    const tokensSeen: string[] = [];
    let refreshCalls = 0;

    server.use(
      http.get(COMPANIES, ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        tokensSeen.push(auth);
        return auth === "Bearer token-2"
          ? HttpResponse.json({ results: [company("1", "Acme")] })
          : new HttpResponse(null, { status: 401 });
      }),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );

    const { ctx } = testContext({
      refresh: async () => {
        refreshCalls += 1;
        return { accessToken: "token-2", metadata: {} };
      },
    });

    const { byObject } = await collect(hubspotIdentityHandler, ctx);

    expect(refreshCalls).toBe(1);
    expect(tokensSeen).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("stops with ReauthorizationRequired when a 401 survives the refresh", async () => {
    server.use(
      http.get(COMPANIES, () => new HttpResponse(null, { status: 401 })),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );

    const { ctx } = testContext({
      refresh: async () => ({ accessToken: "token-2", metadata: {} }),
    });

    // Not retryable: no amount of waiting revives a revoked grant.
    await expect(collect(hubspotIdentityHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });

  it("treats 5xx as retryable and 4xx as fatal", async () => {
    server.use(
      http.get(
        COMPANIES,
        () => new HttpResponse("upstream boom", { status: 503 })
      ),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );
    const first = testContext();
    await expect(collect(hubspotIdentityHandler, first.ctx)).rejects.toThrow(
      RetryableSyncError
    );

    server.resetHandlers();
    server.use(
      http.get(COMPANIES, () => new HttpResponse("bad request", { status: 400 })),
      http.get(CONTACTS, () => HttpResponse.json({ results: [] }))
    );
    const second = testContext();
    await expect(collect(hubspotIdentityHandler, second.ctx)).rejects.toThrow(
      ProviderHttpError
    );
  });
});

describe("HubSpot field discovery", () => {
  it("maps properties to source paths and drops what cannot be mapped", async () => {
    server.use(
      http.get("https://api.hubapi.com/crm/v3/properties/companies", () =>
        HttpResponse.json({
          results: [
            { name: "domain", label: "Company Domain Name", type: "string" },
            {
              name: "hs_object_id",
              label: "Record ID",
              type: "number",
              hidden: true,
            },
            {
              name: "num_employees",
              label: "Employees",
              type: "number",
              calculated: true,
            },
            { name: "account_tier", label: "Account Tier", type: "enumeration" },
          ],
        })
      )
    );

    const { ctx } = testContext();
    const fields = await hubspotFieldDiscovery.discover(ctx, "customer");

    expect(fields.map((f) => f.path)).toEqual([
      "properties.account_tier",
      "properties.domain",
    ]);
    expect(fields[0]?.label).toBe("Account Tier");
  });
});
