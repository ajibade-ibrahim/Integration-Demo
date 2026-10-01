/**
 * The Chargebee billing handler over a mocked API.
 *
 * The cases that only this level exercises:
 *
 *   - the `line_items` key-presence gate. An absent key reads as "this invoice
 *     has no lines", which is why the line page withholds completeness rather
 *     than deleting every line of every invoice written this run;
 *   - consolidated invoicing, where the invoice must stay unlinked and say so;
 *   - a page mixing `payment`, `refund` and `authorization` transactions, where
 *     the authorization must not become a `payment` row;
 *   - offset pagination over both endpoints.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { chargebeeBillingHandler } from "@/core/providers/chargebee/billing-handler";
import { collect, testContext } from "./helpers";

const SITE = "acme-test";
const INVOICES = `https://${SITE}.chargebee.com/api/v2/invoices`;
const TRANSACTIONS = `https://${SITE}.chargebee.com/api/v2/transactions`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function envelope(
  entity: "invoice" | "transaction",
  records: Array<Record<string, unknown>>,
  nextOffset = ""
) {
  return { list: records.map((record) => ({ [entity]: record })), next_offset: nextOffset };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "INV-1",
    status: "paid",
    customer_id: "cb_cust",
    subscription_id: "cb_sub",
    currency_code: "USD",
    sub_total: 9900,
    tax: 800,
    total: 10700,
    amount_due: 0,
    amount_paid: 10700,
    generated_at: 1672531200,
    due_date: 1675209600,
    paid_at: 1672617600,
    meta_data: {},
    line_items: [
      {
        id: "li_1",
        entity_type: "item",
        entity_id: "cb_price_1",
        description: "Analytics Pro",
        quantity: 1,
        amount: 9900,
        date_from: 1672531200,
        date_to: 1675209600,
      },
    ],
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn_1",
    type: "payment",
    status: "success",
    amount: 10700,
    currency_code: "USD",
    customer_id: "cb_cust",
    payment_method: "card",
    id_at_gateway: "gw_1",
    settled_at: 1672617600,
    date: 1672531200,
    linked_invoices: [{ invoice_id: "INV-1" }],
    meta_data: {},
    ...overrides,
  };
}

const ctx = (sources: Record<string, readonly string[]>) =>
  testContext({
    accessToken: `${SITE}:chb_test_key`,
    metadata: { site: SITE },
    sources,
  }).ctx;

const invoiceCtx = () => ctx({ invoice: ["number"] });
const lineCtx = () => ctx({ invoice: ["number"], invoiceLine: ["amount"] });
const paymentCtx = () => ctx({ payment: ["kind"] });

describe("invoice pagination and inline lines", () => {
  it("follows next_offset and yields each invoice with its lines", async () => {
    const seen: string[] = [];
    server.use(
      http.get(INVOICES, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("next_offset");
        seen.push(offset ?? "(none)");
        return HttpResponse.json(
          offset === null
            ? envelope("invoice", [invoice({ id: "INV-1" })], "off_2")
            : envelope("invoice", [invoice({ id: "INV-2" })])
        );
      })
    );

    const { byObject } = await collect(chargebeeBillingHandler, lineCtx());

    expect(seen).toEqual(["(none)", "off_2"]);
    expect(byObject.invoice.map((r) => r["id"])).toEqual(["INV-1", "INV-2"]);
    expect(byObject.invoiceLine.map((r) => r["id"])).toEqual(["li_1", "li_1"]);
  });

  it("marks the line page complete when every invoice carried line_items", async () => {
    server.use(http.get(INVOICES, () => HttpResponse.json(envelope("invoice", [invoice()]))));

    const { pages } = await collect(chargebeeBillingHandler, lineCtx());

    expect(pages.find((p) => p.object === "invoiceLine")?.complete).toBe(true);
    expect(pages.find((p) => p.object === "invoice")?.complete).toBeUndefined();
  });

  it("withholds completeness when an invoice's line_items key is absent", async () => {
    // The gate. The invoice is still written; only the licence to delete is
    // withheld, for every invoice in the run because `complete` is ANDed.
    const withoutLines = invoice({ id: "INV-NO-LINES" });
    delete (withoutLines as Record<string, unknown>)["line_items"];
    server.use(
      http.get(INVOICES, () =>
        HttpResponse.json(envelope("invoice", [invoice(), withoutLines]))
      )
    );

    const { pages } = await collect(chargebeeBillingHandler, lineCtx());

    expect(pages.find((p) => p.object === "invoiceLine")?.complete).toBe(false);
  });

  it("withholds the guarantee once any page's invoice omits line_items", async () => {
    // The AND across pages is the engine's, but the handler supplies the
    // per-page flag it folds: a later page that cannot promise completeness
    // must not be able to turn an earlier page's promise back on.
    const withoutLines = invoice({ id: "INV-2" });
    delete (withoutLines as Record<string, unknown>)["line_items"];
    server.use(
      http.get(INVOICES, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("next_offset");
        return HttpResponse.json(
          offset === null
            ? envelope("invoice", [invoice({ id: "INV-1" })], "off_2")
            : envelope("invoice", [withoutLines])
        );
      })
    );

    const { pages } = await collect(chargebeeBillingHandler, lineCtx());

    expect(
      pages.filter((p) => p.object === "invoiceLine").map((p) => p.complete)
    ).toEqual([true, false]);
  });

  it("injects the invoice id onto each line, ignoring the line's own", async () => {
    const own = invoice({
      line_items: [{ id: "li_1", invoice_id: "INV-ELSEWHERE" }],
    });
    server.use(http.get(INVOICES, () => HttpResponse.json(envelope("invoice", [own]))));

    const { byObject } = await collect(chargebeeBillingHandler, lineCtx());
    const line = byObject.invoiceLine[0];

    expect(line?.["invoice_id"]).toBe("INV-1");
    expect(
      chargebeeBillingHandler.externalRefsOf(line ?? {}, "invoiceLine")
    ).toMatchObject({ invoice: "INV-1" });
  });
});

describe("consolidated invoicing", () => {
  it("leaves the agreement unlinked and records the consolidation", async () => {
    const consolidated = invoice({
      subscription_id: null,
      line_items: [
        { id: "li_1", subscription_id: "cb_sub_a" },
        { id: "li_2", subscription_id: "cb_sub_b" },
      ],
    });
    server.use(
      http.get(INVOICES, () => HttpResponse.json(envelope("invoice", [consolidated])))
    );

    const { byObject } = await collect(chargebeeBillingHandler, invoiceCtx());
    const record = byObject.invoice[0];

    expect(record?.["agreement_id"]).toBeUndefined();
    expect(JSON.parse(String(record?.["provider_metadata"]))).toMatchObject({
      subscription_id: "consolidated",
    });
    expect(
      chargebeeBillingHandler.externalRefsOf(record ?? {}, "invoice")
    ).toMatchObject({ agreement: undefined, customer: "cb_cust" });
  });
});

describe("transactions", () => {
  it("yields payments and refunds, and drops authorizations", async () => {
    server.use(
      http.get(TRANSACTIONS, () =>
        HttpResponse.json(
          envelope("transaction", [
            transaction({ id: "txn_pay", type: "payment" }),
            transaction({ id: "txn_auth", type: "authorization" }),
            transaction({
              id: "txn_ref",
              type: "refund",
              linked_invoices: [],
              settled_at: undefined,
            }),
          ])
        )
      )
    );

    const { byObject, pages } = await collect(chargebeeBillingHandler, paymentCtx());

    expect(byObject.payment.map((r) => r["id"])).toEqual(["txn_pay", "txn_ref"]);
    expect(byObject.payment.map((r) => r["kind"])).toEqual(["payment", "refund"]);
    // The refund has no invoice link, which is ordinary rather than an error.
    expect("invoice_id" in (byObject.payment[1] ?? {})).toBe(false);
    // No `complete` on a payment page: payments are upsert-only.
    expect(pages.every((p) => p.complete === undefined)).toBe(true);
  });

  it("pages transactions with next_offset", async () => {
    const seen: string[] = [];
    server.use(
      http.get(TRANSACTIONS, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("next_offset");
        seen.push(offset ?? "(none)");
        return HttpResponse.json(
          offset === null
            ? envelope("transaction", [transaction({ id: "txn_1" })], "off_2")
            : envelope("transaction", [transaction({ id: "txn_2" })])
        );
      })
    );

    const { byObject } = await collect(chargebeeBillingHandler, paymentCtx());

    expect(seen).toEqual(["(none)", "off_2"]);
    expect(byObject.payment.map((r) => r["id"])).toEqual(["txn_1", "txn_2"]);
  });
});

describe("pass gating", () => {
  it("does not touch transactions when only invoices are requested", async () => {
    let transactionRequests = 0;
    server.use(
      http.get(INVOICES, () => HttpResponse.json(envelope("invoice", [invoice()]))),
      http.get(TRANSACTIONS, () => {
        transactionRequests += 1;
        return HttpResponse.json(envelope("transaction", []));
      })
    );

    await collect(chargebeeBillingHandler, invoiceCtx());

    expect(transactionRequests).toBe(0);
  });
});
