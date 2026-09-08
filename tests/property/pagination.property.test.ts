/**
 * Pagination completeness.
 *
 * The failure this guards against is quiet: an off-by-one in cursor handling
 * drops the last page, and the sync still reports success with slightly fewer
 * records than the org holds. Nobody notices until a customer asks where their
 * data went. Asserting over arbitrary record counts and page sizes — including
 * the awkward ones, empty and exactly-one-page — is how that stays caught.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { hubspotIdentityHandler } from "@/core/providers/hubspot/identity-handler";
import { salesforceIdentityHandler } from "@/core/providers/salesforce/identity-handler";
import { metrifoxIdentityHandler } from "@/core/providers/metrifox/identity-handler";
import { stripeIdentityHandler } from "@/core/providers/stripe/identity-handler";
import { collect, testContext } from "../integration/helpers";

const COMPANIES = "https://api.hubapi.com/crm/v3/objects/companies";
const CONTACTS = "https://api.hubapi.com/crm/v3/objects/contacts";
const INSTANCE = "https://example-org.my.salesforce.com";
const QUERY = INSTANCE + "/services/data/v60.0/query";
const CUSTOMERS = "https://api.metrifox.com/api/v1/customers";
const STRIPE_CUSTOMERS = "https://api.stripe.com/v1/customers";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  delete process.env["METRIFOX_PAGE_SIZE"];
  delete process.env["STRIPE_PAGE_SIZE"];
});
afterAll(() => {
  server.close();
});

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

/** Record counts and page sizes, biased towards the awkward small cases. */
const shape = fc.record({
  count: fc.integer({ min: 0, max: 40 }),
  pageSize: fc.integer({ min: 1, max: 7 }),
});

describe("pagination completeness", () => {
  it("HubSpot: the union of yielded pages is exactly the source set, in order", async () => {
    await fc.assert(
      fc.asyncProperty(shape, async ({ count, pageSize }) => {
        server.resetHandlers();

        const ids = Array.from({ length: count }, (_, i) => "id-" + String(i));
        const pages = chunk(ids, pageSize);

        const serve = (url: string) =>
          http.get(url, ({ request }) => {
            const after = new URL(request.url).searchParams.get("after");
            const index = after === null ? 0 : Number.parseInt(after, 10);
            const hasNext = index + 1 < pages.length;

            return HttpResponse.json({
              results: (pages[index] ?? []).map((id) => ({ id })),
              ...(hasNext
                ? { paging: { next: { after: String(index + 1) } } }
                : {}),
            });
          });

        server.use(serve(COMPANIES), serve(CONTACTS));

        const { ctx } = testContext();
        const { byObject } = await collect(hubspotIdentityHandler, ctx);

        expect(byObject.customer.map((r) => r["id"])).toEqual(ids);
        expect(byObject.contact.map((r) => r["id"])).toEqual(ids);
      }),
      { numRuns: 120 }
    );
  });

  it("Salesforce: following nextRecordsUrl to done yields every record", async () => {
    await fc.assert(
      fc.asyncProperty(shape, async ({ count, pageSize }) => {
        server.resetHandlers();

        const ids = Array.from({ length: count }, (_, i) => "sf-" + String(i));
        const pages = chunk(ids, pageSize);

        const body = (index: number) => {
          const hasMore = index + 1 < pages.length;
          return HttpResponse.json({
            done: !hasMore,
            records: (pages[index] ?? []).map((id) => ({ Id: id })),
            ...(hasMore
              ? {
                  nextRecordsUrl:
                    "/services/data/v60.0/query/cursor-" + String(index + 1),
                }
              : {}),
          });
        };

        server.use(
          http.get(QUERY, () => body(0)),
          http.get(QUERY + "/:cursor", ({ params }) =>
            body(Number.parseInt(String(params["cursor"]).split("-")[1] ?? "0", 10))
          )
        );

        const { ctx } = testContext({ metadata: { instanceUrl: INSTANCE } });
        const { byObject } = await collect(salesforceIdentityHandler, ctx);

        expect(byObject.customer.map((r) => r["Id"])).toEqual(ids);
        expect(byObject.contact.map((r) => r["Id"])).toEqual(ids);
      }),
      { numRuns: 120 }
    );
  });

  it("Metrifox: page-number paging yields every customer, in order", async () => {
    await fc.assert(
      fc.asyncProperty(shape, async ({ count, pageSize }) => {
        server.resetHandlers();
        process.env["METRIFOX_PAGE_SIZE"] = String(pageSize);

        const ids = Array.from({ length: count }, (_, i) => "mf-" + String(i));
        const pages = chunk(ids, pageSize);

        server.use(
          http.get(CUSTOMERS, ({ request }) => {
            const page = Number.parseInt(
              new URL(request.url).searchParams.get("page") ?? "1",
              10
            );
            return HttpResponse.json({
              meta: { next_page: page < pages.length ? page + 1 : null },
              data: (pages[page - 1] ?? []).map((id) => ({
                id,
                contact_people: [],
              })),
            });
          })
        );

        const { ctx } = testContext();
        const { byObject } = await collect(metrifoxIdentityHandler, ctx);

        // Customers only: contacts are re-chunked after buffering, so the
        // page boundaries do not correspond to the source's.
        expect(byObject.customer.map((r) => r["id"])).toEqual(ids);
      }),
      { numRuns: 120 }
    );
  });

  it("Stripe: starting_after paging yields every customer, in order", async () => {
    await fc.assert(
      fc.asyncProperty(shape, async ({ count, pageSize }) => {
        server.resetHandlers();
        process.env["STRIPE_PAGE_SIZE"] = String(pageSize);

        const ids = Array.from({ length: count }, (_, i) => "cus_" + String(i));
        const pages = chunk(ids, pageSize);

        server.use(
          http.get(STRIPE_CUSTOMERS, ({ request }) => {
            const cursor = new URL(request.url).searchParams.get("starting_after");
            // The cursor is the last id of the page before, which is what makes
            // this worth generating over: the handler has to have read that id
            // out of its own previous response correctly.
            const index =
              cursor === null ? 0 : pages.findIndex((page) => page.at(-1) === cursor) + 1;

            return HttpResponse.json({
              object: "list",
              has_more: index < pages.length - 1,
              data: (pages[index] ?? []).map((id) => ({ id, name: id })),
            });
          })
        );

        const { ctx } = testContext();
        const { byObject } = await collect(stripeIdentityHandler, ctx);

        // Customers only: contacts are re-chunked after buffering, so the page
        // boundaries do not correspond to the source's.
        expect(byObject.customer.map((r) => r["id"])).toEqual(ids);
      }),
      { numRuns: 120 }
    );
  });
});
