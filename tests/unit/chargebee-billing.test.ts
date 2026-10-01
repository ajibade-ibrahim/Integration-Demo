/**
 * The pure pieces of Chargebee's billing pass: status and kind translation, the
 * inline-line helpers and their key-presence gate, and the consolidated-invoice
 * trap.
 *
 * The last is the one worth unit-testing apart from the handler. Chargebee's
 * `subscription_id` is null when an invoice carries lines from several
 * subscriptions, and the docs forbid using it there — but it is *also* absent on
 * an ordinary one-off invoice. Without the `providerMetadata` marker the two
 * states are indistinguishable on the row, which is the failure this file pins.
 */

import { describe, expect, it } from "vitest";

import {
  chargebeeInvoiceStatusOf,
  chargebeePaymentKindOf,
  chargebeeTransactionStatusOf,
  flattenChargebeeInvoice,
  flattenChargebeeInvoiceLine,
  flattenChargebeeTransaction,
  hasLineItemsKey,
  invoiceLineItems,
  invoicesUrl,
  parseInvoicesPage,
  parseTransactionsPage,
  transactionsUrl,
} from "@/core/providers/chargebee/api";

describe("billing URLs", () => {
  it("names the invoices endpoint with offset pagination", () => {
    const url = new URL(invoicesUrl("acme-test", 25, "offset_1"));
    expect(url.pathname).toBe("/api/v2/invoices");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("next_offset")).toBe("offset_1");
  });

  it("names the transactions endpoint", () => {
    const url = new URL(transactionsUrl("acme-test", 10));
    expect(url.pathname).toBe("/api/v2/transactions");
    expect(url.searchParams.has("next_offset")).toBe(false);
  });
});

describe("invoice and transaction page parsing", () => {
  it("unwraps the entity key and reads next_offset", () => {
    const page = parseInvoicesPage({
      list: [{ invoice: { id: "in_1" } }, { invoice: { id: "in_2" } }],
      next_offset: "offset_2",
    });
    expect(page.records.map((r) => r["id"])).toEqual(["in_1", "in_2"]);
    expect(page.nextOffset).toBe("offset_2");
  });

  it("treats a blank next_offset as the end", () => {
    expect(
      parseTransactionsPage({ list: [{ transaction: { id: "txn_1" } }], next_offset: "" })
        .nextOffset
    ).toBeUndefined();
  });
});

describe("the line_items key-presence gate", () => {
  it("is true when the payload carried the key, even empty", () => {
    expect(hasLineItemsKey({ id: "in_1", line_items: [] })).toBe(true);
  });

  it("is false when the key is absent", () => {
    // Absence reads as "this invoice has no lines", which would delete every
    // line of every invoice written this run — so the handler withholds
    // completeness and the writer refuses to reconcile.
    expect(hasLineItemsKey({ id: "in_1" })).toBe(false);
  });

  it("reads flat and wrapped line elements", () => {
    const items = invoiceLineItems({
      line_items: [
        { id: "li_1" },
        { line_item: { id: "li_2" } },
        "nope",
      ],
    });
    expect(items.map((i) => i["id"])).toEqual(["li_1", "li_2"]);
  });
});

describe("chargebeeInvoiceStatusOf", () => {
  it("folds the two retry states into past_due", () => {
    expect(chargebeeInvoiceStatusOf({ status: "payment_due" })).toBe("past_due");
    expect(chargebeeInvoiceStatusOf({ status: "not_paid" })).toBe("past_due");
  });

  it("maps the rest one-to-one", () => {
    expect(chargebeeInvoiceStatusOf({ status: "pending" })).toBe("draft");
    expect(chargebeeInvoiceStatusOf({ status: "posted" })).toBe("open");
    expect(chargebeeInvoiceStatusOf({ status: "paid" })).toBe("paid");
    expect(chargebeeInvoiceStatusOf({ status: "voided" })).toBe("void");
  });

  it("has no uncollectible spelling, and returns undefined for anything unknown", () => {
    expect(chargebeeInvoiceStatusOf({ status: "write_off" })).toBeUndefined();
    expect(chargebeeInvoiceStatusOf({})).toBeUndefined();
  });
});

