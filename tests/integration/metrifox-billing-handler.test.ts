/**
 * Metrifox billing handler against a mocked API.
 *
 * What only this level can check, and why each case is here:
 *
 *   - the customers → details → billing-history fan-out, because the public API
 *     has no invoice list and no invoice read;
 *   - first-wins dedupe of subscriptions and invoices. The API's billing history
 *     is per subscription, so the same invoice can arrive more than once and
 *     must be written and linked once;
 *   - the two all-unusable guards. They are what stop a Metrifox integration
 *     that cannot read details (the built-in fake serves customers only) or
 *     billing history reporting a successful zero-invoice sync forever;
 *   - `data: []`, which is a genuine empty history rather than a failure.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { metrifoxBillingHandler } from "@/core/providers/metrifox/billing-handler";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const BASE = "https://api.metrifox.com";
const CUSTOMERS = `${BASE}/api/v1/customers`;
const DETAILS = `${BASE}/api/v1/customers/:customerKey/details`;
const HISTORY = `${BASE}/api/v1/subscriptions/:subscriptionId/billing-history`;

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

interface CustomerRow {
  id: string;
  customer_key: string;
}

function customersEndpoint(pages: CustomerRow[][]) {
  return http.get(CUSTOMERS, ({ request }) => {
    const page = Number.parseInt(
      new URL(request.url).searchParams.get("page") ?? "1",
      10
    );
    return HttpResponse.json({
      meta: { next_page: page < pages.length ? page + 1 : null },
      data: pages[page - 1] ?? [],
    });
  });
}

function detailsResponse(groups: unknown[]) {
  return HttpResponse.json({ data: { subscriptions: groups } });
}

function group(
  current: Record<string, unknown> | null,
  history: Record<string, unknown>[] = []
) {
  return {
    subscription: current,
    subscriptions_history: history,
  };
}

function subscription(id: string) {
  return { id, status: "active" };
}

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: id,
    invoice_number: `NUM-${id}`,
    status: "paid",
    currency: "USD",
    total_amount: 21,
    amount_paid: 21,
    balance_due: 0,
    issued_date: "2025-03-01T00:00:00.000Z",
    due_date: "2025-03-31T00:00:00.000Z",
    ...overrides,
  };
}

function historyResponse(rows: unknown[]) {
  return HttpResponse.json({ data: rows });
}

const mapped = () => testContext({ sources: { invoice: ["number"] } }).ctx;

describe("Metrifox billing fan-out", () => {
  it("pages customers and calls details and billing history with encoded ids", async () => {
    const detailsUrls: string[] = [];
    const historyUrls: string[] = [];

    server.use(
      customersEndpoint([
        [
          { id: "cust_1", customer_key: "KEY/1 test" },
          { id: "cust_2", customer_key: "KEY-2" },
        ],
      ]),
      http.get(DETAILS, ({ params, request }) => {
        detailsUrls.push(request.url);
        const key = String(params["customerKey"]);
        return detailsResponse([group(subscription(`sub/${key}`))]);
      }),
      http.get(HISTORY, ({ params, request }) => {
        historyUrls.push(request.url);
        const id = String(params["subscriptionId"]);
        return historyResponse([invoice(`inv_${id}`)]);
      })
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(detailsUrls).toHaveLength(2);
    expect(detailsUrls[0]).toContain(
      "/api/v1/customers/KEY%2F1%20test/details"
    );
    expect(historyUrls).toHaveLength(2);
    expect(historyUrls[0]).toContain(
      "/api/v1/subscriptions/sub%2FKEY%2F1%20test/billing-history"
    );
    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual([
      "inv_sub/KEY/1 test",
      "inv_sub/KEY-2",
    ]);
  });

  it("follows meta.next_page across customer pages", async () => {
    server.use(
      customersEndpoint([
        [{ id: "cust_1", customer_key: "KEY-1" }],
        [{ id: "cust_2", customer_key: "KEY-2" }],
      ]),
      http.get(DETAILS, ({ params }) =>
        detailsResponse([group(subscription(`sub_${String(params["customerKey"])}`))])
      ),
      http.get(HISTORY, ({ params }) =>
        historyResponse([invoice(`inv_${String(params["subscriptionId"])}`)])
      )
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice).toHaveLength(2);
  });

  it("does nothing when no invoice target is mapped", async () => {
    let customerRequests = 0;
    server.use(
      http.get(CUSTOMERS, () => {
        customerRequests += 1;
        return HttpResponse.json({ meta: { next_page: null }, data: [] });
      })
    );

    const { ctx } = testContext();
    const { pages } = await collect(metrifoxBillingHandler, ctx);

    expect(customerRequests).toBe(0);
    expect(pages).toEqual([]);
  });
});

describe("Metrifox subscription and invoice dedupe", () => {
  it("fetches a subscription repeated in history once", async () => {
    const requested: string[] = [];

    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1"), [
            subscription("sub_1"),
            subscription("sub_2"),
          ]),
        ])
      ),
      http.get(HISTORY, ({ params }) => {
        const id = String(params["subscriptionId"]);
        requested.push(id);
        return historyResponse([invoice(`inv_${id}`)]);
      })
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(requested).toEqual(["sub_1", "sub_2"]);
    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual([
      "inv_sub_1",
      "inv_sub_2",
    ]);
  });

  it("emits a repeated invoice once, linked to the first subscription observed", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1")),
          group(null, [subscription("sub_2")]),
        ])
      ),
      http.get(HISTORY, () => historyResponse([invoice("inv_shared")]))
    );

    const { byObject, pages } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice).toHaveLength(1);
    expect(byObject.invoice[0]?.["invoice_id"]).toBe("inv_shared");
    // sub_1 is the current subscription of the first group, so it wins.
    expect(
      metrifoxBillingHandler.externalRefsOf(byObject.invoice[0] ?? {}, "invoice")
    ).toMatchObject({ customer: "cust_1", agreement: "sub_1" });
    // One page for the customer that produced a new invoice.
    expect(pages).toHaveLength(1);
  });

  it("skips a subscription with no id", async () => {
    let historyRequests = 0;

    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group({ status: "active" }),
          group(subscription("sub_2")),
        ])
      ),
      http.get(HISTORY, () => {
        historyRequests += 1;
        return historyResponse([invoice("inv_1")]);
      })
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(historyRequests).toBe(1);
    expect(byObject.invoice).toHaveLength(1);
  });
});

describe("Metrifox billing details failure policy", () => {
  it("skips a customer whose details call 404s", async () => {
    server.use(
      customersEndpoint([
        [
          { id: "cust_1", customer_key: "KEY-1" },
          { id: "cust_2", customer_key: "KEY-2" },
        ],
      ]),
      http.get(DETAILS, ({ params }) =>
        String(params["customerKey"]) === "KEY-1"
          ? new HttpResponse(null, { status: 404 })
          : detailsResponse([group(subscription("sub_2"))])
      ),
      http.get(HISTORY, () => historyResponse([invoice("inv_2")]))
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual(["inv_2"]);
  });

  it("skips a customer whose subscriptions value is not an array", async () => {
    server.use(
      customersEndpoint([
        [
          { id: "cust_1", customer_key: "KEY-1" },
          { id: "cust_2", customer_key: "KEY-2" },
        ],
      ]),
      http.get(DETAILS, ({ params }) =>
        String(params["customerKey"]) === "KEY-1"
          ? HttpResponse.json({ data: { subscriptions: {} } })
          : detailsResponse([group(subscription("sub_2"))])
      ),
      http.get(HISTORY, () => historyResponse([invoice("inv_2")]))
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual(["inv_2"]);
  });

  it("throws when every attempted details call was unusable", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => new HttpResponse(null, { status: 404 }))
    );

    await expect(
      collect(metrifoxBillingHandler, mapped())
    ).rejects.toThrow(/no customer details response was usable/);
  });

  it("does not throw when the account has no customers", async () => {
    server.use(customersEndpoint([[]]));

    const { pages } = await collect(metrifoxBillingHandler, mapped());

    expect(pages).toEqual([]);
  });

  it("does not throw when a customer has no subscriptions at all", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([]))
    );

    const { pages } = await collect(metrifoxBillingHandler, mapped());

    expect(pages).toEqual([]);
  });
});

describe("Metrifox billing history failure policy", () => {
  it("skips a subscription whose history call 404s", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1"), [subscription("sub_2")]),
        ])
      ),
      http.get(HISTORY, ({ params }) =>
        String(params["subscriptionId"]) === "sub_1"
          ? new HttpResponse(null, { status: 404 })
          : historyResponse([invoice("inv_2")])
      )
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual(["inv_2"]);
  });

  it("skips a subscription whose data is not an array", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1"), [subscription("sub_2")]),
        ])
      ),
      http.get(HISTORY, ({ params }) =>
        String(params["subscriptionId"]) === "sub_1"
          ? HttpResponse.json({ data: null })
          : historyResponse([invoice("inv_2")])
      )
    );

    const { byObject } = await collect(metrifoxBillingHandler, mapped());

    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual(["inv_2"]);
  });

  it("throws when every attempted history response was unusable", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(HISTORY, () => HttpResponse.json({ data: {} }))
    );

    await expect(
      collect(metrifoxBillingHandler, mapped())
    ).rejects.toThrow(/no billing-history response was usable/);
  });

  it("treats data: [] as a successful empty history", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(HISTORY, () => historyResponse([]))
    );

    const { pages } = await collect(metrifoxBillingHandler, mapped());

    expect(pages).toEqual([]);
  });

  it("treats a draft-only history as usable and yields nothing", async () => {
    // Drafts are ignored, not treated as malformed rows. A subscription with
    // nothing but drafts must not trip the all-unusable guard.
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(HISTORY, () =>
        historyResponse([
          invoice("inv_draft", { status: "draft" }),
          invoice("inv_draft_2", { status: "Draft" }),
        ])
      )
    );

    const { pages } = await collect(metrifoxBillingHandler, mapped());

    expect(pages).toEqual([]);
  });

  it("treats a 401 as terminal", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse(null, { status: 401 }))
    );

    await expect(
      collect(metrifoxBillingHandler, mapped())
    ).rejects.toThrow(ReauthorizationRequiredError);
  });
});

describe("Metrifox billing output shape", () => {
  it("yields invoice pages only, with no completeness flags", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(HISTORY, () =>
        historyResponse([
          invoice("inv_1"),
          invoice("inv_draft", { status: "draft" }),
          invoice("inv_2", { status: "open" }),
        ])
      )
    );

    const { pages, byObject } = await collect(
      metrifoxBillingHandler,
      mapped()
    );

    expect(pages.map((p) => p.object)).toEqual(["invoice"]);
    expect(pages.every((p) => p.complete === undefined)).toBe(true);
    // The draft is ignored rather than written.
    expect(byObject.invoice.map((r) => r["invoice_id"])).toEqual([
      "inv_1",
      "inv_2",
    ]);
    expect(byObject.invoiceLine).toEqual([]);
    expect(byObject.payment).toEqual([]);
  });

  it("keeps a row with no invoice_id out of the page", async () => {
    let historyRequests = 0;

    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1"), [subscription("sub_2")]),
        ])
      ),
      http.get(HISTORY, () => {
        historyRequests += 1;
        // A non-empty array whose only row lacks the documented key.
        return historyResponse([{ id: "not-an-invoice" }]);
      })
    );

    await expect(
      collect(metrifoxBillingHandler, mapped())
    ).rejects.toThrow(/no billing-history response was usable/);
    expect(historyRequests).toBe(2);
  });
});
