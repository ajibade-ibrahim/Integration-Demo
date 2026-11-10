/**
 * Metrifox billing helpers and handler contracts.
 *
 * The risky pieces are all pure but load-bearing:
 *
 *   - the amount conversion. Metrifox states standard units while our columns
 *     are integer minor units, and a wrong factor or a dropped sign is invisible
 *     in a happy-path sync;
 *   - the status translation. `pending`, `due`/`overdue` and `written_off` are
 *     judgement calls, and an unrecognised word must leave `status` absent while
 *     keeping Metrifox's own word;
 *   - `issued_at` on a draft. The API's draft example carries a future issue
 *     date, which must not become `Invoice.issuedAt`;
 *   - `parseBillingHistory`'s distinction between an empty history and a
 *     response we could not read.
 */

import { describe, expect, it } from "vitest";

import {
  flattenMetrifoxInvoice,
  metrifoxInvoiceStatus,
  metrifoxMinorAmount,
  parseBillingHistory,
  subscriptionBillingHistoryUrl,
} from "@/core/providers/metrifox/api";
import { metrifoxBillingHandler } from "@/core/providers/metrifox/billing-handler";

describe("Metrifox invoice status", () => {
  it("maps the documented words and its spelling variants", () => {
    expect(metrifoxInvoiceStatus("draft")).toBe("draft");
    expect(metrifoxInvoiceStatus("open")).toBe("open");
    expect(metrifoxInvoiceStatus("paid")).toBe("paid");
    expect(metrifoxInvoiceStatus("past_due")).toBe("past_due");
    expect(metrifoxInvoiceStatus("void")).toBe("void");
    expect(metrifoxInvoiceStatus("voided")).toBe("void");
    expect(metrifoxInvoiceStatus("uncollectible")).toBe("uncollectible");
  });

  it("translates the judgement calls rather than inventing enum members", () => {
    // Issued and outstanding; the dashboard calls it Open.
    expect(metrifoxInvoiceStatus("pending")).toBe("open");
    // Money that should already have arrived.
    expect(metrifoxInvoiceStatus("due")).toBe("past_due");
    expect(metrifoxInvoiceStatus("overdue")).toBe("past_due");
    // No longer expected.
    expect(metrifoxInvoiceStatus("written_off")).toBe("uncollectible");
  });

  it("normalises case, spaces and hyphens", () => {
    expect(metrifoxInvoiceStatus("PAID")).toBe("paid");
    expect(metrifoxInvoiceStatus("Past Due")).toBe("past_due");
    expect(metrifoxInvoiceStatus("past-due")).toBe("past_due");
    expect(metrifoxInvoiceStatus("Written Off")).toBe("uncollectible");
  });

  it("omits consolidated and unknown words rather than guessing", () => {
    // The raw word stays reachable in `raw_status`; see the flatten tests.
    expect(metrifoxInvoiceStatus("consolidated")).toBeUndefined();
    expect(metrifoxInvoiceStatus("teleported")).toBeUndefined();
    expect(metrifoxInvoiceStatus("")).toBeUndefined();
    expect(metrifoxInvoiceStatus(null)).toBeUndefined();
  });
});

describe("subscriptionBillingHistoryUrl", () => {
  it("percent-encodes the subscription id as a path segment", () => {
    const url = subscriptionBillingHistoryUrl("sub/1 test");
    expect(url).toContain(
      "/api/v1/subscriptions/sub%2F1%20test/billing-history"
    );
  });
});

