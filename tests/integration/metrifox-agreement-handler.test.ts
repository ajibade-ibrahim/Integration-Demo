/**
 * Metrifox agreement handler against a mocked API.
 *
 * What only this level can check, and why each case is here:
 *
 *   - the customer-list → per-customer details fan-out, because that is the
 *     only way the public API exposes subscriptions;
 *   - first-wins dedupe across current and history, because the API's own
 *     example repeats the current subscription in its history;
 *   - the `complete` flags. They are what licenses the writer to delete, so
 *     every withheld flag below is a data-loss guard rather than a nicety;
 *   - the all-unusable guard, which is what stops a Metrifox integration that
 *     cannot read details (the built-in fake serves customers only) reporting a
 *     successful zero-agreement sync forever.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { metrifoxAgreementHandler } from "@/core/providers/metrifox/agreement-handler";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const BASE = "https://api.metrifox.com";
const CUSTOMERS = `${BASE}/api/v1/customers`;
const DETAILS = `${BASE}/api/v1/customers/:customerKey/details`;
const SUMMARY = `${BASE}/api/v1/subscriptions/:subscriptionId/v2/entitlements-summary`;

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

function group(current: Record<string, unknown> | null, history: Record<string, unknown>[] = []) {
  return {
    subscription: current,
    subscriptions_history: history,
  };
}

function subscription(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "active",
    plan_name: `Plan ${id}`,
    product_name: "Core",
    offering_key: "off_core",
    starts_at: "2025-01-01T00:00:00.000Z",
    subscription_items: [],
    ...overrides,
  };
}

const MAPPED_ENTITLEMENTS = { agreementEntitlement: ["value"] };

describe("Metrifox agreement fan-out", () => {
  it("pages customers and calls details with the customer key", async () => {
    const keys: string[] = [];

    server.use(
      customersEndpoint([
        [
          { id: "cust_1", customer_key: "KEY-1" },
          { id: "cust_2", customer_key: "KEY-2" },
        ],
      ]),
      http.get(DETAILS, ({ params }) => {
        const key = String(params["customerKey"]);
        keys.push(key);
        return detailsResponse([group(subscription(`sub_${key}`))]);
      })
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(keys).toEqual(["KEY-1", "KEY-2"]);
    expect(byObject.agreement.map((a) => a["id"])).toEqual([
      "sub_KEY-1",
      "sub_KEY-2",
    ]);
    // The customer ref is the list id, not the key.
    expect(
      metrifoxAgreementHandler.externalRefsOf(byObject.agreement[0]!, "agreement")
    ).toEqual({ customer: "cust_1", offering: "off_core" });
  });

  it("follows meta.next_page across customer pages", async () => {
    server.use(
      customersEndpoint([
        [{ id: "cust_1", customer_key: "KEY-1" }],
        [{ id: "cust_2", customer_key: "KEY-2" }],
      ]),
      http.get(DETAILS, ({ params }) =>
        detailsResponse([group(subscription(`sub_${String(params["customerKey"])}`))])
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement).toHaveLength(2);
  });

  it("skips a customer with no list id or customer key", async () => {
    server.use(
      customersEndpoint([
        [
          { id: "", customer_key: "KEY-1" },
          { id: "cust_2", customer_key: "" },
          { id: "cust_3", customer_key: "KEY-3" },
        ],
      ]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_3"))]))
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement.map((a) => a["id"])).toEqual(["sub_3"]);
  });
});

describe("Metrifox current and historical subscriptions", () => {
  it("emits a repeated subscription once, and the current copy wins", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1", { status: "active", plan_name: "Fresh" }), [
            subscription("sub_1", { status: "canceled", plan_name: "Stale" }),
            subscription("sub_2", { status: "cancelled", plan_name: "History" }),
          ]),
        ])
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement.map((a) => a["id"])).toEqual(["sub_1", "sub_2"]);
    const first = byObject.agreement.find((a) => a["id"] === "sub_1");
    // Reading history first would store the stale cancellation.
    expect(first?.["status"]).toBe("active");
    expect(first?.["agreement_name"]).toBe("Fresh");
  });

  it("keeps history from a different product group", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_current")),
          group(null, [subscription("sub_old", { status: "expired" })]),
        ])
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement.map((a) => a["id"])).toEqual([
      "sub_current",
      "sub_old",
    ]);
  });

  it("omits an unknown status but keeps the raw word", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([group(subscription("sub_1", { status: "teleported" }))])
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement[0]?.["status"]).toBeUndefined();
    expect(byObject.agreement[0]?.["raw_status"]).toBe("teleported");
  });
});

describe("Metrifox agreement item completeness", () => {
  it("declares complete when every subscription carried an item array", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(
            subscription("sub_1", {
              subscription_items: [
                {
                  price_option_id: "po_1",
                  source_type: "ProductCatalogues::Offerings::Plan",
                  quantity: 1,
                },
                { price_option_id: "po_2", is_addon: true, quantity: 4 },
              ],
            })
          ),
        ])
      )
    );

    const { ctx } = testContext();
    const { pages, byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreementItem.map((i) => i["item_id"])).toEqual([
      "sub_1:po_1",
      "sub_1:po_2",
    ]);
    expect(byObject.agreementItem[0]?.["item_type"]).toBe("plan");
    expect(byObject.agreementItem[1]?.["item_type"]).toBe("add_on");
    expect(pages.find((p) => p.object === "agreementItem")?.complete).toBe(true);
  });

  it.each([
    ["an absent key", (s: Record<string, unknown>) => {
      const copy = { ...s };
      delete copy["subscription_items"];
      return copy;
    }],
    ["a non-array key", (s: Record<string, unknown>) => ({ ...s, subscription_items: {} })],
  ])("withholds complete for %s", async (_label, mutate) => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([group(mutate(subscription("sub_1")))])
      )
    );

    const { ctx } = testContext();
    const { pages } = await collect(metrifoxAgreementHandler, ctx);

    expect(pages.find((p) => p.object === "agreementItem")?.complete).toBe(false);
  });
});

describe("Metrifox entitlement completeness", () => {
  it("does not call the summary when nothing targets entitlements", async () => {
    let requests = 0;
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(SUMMARY, () => {
        requests += 1;
        return HttpResponse.json({ data: [] });
      })
    );

    const { ctx } = testContext();
    const { pages } = await collect(metrifoxAgreementHandler, ctx);

    expect(requests).toBe(0);
    expect(pages.some((p) => p.object === "agreementEntitlement")).toBe(false);
  });

  it("calls the summary for every emitted subscription and yields an empty complete page", async () => {
    const requested: string[] = [];
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () =>
        detailsResponse([
          group(subscription("sub_1"), [subscription("sub_2")]),
        ])
      ),
      http.get(SUMMARY, ({ params }) => {
        requested.push(String(params["subscriptionId"]));
        return HttpResponse.json({ data: [] });
      })
    );

    const { ctx } = testContext({ sources: MAPPED_ENTITLEMENTS });
    const { pages } = await collect(metrifoxAgreementHandler, ctx);

    expect(requested.sort()).toEqual(["sub_1", "sub_2"]);
    const page = pages.find((p) => p.object === "agreementEntitlement");
    expect(page?.records).toEqual([]);
    // Empty and complete is how "this subscription genuinely has none" is said.
    expect(page?.complete).toBe(true);
  });

  it("flattens returned rows against the subscription they came from", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(SUMMARY, () =>
        HttpResponse.json({
          data: [
            {
              id: "row_1",
              feature_key: "seats",
              purchased_qty: 3,
              usage_limit: null,
              active: true,
            },
          ],
        })
      )
    );

    const { ctx } = testContext({ sources: MAPPED_ENTITLEMENTS });
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreementEntitlement).toHaveLength(1);
    expect(byObject.agreementEntitlement[0]).toMatchObject({
      agreement_id: "sub_1",
      feature_id: "seats",
      value: "3",
      limit_value: "unlimited",
    });
  });

  it("withholds complete for a 404 summary without failing the run", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(SUMMARY, () => new HttpResponse(null, { status: 404 }))
    );

    const { ctx } = testContext({ sources: MAPPED_ENTITLEMENTS });
    const { pages, byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement).toHaveLength(1);
    expect(pages.find((p) => p.object === "agreementEntitlement")?.complete).toBe(false);
  });

  it("withholds complete for a 200 whose data is not an array", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => detailsResponse([group(subscription("sub_1"))])),
      http.get(SUMMARY, () => HttpResponse.json({ data: null }))
    );

    const { ctx } = testContext({ sources: MAPPED_ENTITLEMENTS });
    const { pages } = await collect(metrifoxAgreementHandler, ctx);

    expect(pages.find((p) => p.object === "agreementEntitlement")?.complete).toBe(false);
  });
});

describe("Metrifox agreement failure policy", () => {
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
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement.map((a) => a["id"])).toEqual(["sub_2"]);
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
      )
    );

    const { ctx } = testContext();
    const { byObject } = await collect(metrifoxAgreementHandler, ctx);

    expect(byObject.agreement.map((a) => a["id"])).toEqual(["sub_2"]);
  });

  it("throws when every attempted details call was unusable", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => new HttpResponse(null, { status: 404 }))
    );

    const { ctx } = testContext();
    await expect(collect(metrifoxAgreementHandler, ctx)).rejects.toThrow(
      /no customer details response was usable/
    );
  });

  it("throws when every details payload is malformed", async () => {
    server.use(
      customersEndpoint([[{ id: "cust_1", customer_key: "KEY-1" }]]),
      http.get(DETAILS, () => HttpResponse.json({ data: { subscriptions: null } }))
    );

    const { ctx } = testContext();
    await expect(collect(metrifoxAgreementHandler, ctx)).rejects.toThrow(
      /no customer details response was usable/
    );
  });

  it("does not throw for an account with no customers", async () => {
    server.use(customersEndpoint([[]]));

    const { ctx } = testContext();
    const { pages } = await collect(metrifoxAgreementHandler, ctx);

    expect(pages).toEqual([]);
  });

  it("treats a 401 as terminal", async () => {
    server.use(
      http.get(CUSTOMERS, () => new HttpResponse(null, { status: 401 }))
    );

    const { ctx } = testContext();
    await expect(collect(metrifoxAgreementHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });
});
