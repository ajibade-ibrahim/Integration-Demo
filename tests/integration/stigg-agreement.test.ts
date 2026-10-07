/**
 * Stigg agreement handler against a mocked API.
 *
 * What carries the risk here: the single-endpoint shape (a whole agreement from
 * one list call), the all-statuses filter, the page-level `complete` flags the
 * reconciling writer trusts, and the discount gate.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stiggAgreementHandler } from "@/core/providers/stigg/agreement-handler";
import { stiggFieldDiscovery } from "@/core/providers/stigg/discovery";
import { STIGG_SUBSCRIPTION_STATUSES } from "@/core/providers/stigg/api";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const BASE = "https://api.stigg.io/api/v1";
const SUBSCRIPTIONS = `${BASE}/subscriptions`;

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

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    customerId: "cus-1",
    planId: "plan-pro",
    status: "ACTIVE",
    startDate: "2024-01-01T00:00:00.000Z",
    pricingType: "PAID",
    paymentCollection: "NOT_REQUIRED",
    ...overrides,
  };
}

const ALL_SOURCES = {
  agreement: ["x"],
  subscription: ["x"],
  agreementItem: ["x"],
  agreementDiscount: ["x"],
};

const SUB_1 = subscription({
  prices: [
    { amount: 49, currency: "usd", baseCharge: true },
    { amount: 5, currency: "usd", addonId: "addon-seats" },
  ],
  addons: [
    { id: "addon-seats", quantity: 3 },
    { id: "addon-support", quantity: 1 },
  ],
  coupons: [
    { id: "coup-1", name: "Launch", status: "ACTIVE", percentOff: 20 },
  ],
  currentBillingPeriodStart: "2024-06-01T00:00:00.000Z",
  currentBillingPeriodEnd: "2024-07-01T00:00:00.000Z",
});

const SUB_2 = subscription({
  id: "sub-2",
  customerId: "cus-2",
  planId: "plan-basic",
  status: "CANCELED",
  endDate: "2024-07-05T00:00:00.000Z",
  effectiveEndDate: "2024-07-05T00:00:00.000Z",
  cancellationDate: "2024-06-10T00:00:00.000Z",
  addons: [],
  coupons: [],
  currentBillingPeriodEnd: "2024-07-01T00:00:00.000Z",
});

describe("Stigg agreement happy path", () => {
  it("yields every object per page and links each association", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [SUB_1, SUB_2],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { pages, byObject } = await collect(stiggAgreementHandler, ctx);

    expect(pages.map((p) => p.object)).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
      "agreementDiscount",
    ]);

    expect(byObject.agreement.map((r) => r["id"])).toEqual(["sub-1", "sub-2"]);
    expect(byObject.subscription.map((r) => r["id"])).toEqual(["sub-1", "sub-2"]);

    // Two lines for sub-1 (plan + two addons) and one for sub-2.
    expect(byObject.agreementItem.map((r) => r["item_id"])).toEqual([
      "sub-1:plan",
      "sub-1:addon:addon-seats",
      "sub-1:addon:addon-support",
      "sub-2:plan",
    ]);
    expect(byObject.agreementDiscount.map((r) => r["discount_id"])).toEqual([
      "sub-1:coupon:coup-1",
    ]);

    // Every reference resolves against the ids that were yielded.
    const agreementIds = new Set(byObject.agreement.map((r) => r["id"]));
    for (const item of byObject.agreementItem) {
      const refs = stiggAgreementHandler.externalRefsOf(item, "agreementItem");
      expect(agreementIds.has(refs.agreement)).toBe(true);
    }
    for (const discount of byObject.agreementDiscount) {
      const refs = stiggAgreementHandler.externalRefsOf(
        discount,
        "agreementDiscount",
      );
      expect(agreementIds.has(refs.agreement)).toBe(true);
    }

    // The reconiling writer trusts these, so a well-formed payload must claim
    // completeness.
    expect(pages.find((p) => p.object === "agreementItem")?.complete).toBe(true);
    expect(
      pages.find((p) => p.object === "agreementDiscount")?.complete,
    ).toBe(true);
  });

  it("asks for every subscription status on every request", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(SUBSCRIPTIONS, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("status"));
        return HttpResponse.json({
          data: [SUB_1],
          pagination: { next: null, prev: null },
        });
      }),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    await collect(stiggAgreementHandler, ctx);

    expect(seen).toEqual([STIGG_SUBSCRIPTION_STATUSES.join(",")]);
  });

  it("maps a pending-payment subscription to draft and a canceled one to canceled", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [
            subscription({ id: "sub-pending", status: "PAYMENT_PENDING" }),
            SUB_2,
          ],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { byObject } = await collect(stiggAgreementHandler, ctx);

    const pending = byObject.agreement.find((r) => r["id"] === "sub-pending");
    expect(pending?.["status"]).toBe("draft");
    expect(pending?.["raw_status"]).toBe("PAYMENT_PENDING");

    const canceled = byObject.agreement.find((r) => r["id"] === "sub-2");
    expect(canceled?.["status"]).toBe("canceled");
    expect(canceled?.["end_date"]).toBe("2024-07-05T00:00:00.000Z");
    expect(canceled?.["canceled_at"]).toBe("2024-06-10T00:00:00.000Z");
    expect(canceled?.["cancel_at"]).toBe("2024-07-05T00:00:00.000Z");
  });
});

describe("Stigg agreement pagination", () => {
  it("follows pagination.next via after and stops when it is null", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(SUBSCRIPTIONS, ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        seen.push(after);
        if (after === null) {
          return HttpResponse.json({
            data: [SUB_1],
            pagination: { next: "cursor-2", prev: null },
          });
        }
        return HttpResponse.json({
          data: [SUB_2],
          pagination: { next: null, prev: "cursor-1" },
        });
      }),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { pages, byObject } = await collect(stiggAgreementHandler, ctx);

    expect(seen).toEqual([null, "cursor-2"]);
    expect(byObject.agreement.map((r) => r["id"])).toEqual(["sub-1", "sub-2"]);
    // Four objects per page, two pages.
    expect(pages.map((p) => p.object)).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
      "agreementDiscount",
      "agreement",
      "subscription",
      "agreementItem",
      "agreementDiscount",
    ]);
  });

  it("stops rather than looping when the cursor echoes", async () => {
    let requests = 0;
    server.use(
      http.get(SUBSCRIPTIONS, ({ request }) => {
        requests += 1;
        const after = new URL(request.url).searchParams.get("after");
        return HttpResponse.json({
          data: [SUB_1],
          pagination: { next: after ?? "cursor-1", prev: null },
        });
      }),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    await collect(stiggAgreementHandler, ctx);

    expect(requests).toBe(2);
  });
});

describe("Stigg agreement completeness", () => {
  it("withholds the item page's completeness when addons is absent", async () => {
    const noAddons = subscription({ coupons: [] });
    delete (noAddons as Record<string, unknown>)["addons"];

    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [noAddons],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { pages } = await collect(stiggAgreementHandler, ctx);

    expect(pages.find((p) => p.object === "agreementItem")?.complete).toBe(false);
  });

  it("withholds the discount page's completeness when coupons is absent", async () => {
    const noCoupons = subscription({ addons: [] });
    delete (noCoupons as Record<string, unknown>)["coupons"];

    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [noCoupons],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext({ sources: ALL_SOURCES });
    const { pages } = await collect(stiggAgreementHandler, ctx);

    expect(
      pages.find((p) => p.object === "agreementDiscount")?.complete,
    ).toBe(false);
  });
});

describe("Stigg agreement discount gating", () => {
  it("yields no discount page when nothing targets agreementDiscount", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [SUB_1],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext({
      sources: { agreement: ["x"], subscription: ["x"], agreementItem: ["x"] },
    });
    const { pages } = await collect(stiggAgreementHandler, ctx);

    expect(pages.map((p) => p.object)).not.toContain("agreementDiscount");
    expect(pages.map((p) => p.object)).toContain("agreementItem");
  });
});

describe("Stigg agreement authentication", () => {
  it("treats a 401 as terminal and names the API key", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () => new HttpResponse(null, { status: 401 })),
    );

    await expect(
      collect(stiggAgreementHandler, testContext().ctx),
    ).rejects.toThrow(ReauthorizationRequiredError);
    await expect(
      collect(stiggAgreementHandler, testContext().ctx),
    ).rejects.toThrow(/API key/);
  });
});

describe("Stigg agreement field discovery", () => {
  it("surfaces subscription metadata keys alongside the fixed agreement fields", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        HttpResponse.json({
          data: [subscription({ metadata: { arr_band: "growth" } })],
          pagination: { next: null, prev: null },
        }),
      ),
    );

    const { ctx } = testContext();
    const paths = (await stiggFieldDiscovery.discover(ctx, "agreement")).map(
      (f) => f.path,
    );

    expect(paths).toContain("agreement_name");
    expect(paths).toContain("metadata.arr_band");
  });

  it("describes the children statically, with no request", async () => {
    // No handlers registered: onUnhandledRequest is "error", so a request here
    // would fail the test. These shapes are known statically.
    const { ctx } = testContext();

    const itemPaths = (
      await stiggFieldDiscovery.discover(ctx, "agreementItem")
    ).map((f) => f.path);
    expect(itemPaths).toContain("item_id");
    expect(itemPaths).toContain("unit_price_minor");

    const discountPaths = (
      await stiggFieldDiscovery.discover(ctx, "agreementDiscount")
    ).map((f) => f.path);
    expect(discountPaths).toContain("discount_id");
    expect(discountPaths).toContain("amount_off_minor");

    const subscriptionPaths = (
      await stiggFieldDiscovery.discover(ctx, "subscription")
    ).map((f) => f.path);
    expect(subscriptionPaths).toContain("next_billing_at");
    expect(subscriptionPaths).toContain("collection_method");
  });

  it("returns an empty list for agreement entitlements, which it never yields", async () => {
    const { ctx } = testContext();
    expect(await stiggFieldDiscovery.discover(ctx, "agreementEntitlement")).toEqual(
      [],
    );
  });
});
