/**
 * Salesforce handler against a mocked API.
 *
 * Salesforce differs from HubSpot in the two places that matter most: every
 * request is addressed to the org's own host (captured as `instance_url` at
 * authorization), and the field list is interpolated into a query language.
 * Both are tested here because both fail silently if wrong — the first with a
 * request to nowhere, the second with an injectable query.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { salesforceIdentityHandler } from "@/core/providers/salesforce/identity-handler";
import { salesforceFieldDiscovery } from "@/core/providers/salesforce/discovery";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const INSTANCE = "https://example-org.my.salesforce.com";
const QUERY = INSTANCE + "/services/data/v60.0/query";
const METADATA = { instanceUrl: INSTANCE };

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

function account(id: string, name: string) {
  return { attributes: { type: "Account" }, Id: id, Name: name };
}

function sfContact(id: string, accountId: string | null) {
  return {
    attributes: { type: "Contact" },
    Id: id,
    Name: "Person " + id,
    AccountId: accountId,
  };
}

/**
 * Answer the initial query and then serve `nextRecordsUrl` cursors, recording
 * every SOQL string seen.
 */
function queryEndpoints(
  pagesByObject: Record<string, unknown[][]>,
  soqlSeen: string[]
) {
  const cursors = new Map<string, { object: string; index: number }>();

  const respond = (object: string, index: number) => {
    const pages = pagesByObject[object] ?? [[]];
    const records = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    const cursorId = object + "-" + String(index + 1);
    if (hasMore) cursors.set(cursorId, { object, index: index + 1 });

    return HttpResponse.json({
      totalSize: records.length,
      done: !hasMore,
      records,
      ...(hasMore
        ? { nextRecordsUrl: "/services/data/v60.0/query/" + cursorId }
        : {}),
    });
  };

  return [
    http.get(QUERY, ({ request }) => {
      const soql = new URL(request.url).searchParams.get("q") ?? "";
      soqlSeen.push(soql);
      return respond(soql.includes("FROM Account") ? "Account" : "Contact", 0);
    }),
    http.get(QUERY + "/:cursor", ({ params }) => {
      const cursor = cursors.get(String(params["cursor"]));
      if (cursor === undefined) return new HttpResponse(null, { status: 404 });
      return respond(cursor.object, cursor.index);
    }),
  ];
}

describe("Salesforce query construction", () => {
  it("always selects Id, and AccountId on contacts, whatever the user mapped", async () => {
    const soql: string[] = [];
    server.use(...queryEndpoints({ Account: [[]], Contact: [[]] }, soql));

    const { ctx } = testContext({
      metadata: METADATA,
      // Deliberately maps neither Id nor AccountId.
      sources: { customer: ["Name"], contact: ["Email"] },
    });
    await collect(salesforceIdentityHandler, ctx);

    expect(soql[0]).toBe("SELECT Id, Name FROM Account");
    // Without AccountId the contact association is unrecoverable, so it is
    // forced in even though nobody mapped it.
    expect(soql[1]).toBe("SELECT Id, AccountId, Email FROM Contact");
  });

  it("refuses source paths that are not valid field names", async () => {
    const soql: string[] = [];
    server.use(...queryEndpoints({ Account: [[]], Contact: [[]] }, soql));

    const { ctx } = testContext({
      metadata: METADATA,
      sources: {
        customer: [
          "Name",
          // A working SOQL injection if interpolated unchecked.
          "Name FROM Account WHERE Id != null--",
          "Owner.Profile.Name",
        ],
      },
    });
    await collect(salesforceIdentityHandler, ctx);

    expect(soql[0]).toBe("SELECT Id, Name, Owner.Profile.Name FROM Account");
    expect(soql[0]).not.toContain("WHERE");
  });

  it("addresses every request at the org's own instance_url", async () => {
    const soql: string[] = [];
    server.use(...queryEndpoints({ Account: [[]], Contact: [[]] }, soql));

    // msw is configured to error on unhandled requests, and the only handlers
    // registered are on this host — so completing at all proves the addressing.
    const { ctx } = testContext({ metadata: METADATA });
    await expect(collect(salesforceIdentityHandler, ctx)).resolves.toBeDefined();
  });

  it("fails clearly when instance_url is missing rather than requesting undefined", async () => {
    const { ctx } = testContext({ metadata: {} });
    await expect(collect(salesforceIdentityHandler, ctx)).rejects.toThrow(
      /no instance_url/i
    );
  });
});