describe("chargebeeTransactionStatusOf", () => {
  it("keeps needs_attention as pending, not failed", () => {
    // "The gateway connection dropped and nobody has reconciled it" is not a
    // failure; reporting it as one would say a payment was lost that may well
    // have succeeded.
    expect(chargebeeTransactionStatusOf({ status: "needs_attention" })).toBe(
      "pending"
    );
    expect(chargebeeTransactionStatusOf({ status: "in_progress" })).toBe(
      "pending"
    );
  });

  it("folds the failure family into failed", () => {
    for (const status of ["failure", "timeout", "late_failure"]) {
      expect(chargebeeTransactionStatusOf({ status })).toBe("failed");
    }
  });

  it("maps success and voided", () => {
    expect(chargebeeTransactionStatusOf({ status: "success" })).toBe("succeeded");
    expect(chargebeeTransactionStatusOf({ status: "voided" })).toBe("reversed");
  });

  it("returns undefined for an unknown status", () => {
    expect(chargebeeTransactionStatusOf({ status: "pending_verification" })).toBeUndefined();
  });
});

describe("chargebeePaymentKindOf", () => {
  it("maps payment, refund and payment_reversal", () => {
    expect(chargebeePaymentKindOf({ type: "payment" })).toBe("payment");
    expect(chargebeePaymentKindOf({ type: "refund" })).toBe("refund");
    expect(chargebeePaymentKindOf({ type: "payment_reversal" })).toBe("refund");
  });

  it("returns undefined for an authorization, so the handler drops it", () => {
    // An authorization moves no money; a `payment` row for one would overstate
    // what the customer paid.
    expect(chargebeePaymentKindOf({ type: "authorization" })).toBeUndefined();
    expect(chargebeePaymentKindOf({})).toBeUndefined();
  });
});

describe("flattenChargebeeInvoice", () => {
  const invoice = {
    id: "INV-0007",
    status: "paid",
    customer_id: "cb_cust_acme",
    subscription_id: "cb_sub_acme",
    currency_code: "USD",
    sub_total: 9900,
    tax: 800,
    total: 10700,
    amount_due: 0,
    amount_paid: 10700,
    generated_at: 1672531200,
    due_date: 1675209600,
    paid_at: 1672617600,
    meta_data: { po: "PO-7" },
    line_items: [{ id: "li_1", subscription_id: "cb_sub_acme" }],
  };

  it("takes the invoice number from the id and translates the status", () => {
    const flat = flattenChargebeeInvoice(invoice);
    expect(flat["number"]).toBe("INV-0007");
    expect(flat["status"]).toBe("paid");
  });

  it("lifts the epoch dates and keeps the money raw", () => {
    const flat = flattenChargebeeInvoice(invoice);
    expect(flat["issued_at"]).toBe("2023-01-01T00:00:00.000Z");
    expect(flat["due_at"]).toBe("2023-02-01T00:00:00.000Z");
    expect(flat["paid_at"]).toBe("2023-01-02T00:00:00.000Z");
    // Money is not synthesized — the handler's defaults map Chargebee's own
    // top-level cents fields.
    expect("subtotal_minor" in flat).toBe(false);
  });

  it("leaves issued_at absent for a pending invoice, which has no generated_at", () => {
    const flat = flattenChargebeeInvoice({
      ...invoice,
      status: "pending",
      generated_at: undefined,
    });
    expect("issued_at" in flat).toBe(false);
    expect(flat["status"]).toBe("draft");
  });

  it("links exactly one named subscription", () => {
    const flat = flattenChargebeeInvoice(invoice);
    expect(flat["customer_id"]).toBe("cb_cust_acme");
    expect(flat["agreement_id"]).toBe("cb_sub_acme");
    expect(JSON.parse(String(flat["provider_metadata"]))).toEqual({ po: "PO-7" });
  });

  it("leaves a consolidated invoice unlinked and records the consolidation", () => {
    // The trap: subscription_id is null when the lines span subscriptions, and
    // taking the first line's id would be a lie with no null to notice.
    const flat = flattenChargebeeInvoice({
      ...invoice,
      subscription_id: null,
      line_items: [
        { id: "li_1", subscription_id: "cb_sub_acme" },
        { id: "li_2", subscription_id: "cb_sub_globex" },
      ],
    });
    expect(flat["agreement_id"]).toBeUndefined();
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      subscription_id: "consolidated",
    });
  });

  it("does not call a one-off invoice consolidated", () => {
    const flat = flattenChargebeeInvoice({
      ...invoice,
      subscription_id: null,
      meta_data: {},
      line_items: [{ id: "li_1" }],
    });
    expect(flat["agreement_id"]).toBeUndefined();
    expect("provider_metadata" in flat).toBe(false);
  });
});

