/**
 * The Stripe billing handler over a mocked API.
 *
 * Four things here are Stripe-specific and carry the risk:
 *
 *   - the `lines.has_more` fan-out, which is the same truncation hazard as
 *     subscription items and the reason `complete` is withheld when it happens;
 *   - the `invoice_payments` index, the only route from a charge or refund to an
 *     invoice, and the one that degrades to a null link rather than a wrong one;
 *   - that `complete` is set on the invoice-line page and nowhere else;
 *   - that no status filter is sent, because Stripe's invoices and charges
 *     already return every state.
 *
 * Records are built inline rather than imported from the sandbox fixtures, so a
 * demo-data tweak cannot break the suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { stripeBillingHandler } from "@/core/providers/stripe/billing-handler";
import { collect, testContext } from "./helpers";

const INVOICES = "https://api.stripe.com/v1/invoices";
const INVOICE_LINES = "https://api.stripe.com/v1/invoices/:id/lines";
const CHARGES = "https://api.stripe.com/v1/charges";
const REFUNDS = "https://api.stripe.com/v1/refunds";
const INVOICE_PAYMENTS = "https://api.stripe.com/v1/invoice_payments";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  delete process.env["STRIPE_PAGE_SIZE"];
});
afterAll(() => server.close());

function stripeList(data: Array<Record<string, unknown>>, hasMore = false) {
  return HttpResponse.json({ object: "list", has_more: hasMore, data });
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    object: "invoice",
    number: "INV-0001",
    status: "paid",
    currency: "usd",
    customer: "cus_1",
    subtotal: 9900,
    total: 9900,
    amount_due: 0,
    amount_paid: 9900,
    status_transitions: { finalized_at: 1_700_050_000, paid_at: 1_700_060_000 },
    lines: { object: "list", has_more: false, data: [line()] },
    metadata: {},
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: "il_1",
    object: "line_item",
    invoice: "in_1",
    amount: 9900,
    description: "Analytics Pro",
    quantity: 1,
    period: { start: 1_700_000_000, end: 1_702_678_400 },
    pricing: { unit_amount_decimal: "9900" },
    price: { id: "price_monthly", product: "prod_widget" },
    parent: { invoice_item_details: { proration: false } },
    metadata: {},
    ...overrides,
  };
}

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch_1",
    object: "charge",
    amount: 9900,
    currency: "usd",
    status: "succeeded",
    customer: "cus_1",
    created: 1_700_060_000,
    balance_transaction: "txn_1",
    payment_method_details: { type: "card" },
    payment_intent: "pi_1",
    refunded: false,
    disputed: false,
    metadata: {},
    ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: "re_1",
    object: "refund",
    amount: 4900,
    currency: "usd",
    status: "succeeded",
    created: 1_700_100_000,
    balance_transaction: "txn_2",
    payment_intent: "pi_1",
    metadata: {},
    ...overrides,
  };
}

/** Contexts that request exactly the objects a test arranges, no more. */
const invoiceCtx = () =>
  testContext({ sources: { invoice: ["number"] } }).ctx;
const lineCtx = () =>
  testContext({ sources: { invoice: ["number"], invoiceLine: ["amount"] } }).ctx;
const paymentCtx = () =>
  testContext({ sources: { payment: ["kind"] } }).ctx;

describe("invoice pagination", () => {
  it("follows starting_after and stops when has_more is false", async () => {
    const seen: string[] = [];
    server.use(
      http.get(INVOICES, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        seen.push(cursor ?? "(none)");
        return cursor === null
          ? stripeList([invoice({ id: "in_1" })], true)
          : stripeList([invoice({ id: "in_2" })]);
      })
    );

    const { byObject } = await collect(stripeBillingHandler, invoiceCtx());

    expect(seen).toEqual(["(none)", "in_1"]);
    expect(byObject.invoice.map((r) => r["id"])).toEqual(["in_1", "in_2"]);
  });

  it("sends no status filter, because Stripe needs none here", async () => {
    const queries: string[] = [];
    server.use(
      http.get(INVOICES, ({ request }) => {
        queries.push(new URL(request.url).search);
        return stripeList([invoice()]);
      })
    );

    await collect(stripeBillingHandler, invoiceCtx());

    // Unlike `/v1/subscriptions`, which needs `status=all`. Asserting the
    // absence is the point: a future reader will assume the opposite.
    expect(queries.every((q) => !q.includes("status="))).toBe(true);
  });
});

describe("completing an invoice's lines", () => {
  it("pages the lines endpoint when lines.has_more is set", async () => {
    const linesQueries: string[] = [];
    server.use(
      http.get(INVOICES, () =>
        stripeList([
          invoice({
            lines: {
              object: "list",
              has_more: true,
              data: [line({ id: "il_1" })],
            },
          }),
        ])
      ),
      http.get(INVOICE_LINES, ({ request }) => {
        linesQueries.push(new URL(request.url).search);
        return stripeList([line({ id: "il_2" })]);
      })
    );

    const { byObject, pages } = await collect(stripeBillingHandler, lineCtx());

    // The starting cursor is the last inlined line, not nothing — re-fetching
    // from the top would duplicate the first ten into the result.
    expect(linesQueries[0]).toContain("starting_after=il_1");
    expect(byObject.invoiceLine.map((r) => r["id"])).toEqual(["il_1", "il_2"]);

    // `complete` is true on the line page and nowhere else.
    const linePage = pages.find((p) => p.object === "invoiceLine");
    expect(linePage?.complete).toBe(true);
    expect(pages.find((p) => p.object === "invoice")?.complete).toBeUndefined();
  });

  it("declares complete and makes no extra request when lines are whole", async () => {
    let linesRequests = 0;
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_LINES, () => {
        linesRequests += 1;
        return stripeList([]);
      })
    );

    const { pages } = await collect(stripeBillingHandler, lineCtx());

    expect(linesRequests).toBe(0);
    expect(pages.find((p) => p.object === "invoiceLine")?.complete).toBe(true);
  });
});