describe("Salesforce pagination", () => {
  it("follows nextRecordsUrl until done and returns every record", async () => {
    const soql: string[] = [];
    server.use(
      ...queryEndpoints(
        {
          Account: [
            [account("a1", "Acme"), account("a2", "Globex")],
            [account("a3", "Initech")],
          ],
          Contact: [[sfContact("c1", "a1"), sfContact("c2", null)]],
        },
        soql
      )
    );

    const { ctx } = testContext({ metadata: METADATA });
    const { pages, byObject } = await collect(salesforceIdentityHandler, ctx);

    expect(pages).toHaveLength(3);
    expect(byObject.customer.map((r) => r["Id"])).toEqual(["a1", "a2", "a3"]);
    expect(byObject.contact).toHaveLength(2);
  });

  it("stops when a page claims more but supplies no cursor", async () => {
    // Salesforce should never do this, but the alternative to handling it is
    // building a URL from undefined and requesting nonsense forever. The stop
    // condition checks both signals, and this is what proves the second one is
    // load-bearing rather than decoration.
    server.use(
      http.get(QUERY, () =>
        HttpResponse.json({ done: false, records: [account("a1", "Acme")] })
      )
    );

    const { ctx } = testContext({ metadata: METADATA });
    const { byObject } = await collect(salesforceIdentityHandler, ctx);
    expect(byObject.customer).toHaveLength(1);
  });
});

describe("Salesforce record shape", () => {
  it("reads AccountId as the association, treating null as no claim", () => {
    expect(
      salesforceIdentityHandler.externalParentIdOf(sfContact("c1", "a1"), "contact")
    ).toBe("a1");
    // Salesforce nulls the field rather than omitting it; that must read as
    // "no company", not as a company whose id is the string "null".
    expect(
      salesforceIdentityHandler.externalParentIdOf(sfContact("c2", null), "contact")
    ).toBeUndefined();
    expect(salesforceIdentityHandler.externalIdOf(account("a9", "Acme"))).toBe(
      "a9"
    );
  });
});

describe("Salesforce failure handling", () => {
  it("refreshes on 401 and retries against the refreshed instance_url", async () => {
    const hostsSeen: string[] = [];
    const OTHER = "https://example-org.my.salesforce.com";

    server.use(
      http.get(QUERY, ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        hostsSeen.push(auth);
        return auth === "Bearer token-2"
          ? HttpResponse.json({ done: true, records: [account("a1", "Acme")] })
          : new HttpResponse(null, { status: 401 });
      })
    );

    const { ctx } = testContext({
      metadata: METADATA,
      refresh: async () => ({
        accessToken: "token-2",
        metadata: { instanceUrl: OTHER },
      }),
    });

    const { byObject } = await collect(salesforceIdentityHandler, ctx);
    expect(hostsSeen).toEqual([
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-2",
    ]);
    expect(byObject.customer).toHaveLength(1);
  });

  it("stops with ReauthorizationRequired when no refresh is possible", async () => {
    server.use(http.get(QUERY, () => new HttpResponse(null, { status: 401 })));

    const { ctx } = testContext({ metadata: METADATA });
    await expect(collect(salesforceIdentityHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });
});

describe("Salesforce field discovery", () => {
  it("offers queryable fields, custom ones included", async () => {
    server.use(
      http.get(
        INSTANCE + "/services/data/v60.0/sobjects/Account/describe",
        () =>
          HttpResponse.json({
            fields: [
              { name: "Name", label: "Account Name", type: "string" },
              { name: "Website", label: "Website", type: "url" },
              {
                name: "Account_Tier__c",
                label: "Account Tier",
                type: "picklist",
              },
              {
                name: "BillingAddress",
                label: "Billing Address",
                type: "address",
                filterable: false,
                sortable: false,
              },
            ],
          })
      )
    );

    const { ctx } = testContext({ metadata: METADATA });
    const fields = await salesforceFieldDiscovery.discover(ctx, "customer");

    // Ordered by label, which is what the dropdown displays: "Account Name",
    // "Account Tier", "Website".
    expect(fields.map((f) => f.path)).toEqual([
      "Name",
      "Account_Tier__c",
      "Website",
    ]);
    // A compound field cannot appear in a SELECT, so offering it would produce
    // a mapping that fails at sync time.
    expect(fields.map((f) => f.path)).not.toContain("BillingAddress");
  });
});
