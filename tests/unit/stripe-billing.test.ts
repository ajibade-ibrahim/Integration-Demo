/**
 * The pure pieces of Stripe's billing pass: status translation, the three
 * invoice→subscription spellings, the charge/refund flattening, and the
 * `invoice_payments` index that is the only route from a payment to an invoice.
 *
 * Unit-tested apart from the handler because between them they carry the
 * hazards no other object in this system has:
 *
 *   - the subscription link moved under `parent.*` on the pinned API version,
 *     and reading the wrong spelling produces a null with **no warning and no
 *     null to notice**, because null is the documented "could not resolve" state;
 *   - a line's invoice id is injected, never read off the line, because
 *     `writeInvoiceLines` deletes;
 *   - `unit_amount_decimal` is a decimal string, and the writer must refuse it
 *     rather than truncate it.
 *
 * `tests/integration/stripe-billing-sync.test.ts` drives the handler over mocked
 * HTTP. These tests pin the functions those behaviours depend on.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  chargeStatusOf,
  flattenInvoicePaymentIndex,
  flattenStripeCharge,
  flattenStripeInvoice,
  flattenStripeInvoiceLine,
  flattenStripeRefund,
  invoiceIdFromIndex,
  invoiceLines,
  invoiceLinesComplete,
  invoiceLinesUrl,
  invoiceStatusOf,
  paymentIntentKeysOf,
  refundStatusOf,
  stripeInvoiceSubscriptionId,
} from "@/core/providers/stripe/api";

afterEach(() => {
  delete process.env["STRIPE_API_BASE"];
});

describe("invoiceLinesUrl", () => {
  it("names the per-invoice lines endpoint with the cursor", () => {
    const url = new URL(invoiceLinesUrl("in_1", 25, "il_10"));
    expect(url.pathname).toBe("/v1/invoices/in_1/lines");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("starting_after")).toBe("il_10");
  });

  it("escapes an invoice id rather than letting it reach the path raw", () => {
    const url = new URL(invoiceLinesUrl("in_1/lines?limit=999", 10));
    expect(url.pathname).toBe("/v1/invoices/in_1%2Flines%3Flimit%3D999/lines");
  });

  it("keeps the base path a mock is mounted under", () => {
    process.env["STRIPE_API_BASE"] = "https://example.test/api/fake/stripe";
    expect(invoiceLinesUrl("in_1", 10)).toContain(
      "/api/fake/stripe/v1/invoices/in_1/lines"
    );
  });
});

describe("invoiceLinesComplete", () => {
  it("is false when Stripe says there are more lines", () => {
    expect(
      invoiceLinesComplete({ lines: { data: [{ id: "il_1" }], has_more: true } })
    ).toBe(false);
  });

  it("is true when Stripe says there are not", () => {
    expect(
      invoiceLinesComplete({ lines: { data: [{ id: "il_1" }], has_more: false } })
    ).toBe(true);
  });

  it("is true with no list object at all, so fixtures do not trigger paging", () => {
    expect(invoiceLinesComplete({ id: "in_1" })).toBe(true);
  });
});

describe("invoiceLines", () => {
  it("reads the inlined list and drops anything that is not a record", () => {
    const lines = invoiceLines({
      lines: { data: [{ id: "il_1" }, "nope", null, { id: "il_2" }] },
    });
    expect(lines.map((l) => l["id"])).toEqual(["il_1", "il_2"]);
  });

  it("is empty rather than throwing for an invoice with no lines", () => {
    expect(invoiceLines({ id: "in_1" })).toEqual([]);
  });
});

describe("invoiceStatusOf", () => {
  it("maps all five of Stripe's states across unchanged", () => {
    for (const status of ["draft", "open", "paid", "void", "uncollectible"]) {
      expect(invoiceStatusOf({ status })).toBe(status);
    }
  });

  it("returns undefined for a status this union does not know", () => {
    // So the writer warns and leaves the column null rather than the status
    // silently becoming `open`.
    expect(invoiceStatusOf({ status: "reopened" })).toBeUndefined();
    expect(invoiceStatusOf({})).toBeUndefined();
  });
});

describe("chargeStatusOf", () => {
  it("maps the three-valued charge status, including pending", () => {
    expect(chargeStatusOf({ status: "succeeded" })).toBe("succeeded");
    expect(chargeStatusOf({ status: "pending" })).toBe("pending");
    expect(chargeStatusOf({ status: "failed" })).toBe("failed");
  });

  it("reports a refunded charge as refunded regardless of its own status", () => {
    expect(chargeStatusOf({ status: "succeeded", refunded: true })).toBe(
      "refunded"
    );
  });

  it("returns undefined for an unknown status", () => {
    expect(chargeStatusOf({ status: "disputed" })).toBeUndefined();
  });
});

describe("refundStatusOf", () => {
  it("maps a refund's own vocabulary", () => {
    expect(refundStatusOf({ status: "succeeded" })).toBe("refunded");
    expect(refundStatusOf({ status: "pending" })).toBe("pending");
    expect(refundStatusOf({ status: "requires_action" })).toBe("pending");
    expect(refundStatusOf({ status: "failed" })).toBe("failed");
    expect(refundStatusOf({ status: "canceled" })).toBe("failed");
    expect(refundStatusOf({ status: "weird" })).toBeUndefined();
  });
});

describe("stripeInvoiceSubscriptionId", () => {
  it("reads the top-level subscription field", () => {
    expect(stripeInvoiceSubscriptionId({ subscription: "sub_top" })).toBe(
      "sub_top"
    );
  });

  it("reads parent.subscription_details.subscription", () => {
    // The spelling the pinned API version actually uses. A handler reading only
    // the top-level field would leave every invoice unlinked, silently.
    expect(
      stripeInvoiceSubscriptionId({
        parent: { subscription_details: { subscription: "sub_parent" } },
      })
    ).toBe("sub_parent");
  });

  it("falls back to the first line's parent.invoice_item_details.subscription", () => {
    expect(
      stripeInvoiceSubscriptionId({
        lines: {
          data: [
            {
              id: "il_1",
              parent: { invoice_item_details: { subscription: "sub_line" } },
            },
          ],
        },
      })
    ).toBe("sub_line");
  });

  it("prefers the more specific spelling over a line-level one", () => {
    expect(
      stripeInvoiceSubscriptionId({
        subscription: "sub_top",
        parent: { subscription_details: { subscription: "sub_parent" } },
        lines: {
          data: [
            {
              id: "il_1",
              parent: { invoice_item_details: { subscription: "sub_line" } },
            },
          ],
        },
      })
    ).toBe("sub_top");
  });

  it("returns undefined when no spelling is present", () => {
    expect(stripeInvoiceSubscriptionId({ id: "in_1" })).toBeUndefined();
  });
});

describe("flattenStripeInvoice", () => {
  const invoice = {
    id: "in_1",
    object: "invoice",
    number: "INV-0001",
    status: "paid",
    currency: "usd",
    customer: "cus_1",
    subscription: "sub_1",
    subtotal: 9900,
    total: 9900,
    amount_due: 0,
    amount_paid: 9900,
    due_date: 1_700_100_000,
    period_start: 1_700_000_000,
    period_end: 1_702_678_400,
    hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
    status_transitions: { finalized_at: 1_700_050_000, paid_at: 1_700_060_000 },
    metadata: { po: "PO-42" },
  };

  it("translates the status and lifts the epoch dates to ISO", () => {
    const flat = flattenStripeInvoice(invoice);
    expect(flat["status"]).toBe("paid");
    expect(flat["issued_at"]).toBe("2023-11-15T12:06:40.000Z");
    expect(flat["paid_at"]).toBe("2023-11-15T14:53:20.000Z");
    expect(flat["due_at"]).toBe("2023-11-16T02:00:00.000Z");
    expect(flat["period_start"]).toBe("2023-11-14T22:13:20.000Z");
  });

  it("synthesizes the customer and agreement ids", () => {
    const flat = flattenStripeInvoice(invoice);
    expect(flat["customer_id"]).toBe("cus_1");
    expect(flat["agreement_id"]).toBe("sub_1");
  });

  it("omits number and issued_at on a draft", () => {
    const draft = {
      ...invoice,
      number: null,
      status_transitions: { finalized_at: null, paid_at: null },
    };
    const flat = flattenStripeInvoice(draft);
    expect("number" in flat).toBe(false);
    expect("issued_at" in flat).toBe(false);
  });

  it("serializes provider metadata", () => {
    const flat = flattenStripeInvoice(invoice);
    expect(JSON.parse(String(flat["provider_metadata"]))).toEqual({
      po: "PO-42",
    });
  });

  it("states no scalar tax or discount, so neither is synthesized", () => {
    // Stripe carries arrays there; null means "not stated", never zero.
    const flat = flattenStripeInvoice({
      ...invoice,
      total_taxes: [{ amount: 800 }],
      total_discount_amounts: [{ amount: 500 }],
    });
    expect("tax_minor" in flat).toBe(false);
    expect("discount_minor" in flat).toBe(false);
  });
});

describe("flattenStripeInvoiceLine", () => {
  const line = {
    id: "il_1",
    object: "line_item",
    invoice: "in_SOMEONE_ELSE",
    amount: 9900,
    description: "Analytics Pro",
    quantity: 1,
    period: { start: 1_700_000_000, end: 1_702_678_400 },
    pricing: { unit_amount_decimal: "9900" },
    price: { id: "price_monthly", product: "prod_widget" },
    parent: { invoice_item_details: { proration: false } },
  };

  it("injects the invoice id and ignores the line's own invoice field", () => {
    // The hazard, stated as a test: this is a writer that deletes, so a line
    // must not be able to reassign itself to another invoice.
    expect(flattenStripeInvoiceLine(line, "in_1")["invoice_id"]).toBe("in_1");
  });

  it("reads the price and offering ids", () => {
    const flat = flattenStripeInvoiceLine(line, "in_1");
    expect(flat["price_id"]).toBe("price_monthly");
    expect(flat["offering_id"]).toBe("prod_widget");
  });

  it("carries the unit amount decimal string verbatim", () => {
    // "49.99" must reach the writer intact so `parseInteger` refuses it. If
    // this were parsed to a number here the refusal would never happen.
    expect(
      flattenStripeInvoiceLine(
        { ...line, pricing: { unit_amount_decimal: "49.99" } },
        "in_1"
      )["unit_amount_minor"]
    ).toBe("49.99");
  });

  it("marks a proration line, and only a proration line", () => {
    const prorated = {
      ...line,
      parent: { invoice_item_details: { proration: true } },
    };
    expect(flattenStripeInvoiceLine(prorated, "in_1")["is_proration"]).toBe(true);
    expect(flattenStripeInvoiceLine(prorated, "in_1")["item_type"]).toBe(
      "proration"
    );
    expect("item_type" in flattenStripeInvoiceLine(line, "in_1")).toBe(false);
  });

  it("lifts the line period to ISO", () => {
    const flat = flattenStripeInvoiceLine(line, "in_1");
    expect(flat["period_start"]).toBe("2023-11-14T22:13:20.000Z");
    expect(flat["period_end"]).toBe("2023-12-15T22:13:20.000Z");
  });
});

describe("flattenStripeCharge", () => {
  const charge = {
    id: "ch_1",
    object: "charge",
    amount: 9900,
    currency: "usd",
    status: "succeeded",
    customer: "cus_1",
    created: 1_700_060_000,
    balance_transaction: "txn_1",
    payment_method_details: { type: "card" },
    refunded: false,
    disputed: false,
  };

  it("is a payment of kind payment, with method and status translated", () => {
    const flat = flattenStripeCharge(charge, "in_1");
    expect(flat["kind"]).toBe("payment");
    expect(flat["status"]).toBe("succeeded");
    expect(flat["method"]).toBe("card");
    expect(flat["invoice_id"]).toBe("in_1");
    expect(flat["customer_id"]).toBe("cus_1");
    expect(flat["provider_reference"]).toBe("txn_1");
    expect(flat["processed_at"]).toBe("2023-11-15T14:53:20.000Z");
  });

  it("combines failure_code and failure_message, truncated to 255", () => {
    const flat = flattenStripeCharge(
      {
        ...charge,
        status: "failed",
        failure_code: "card_declined",
        failure_message: "x".repeat(400),
      },
      undefined
    );
    expect(String(flat["failure_reason"]).length).toBe(255);
    expect(String(flat["failure_reason"]).startsWith("card_declined: ")).toBe(true);
  });

  it("omits the invoice link when the index had no entry", () => {
    expect("invoice_id" in flattenStripeCharge(charge, undefined)).toBe(false);
  });

  it("carries disputed as a boolean fact", () => {
    expect(flattenStripeCharge({ ...charge, disputed: true }, undefined)["is_disputed"]).toBe(true);
    expect(flattenStripeCharge(charge, undefined)["is_disputed"]).toBe(false);
  });
});

describe("flattenStripeRefund", () => {
  const refund = {
    id: "re_1",
    object: "refund",
    amount: 4900,
    currency: "usd",
    status: "succeeded",
    created: 1_700_100_000,
    balance_transaction: "txn_2",
    payment_intent: "pi_1",
  };

  it("is a payment of kind refund with its own status vocabulary", () => {
    const flat = flattenStripeRefund(refund, "in_1");
    expect(flat["kind"]).toBe("refund");
    expect(flat["status"]).toBe("refunded");
    expect(flat["invoice_id"]).toBe("in_1");
    expect(flat["provider_reference"]).toBe("txn_2");
  });

  it("reads no invoice from the refund itself", () => {
    // A refund carries no `invoice` field; the link comes only from the index,
    // so an absent one must stay absent rather than being invented.
    expect("invoice_id" in flattenStripeRefund(refund, undefined)).toBe(false);
  });
});

describe("the invoice_payments index", () => {
  const allocations = [
    {
      id: "inpay_1",
      object: "invoice_payment",
      invoice: "in_1",
      payment: { type: "payment_intent", payment_intent: "pi_1" },
    },
    {
      id: "inpay_2",
      object: "invoice_payment",
      invoice: "in_2",
      payment: { type: "charge", payment_intent: null },
      charge: "ch_9",
    },
  ];

  it("keys by payment intent and by charge id", () => {
    const index = flattenInvoicePaymentIndex(allocations);
    expect(index.get("pi_1")).toBe("in_1");
    expect(index.get("ch_9")).toBe("in_2");
  });

  it("finds a charge's invoice through its payment intent", () => {
    const index = flattenInvoicePaymentIndex(allocations);
    expect(invoiceIdFromIndex({ payment_intent: "pi_1" }, index)).toBe("in_1");
  });

  it("finds a refund's invoice through its charge", () => {
    const index = flattenInvoicePaymentIndex(allocations);
    expect(invoiceIdFromIndex({ charge: "ch_9" }, index)).toBe("in_2");
  });

  it("returns undefined rather than guessing when no key matches", () => {
    const index = flattenInvoicePaymentIndex(allocations);
    expect(invoiceIdFromIndex({ payment_intent: "pi_unknown" }, index)).toBeUndefined();
    expect(invoiceIdFromIndex({ id: "ch_1" }, index)).toBeUndefined();
  });

  it("reads both keys off a record, skipping a duplicate", () => {
    expect(paymentIntentKeysOf({ payment_intent: "pi_1", charge: "pi_1" })).toEqual([
      "pi_1",
    ]);
    expect(paymentIntentKeysOf({ payment_intent: "pi_1", charge: "ch_1" })).toEqual([
      "pi_1",
      "ch_1",
    ]);
  });
});