describe("linking payments to invoices through the index", () => {
  it("links a charge whose payment intent is in the index", async () => {
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_PAYMENTS, () =>
        stripeList([
          {
            id: "inpay_1",
            object: "invoice_payment",
            invoice: "in_1",
            payment: { type: "payment_intent", payment_intent: "pi_1" },
          },
        ])
      ),
      http.get(CHARGES, () => stripeList([charge()])),
      http.get(REFUNDS, () => stripeList([]))
    );

    const { byObject } = await collect(stripeBillingHandler, paymentCtx());

    const payment = byObject.payment.find((r) => r["id"] === "ch_1");
    expect(payment?.["kind"]).toBe("payment");
    expect(payment?.["method"]).toBe("card");
    // The link is here only because the index supplied it — a charge carries no
    // invoice field of its own.
    expect(payment?.["invoice_id"]).toBe("in_1");
  });

  it("leaves the link absent, never guessed, when the intent is not in the index", async () => {
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_PAYMENTS, () => stripeList([])),
      http.get(CHARGES, () => stripeList([charge({ payment_intent: "pi_orphan" })])),
      http.get(REFUNDS, () => stripeList([]))
    );

    const { byObject } = await collect(stripeBillingHandler, paymentCtx());
    const payment = byObject.payment.find((r) => r["id"] === "ch_1");

    expect("invoice_id" in (payment ?? {})).toBe(false);
    // And the handler reports no invoice ref, which is what makes the writer
    // warn and leave the link null rather than fabricate one.
    expect(
      stripeBillingHandler.externalRefsOf(payment ?? {}, "payment")
    ).toEqual({ invoice: undefined, customer: "cus_1" });
  });

  it("yields refunds as payments of kind refund", async () => {
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_PAYMENTS, () =>
        stripeList([
          {
            id: "inpay_1",
            invoice: "in_1",
            payment: { payment_intent: "pi_1" },
          },
        ])
      ),
      http.get(CHARGES, () => stripeList([])),
      http.get(REFUNDS, () => stripeList([refund()]))
    );

    const { byObject } = await collect(stripeBillingHandler, paymentCtx());
    const payment = byObject.payment.find((r) => r["id"] === "re_1");

    expect(payment?.["kind"]).toBe("refund");
    expect(payment?.["status"]).toBe("refunded");
    expect(payment?.["invoice_id"]).toBe("in_1");
  });

  it("pages charges and refunds independently", async () => {
    const chargeCursors: string[] = [];
    const refundCursors: string[] = [];
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_PAYMENTS, () => stripeList([])),
      http.get(CHARGES, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        chargeCursors.push(cursor ?? "(none)");
        return cursor === null
          ? stripeList([charge({ id: "ch_1" })], true)
          : stripeList([charge({ id: "ch_2", payment_intent: "pi_2" })]);
      }),
      http.get(REFUNDS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        refundCursors.push(cursor ?? "(none)");
        return cursor === null
          ? stripeList([refund({ id: "re_1" })], true)
          : stripeList([refund({ id: "re_2", payment_intent: "pi_2" })]);
      })
    );

    const { byObject } = await collect(stripeBillingHandler, paymentCtx());

    // Two independent lists, each paginated on its own cursor.
    expect(chargeCursors).toEqual(["(none)", "ch_1"]);
    expect(refundCursors).toEqual(["(none)", "re_1"]);
    expect(byObject.payment.map((r) => r["id"])).toEqual([
      "ch_1",
      "ch_2",
      "re_1",
      "re_2",
    ]);
  });
});

describe("pass gating", () => {
  it("does not fetch payments when only invoices are requested", async () => {
    let paymentRequests = 0;
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_PAYMENTS, () => {
        paymentRequests += 1;
        return stripeList([]);
      }),
      http.get(CHARGES, () => {
        paymentRequests += 1;
        return stripeList([]);
      })
    );

    const onlyInvoices = testContext({ sources: { invoice: ["number"] } }).ctx;
    await collect(stripeBillingHandler, onlyInvoices);

    expect(paymentRequests).toBe(0);
  });

  it("fetches invoices when only lines are requested, to attach them", async () => {
    server.use(
      http.get(INVOICES, () => stripeList([invoice()])),
      http.get(INVOICE_LINES, () => stripeList([]))
    );

    const onlyLines = testContext({
      sources: { invoiceLine: ["amount"] },
    }).ctx;
    const { byObject, pages } = await collect(stripeBillingHandler, onlyLines);

    expect(byObject.invoiceLine.length).toBe(1);
    // The invoice itself is not yielded, because it is not mapped.
    expect(pages.some((p) => p.object === "invoice")).toBe(false);
  });
});