describe("flattenChargebeeInvoiceLine", () => {
  const line = {
    id: "li_1",
    invoice_id: "in_SOMEONE_ELSE",
    entity_type: "plan",
    entity_id: "cb_price_analytics_pro_monthly",
    description: "Analytics Pro",
    quantity: 1,
    unit_amount: 9900,
    amount: 9900,
    date_from: 1672531200,
    date_to: 1675209600,
  };

  it("injects the invoice id and ignores the line's own invoice_id field", () => {
    expect(flattenChargebeeInvoiceLine(line, "in_1")["invoice_id"]).toBe("in_1");
  });

  it("reads the item price id from entity_id on an item-shaped line", () => {
    expect(flattenChargebeeInvoiceLine(line, "in_1")["price_id"]).toBe(
      "cb_price_analytics_pro_monthly"
    );
  });

  it("does not treat a coupon's entity_id as a price", () => {
    const flat = flattenChargebeeInvoiceLine(
      { ...line, entity_type: "coupon", entity_id: "cb_coupon_launch" },
      "in_1"
    );
    expect("price_id" in flat).toBe(false);
  });

  it("lifts the service window to ISO", () => {
    const flat = flattenChargebeeInvoiceLine(line, "in_1");
    expect(flat["period_start"]).toBe("2023-01-01T00:00:00.000Z");
    expect(flat["period_end"]).toBe("2023-02-01T00:00:00.000Z");
  });
});

describe("flattenChargebeeTransaction", () => {
  const payment = {
    id: "txn_1",
    type: "payment",
    status: "success",
    amount: 10700,
    currency_code: "USD",
    customer_id: "cb_cust_acme",
    payment_method: "card",
    id_at_gateway: "gw_1",
    settled_at: 1672617600,
    date: 1672531200,
    linked_invoices: [{ invoice_id: "INV-0007" }],
    meta_data: { po: "PO-7" },
  };

  it("is a payment movement with its invoice link from linked_invoices", () => {
    const flat = flattenChargebeeTransaction(payment);
    expect(flat["kind"]).toBe("payment");
    expect(flat["status"]).toBe("succeeded");
    expect(flat["invoice_id"]).toBe("INV-0007");
    expect(flat["method"]).toBe("card");
    expect(flat["provider_reference"]).toBe("gw_1");
    expect(flat["processed_at"]).toBe("2023-01-02T00:00:00.000Z");
  });

  it("falls back to the transaction date when settled_at is absent", () => {
    const flat = flattenChargebeeTransaction({ ...payment, settled_at: undefined });
    expect(flat["processed_at"]).toBe("2023-01-01T00:00:00.000Z");
  });

  it("leaves a refund with no invoice link", () => {
    // A Chargebee refund carries no linked_invoices entry, so the link is
    // legitimately null rather than guessed.
    const flat = flattenChargebeeTransaction({
      ...payment,
      type: "refund",
      linked_invoices: [],
    });
    expect(flat["kind"]).toBe("refund");
    expect("invoice_id" in flat).toBe(false);
  });

  it("reports a completed payment_reversal as reversed", () => {
    const flat = flattenChargebeeTransaction({
      ...payment,
      type: "payment_reversal",
    });
    expect(flat["kind"]).toBe("refund");
    expect(flat["status"]).toBe("reversed");
  });

  it("combines error_code and error_text into the failure reason", () => {
    const flat = flattenChargebeeTransaction({
      ...payment,
      status: "failure",
      error_code: "card_declined",
      error_text: "The card was declined.",
    });
    expect(flat["failure_reason"]).toBe(
      "card_declined: The card was declined."
    );
  });

  it("treats a chargeback as disputed", () => {
    const flat = flattenChargebeeTransaction({
      ...payment,
      payment_method: "chargeback",
    });
    expect(flat["is_disputed"]).toBe(true);
    expect(flattenChargebeeTransaction(payment)["is_disputed"]).toBe(false);
  });

  it("keeps the reference and refunded transaction ids in provider metadata", () => {
    const flat = flattenChargebeeTransaction({
      ...payment,
      reference_transaction_id: "txn_0",
      refunded_txn_id: "txn_2",
    });
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      po: "PO-7",
      reference_transaction_id: "txn_0",
      refunded_txn_id: "txn_2",
    });
  });
});