describe("metrifoxMinorAmount", () => {
  it("converts standard units with the currency's exponent", () => {
    expect(metrifoxMinorAmount(21, "USD")).toBe(2100);
    expect(metrifoxMinorAmount(0, "USD")).toBe(0);
    // JPY has no minor unit, so the figure must not grow by a hundred.
    expect(metrifoxMinorAmount(4900, "JPY")).toBe(4900);
    // KWD has three.
    expect(metrifoxMinorAmount(1.5, "KWD")).toBe(1500);
  });

  it("rounds away from zero so a credit note keeps its sign", () => {
    expect(metrifoxMinorAmount(-23.0356, "USD")).toBe(-2304);
    expect(metrifoxMinorAmount(23.0356, "USD")).toBe(2304);
  });

  it("accepts a numeric string, because real payloads sometimes stringify decimals", () => {
    expect(metrifoxMinorAmount("-23.0356", "USD")).toBe(-2304);
    expect(metrifoxMinorAmount("21", "USD")).toBe(2100);
  });

  it("returns undefined rather than defaulting an absent or invalid currency", () => {
    // Never assume two decimals: the raw figure is all we actually know.
    expect(metrifoxMinorAmount(21, undefined)).toBeUndefined();
    expect(metrifoxMinorAmount(21, "")).toBeUndefined();
    expect(metrifoxMinorAmount(21, "NOTACURRENCY")).toBeUndefined();
    // And a non-numeric amount is not a number.
    expect(metrifoxMinorAmount(null, "USD")).toBeUndefined();
    expect(metrifoxMinorAmount("n/a", "USD")).toBeUndefined();
    expect(metrifoxMinorAmount(Number.POSITIVE_INFINITY, "USD")).toBeUndefined();
  });
});

describe("parseBillingHistory", () => {
  it("treats an empty array as a usable empty history", () => {
    expect(parseBillingHistory({ data: [] })).toEqual([]);
  });

  it("returns undefined when the body cannot be read", () => {
    expect(parseBillingHistory({})).toBeUndefined();
    expect(parseBillingHistory({ data: null })).toBeUndefined();
    expect(parseBillingHistory({ data: {} })).toBeUndefined();
    expect(parseBillingHistory({ data: "nope" })).toBeUndefined();
  });

  it("returns undefined for an array with no record objects", () => {
    expect(parseBillingHistory({ data: ["junk", 1, null] })).toBeUndefined();
  });

  it("returns undefined when no row carries an invoice_id", () => {
    // A changed key name must not masquerade as "no invoices".
    expect(
      parseBillingHistory({ data: [{ id: "in_1" }, { invoice_id: "" }] })
    ).toBeUndefined();
  });

  it("keeps the valid invoice rows out of a mixed array", () => {
    expect(
      parseBillingHistory({
        data: [
          { invoice_id: "in_1" },
          { id: "not-an-invoice" },
          "junk",
          { invoice_id: "in_2" },
        ],
      })
    ).toEqual([{ invoice_id: "in_1" }, { invoice_id: "in_2" }]);
  });
});

describe("flattenMetrifoxInvoice", () => {
  const invoice = {
    invoice_id: "inv_1",
    invoice_number: "INV-2025-001",
    issued_date: "2025-03-01T00:00:00.000Z",
    due_date: "2025-03-31T00:00:00.000Z",
    total_amount: 21,
    amount_paid: 0,
    balance_due: 21,
    currency: "USD",
    status: "Paid",
    payment_method: "card",
    source_type: "subscription",
    created_at: "2025-02-28T00:00:00.000Z",
  };

  it("carries the number, translated status and stated dates", () => {
    const flat = flattenMetrifoxInvoice(invoice, "cust_1", "sub_1");

    expect(flat["invoice_number"]).toBe("INV-2025-001");
    expect(flat["status"]).toBe("paid");
    expect(flat["raw_status"]).toBe("Paid");
    expect(flat["issued_at"]).toBe(invoice.issued_date);
    expect(flat["due_date"]).toBe(invoice.due_date);
    expect(flat["created_at"]).toBe(invoice.created_at);
    expect(flat["payment_method"]).toBe("card");
    expect(flat["source_type"]).toBe("subscription");
  });

  it("injects the customer and subscription associations", () => {
    const flat = flattenMetrifoxInvoice(invoice, "cust_list_id", "sub_1");
    expect(flat["customer_id"]).toBe("cust_list_id");
    expect(flat["agreement_id"]).toBe("sub_1");
  });

  it("converts the three amounts to minor units, keeping a legitimate zero", () => {
    const flat = flattenMetrifoxInvoice(invoice, "c", "s");
    expect(flat["total_amount_minor"]).toBe(2100);
    // A zero is stated, not absent; the conditional write must not drop it.
    expect(flat["amount_paid_minor"]).toBe(0);
    expect(flat["balance_due_minor"]).toBe(2100);
  });

  it("keeps signed credit notes negative", () => {
    const flat = flattenMetrifoxInvoice(
      {
        invoice_id: "cn_1",
        currency: "USD",
        status: "open",
        total_amount: -23.0356,
        balance_due: -23.0356,
      },
      "c",
      "s"
    );
    expect(flat["total_amount_minor"]).toBe(-2304);
    expect(flat["balance_due_minor"]).toBe(-2304);
  });

  it("leaves the minor amounts absent when the currency is unusable", () => {
    const flat = flattenMetrifoxInvoice(
      {
        invoice_id: "inv_no_currency",
        status: "open",
        total_amount: 21,
        balance_due: 21,
      },
      "c",
      "s"
    );
    expect(flat).not.toHaveProperty("total_amount_minor");
    expect(flat).not.toHaveProperty("balance_due_minor");
    // The raw figure survives for audit and for a custom mapping.
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      total_amount: 21,
    });
  });

  it("keeps a curated provider bag, including the raw amounts", () => {
    const flat = flattenMetrifoxInvoice(invoice, "c", "sub_1");
    expect(JSON.parse(String(flat["provider_metadata"]))).toEqual({
      subscription_id: "sub_1",
      raw_status: "Paid",
      source_type: "subscription",
      payment_method: "card",
      created_at: "2025-02-28T00:00:00.000Z",
      issued_date: "2025-03-01T00:00:00.000Z",
      total_amount: 21,
      amount_paid: 0,
      balance_due: 21,
    });
  });

  it("leaves absent optional facts absent", () => {
    const flat = flattenMetrifoxInvoice(
      { invoice_id: "inv_2", status: "open", currency: "USD", total_amount: 5 },
      "c",
      "s"
    );
    expect(flat["invoice_number"]).toBeUndefined();
    expect(flat["due_date"]).toBeUndefined();
    expect(flat["payment_method"]).toBeUndefined();
    // No issue date is stated, so the synthesized key is present but unset.
    expect("issued_at" in flat).toBe(true);
    expect(flat["issued_at"]).toBeUndefined();
  });

  it("omits an unrecognised status but keeps the raw word", () => {
    const flat = flattenMetrifoxInvoice(
      { invoice_id: "inv_3", status: "Consolidated", currency: "USD" },
      "c",
      "s"
    );
    // The key is written explicitly so a raw word cannot reach the enum.
    expect("status" in flat).toBe(true);
    expect(flat["status"]).toBeUndefined();
    expect(flat["raw_status"]).toBe("Consolidated");
    expect(JSON.parse(String(flat["provider_metadata"]))).toMatchObject({
      raw_status: "Consolidated",
    });
  });

  it("does not claim a draft was issued, but keeps the raw issue date", () => {
    const flat = flattenMetrifoxInvoice(
      {
        invoice_id: "inv_draft",
        status: "draft",
        issued_date: "2026-01-01T00:00:00.000Z",
        due_date: "2026-02-01T00:00:00.000Z",
        currency: "USD",
        total_amount: 10,
      },
      "c",
      "s"
    );

    // Metrifox's draft carries a future issued_date; `Invoice.issuedAt` is
    // documented as null on a draft, so the synthesized key must stay unset.
    expect(flat["issued_at"]).toBeUndefined();
    expect(flat["issued_date"]).toBe("2026-01-01T00:00:00.000Z");
    expect(flat["due_date"]).toBe("2026-02-01T00:00:00.000Z");
    expect(flat["status"]).toBe("draft");
  });
});

describe("metrifoxBillingHandler contracts", () => {
  it("keys an invoice by invoice_id and ignores a raw id", () => {
    expect(
      metrifoxBillingHandler.externalIdOf({ invoice_id: "inv_1", id: "wrong" })
    ).toBe("inv_1");
    expect(metrifoxBillingHandler.externalIdOf({ id: "wrong" })).toBeUndefined();
  });

  it("returns both associations for an invoice and none for anything else", () => {
    expect(
      metrifoxBillingHandler.externalRefsOf(
        { customer_id: "cust_1", agreement_id: "sub_1" },
        "invoice"
      )
    ).toEqual({ customer: "cust_1", agreement: "sub_1" });
    expect(
      metrifoxBillingHandler.externalRefsOf({}, "invoiceLine")
    ).toEqual({});
  });

  it("declares invoice as its only object", () => {
    expect(metrifoxBillingHandler.objects).toEqual(["invoice"]);
  });
});
