/**
 * The billing schema: the target fields an `invoice`, `invoiceLine` or
 * `payment` mapping rule may write.
 *
 * Sibling of `agreement-schema.ts` and `catalog-schema.ts`, read through the
 * same consumers via the composed registry in `object-schema.ts`.
 *
 * **Three objects, and the split is the design.** An invoice is the document —
 * a number, a status, a stated total, when it was issued and paid. An
 * `invoiceLine` is what the document is made of, one row per source line, and
 * is the *only* object here that is reconciled (the writer deletes lines an
 * invoice no longer has). A `payment` is a money movement, `kind` saying which
 * direction, and is written at the *movement* grain rather than the allocation
 * grain so Stripe's `method`/`disputed` and Chargebee's `payment_method` stay
 * attached.
 *
 * What is deliberately absent is `charge`. It answered the same question
 * `invoiceLine` now answers ("the billed amount on the invoice"), but the word
 * carries three incompatible meanings across these providers and an invoice
 * line, so it was dropped rather than kept as a placeholder.
 *
 * `providerMetadata` is a plain mappable string on all three, never `readOnly`:
 * the handlers serialize their provider bag and a default rule maps it, exactly
 * as `agreement.providerMetadata` works.
 */

import type { ObjectSchema } from "./object-schema";
import {
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_STATUSES,
} from "./types/common";

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

/**
 * The invoice document.
 *
 * Note there is no `name` here and no required field at all. A provider gives
 * an invoice a `number` or nothing, never a name, and nothing in the mapping
 * layer needs one to write a row — which is exactly why `charge` is not needed
 * either: it would have required a synthesized name the way `agreement.name`
 * and `offering.name` do, and there is no honest name to invent for a charge.
 */
const INVOICE_SCHEMA: ObjectSchema = {
  object: "invoice",
  label: "Invoice",
  fields: [
    // Stripe's `number` (null on a draft). Chargebee's `id` *is* the sequential
    // invoice number and the API has no separate field, so its handler maps
    // `id` here in addition to the row's `externalSourceId`.
    { name: "number", label: "Invoice number", kind: "string", maxLength: 255 },
    {
      name: "status",
      label: "Status",
      kind: "enum",
      enumValues: INVOICE_STATUSES,
      maxLength: 20,
    },
    { name: "currency", label: "Currency", kind: "string", maxLength: 10 },
    // Stated by the provider, never computed. See the section comment in
    // prisma/schema.prisma for why `total` is not checked against the lines.
    { name: "subtotalMinor", label: "Subtotal (minor units)", kind: "number" },
    // Null on both providers, and that is meaningful: neither states a scalar
    // discount amount. Null means "not stated", never zero.
    { name: "discountMinor", label: "Discount (minor units)", kind: "number" },
    // Chargebee states a scalar `tax` in cents; Stripe carries `total_taxes`,
    // an array of per-source amounts, so this stays null there rather than
    // being summed.
    { name: "taxMinor", label: "Tax (minor units)", kind: "number" },
    { name: "totalMinor", label: "Total (minor units)", kind: "number" },
    { name: "amountDueMinor", label: "Amount due (minor units)", kind: "number" },
    // Stated, never summed from `payment`: that table drops authorizations by
    // design, so a sum would be wrong precisely where this number is right.
    { name: "amountPaidMinor", label: "Amount paid (minor units)", kind: "number" },
    { name: "issuedAt", label: "Issued at", kind: "date" },
    { name: "dueAt", label: "Due at", kind: "date" },
    // The window invoice items may be attached to. Stripe only.
    { name: "periodStart", label: "Period start", kind: "date" },
    { name: "periodEnd", label: "Period end", kind: "date" },
    { name: "paidAt", label: "Paid at", kind: "date" },
    // Stripe's `hosted_invoice_url`. Chargebee has none.
    { name: "hostedUrl", label: "Hosted invoice URL", kind: "string", maxLength: 500 },
    // Mappable string, serialized by the handler; see `agreement.providerMetadata`.
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    // Derived by the sync engine from the provider's own ids, as every other
    // association id is. Offering them as mapping targets would invite a
    // foreign id into a column holding our internal UUIDs.
    {
      name: "associatedCustomerId",
      label: "Associated customer",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedAgreementId",
      label: "Associated agreement",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Invoice line
// ---------------------------------------------------------------------------

/**
 * One line on an invoice.
 *
 * The first billing object that is many per source record on Stripe (its lines
 * are a per-invoice sub-resource) and inline on Chargebee (its `line_items`
 * arrive on the list payload). It is also the **only reconciled** billing
 * object, so the completeness obligation on `SyncHandler` applies to it alone.
 *
 * Unlike `AgreementItem`, this object *is* the money and therefore carries
 * both amount columns. The reasoning lives on the column comments; the short
 * version is that an agreement line is a selection and an invoice line is the
 * billed figure itself.
 */
const INVOICE_LINE_SCHEMA: ObjectSchema = {
  object: "invoiceLine",
  // "Invoice line" reads as what it is beside the `Invoice` section above.
  label: "Invoice line",
  fields: [
    { name: "description", label: "Description", kind: "string", maxLength: 255 },
    { name: "quantity", label: "Quantity", kind: "number" },
    // Stripe's per-unit figure arrives as `pricing.unit_amount_decimal`, a
    // decimal string legitimately fractional for tiered or usage prices, so it
    // can legitimately resolve to null; `amountMinor` is always an integer.
    { name: "unitAmountMinor", label: "Unit amount (minor units)", kind: "number" },
    { name: "amountMinor", label: "Amount (minor units)", kind: "number" },
    // The service window: what makes "what was delivered in March" answerable.
    { name: "periodStart", label: "Period start", kind: "date" },
    { name: "periodEnd", label: "Period end", kind: "date" },
    // Stripe's `parent.invoice_item_details.proration`. Chargebee has no
    // spelling.
    { name: "isProration", label: "Is proration", kind: "boolean" },
    {
      name: "itemType",
      label: "Line type",
      kind: "enum",
      enumValues: INVOICE_LINE_TYPES,
      maxLength: 20,
    },
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    // All three derived by the engine from the provider's own ids. The invoice
    // edge has no `externalInvoiceId` and no relink, for `AgreementItem`'s
    // reason: both rows come off one source record in one run.
    {
      name: "associatedInvoiceId",
      label: "Associated invoice",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedOfferingId",
      label: "Associated offering",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedPriceId",
      label: "Associated price",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * A money movement — a settled charge or a refund.
 *
 * `kind` is the one required field across the whole billing function. It is
 * not synthesized by the handler as a nicety; the column is NOT NULL and the
 * direction is a fact the provider always states, so a record without one is a
 * rejection rather than a null.
 */
const PAYMENT_SCHEMA: ObjectSchema = {
  object: "payment",
  label: "Payment",
  fields: [
    {
      name: "kind",
      label: "Kind",
      kind: "enum",
      enumValues: PAYMENT_KINDS,
      required: true,
      maxLength: 20,
    },
    {
      name: "status",
      label: "Status",
      kind: "enum",
      enumValues: PAYMENT_STATUSES,
      maxLength: 20,
    },
    { name: "amountMinor", label: "Amount (minor units)", kind: "number" },
    { name: "currency", label: "Currency", kind: "string", maxLength: 10 },
    // Named `processedAt` rather than `paidAt`: a refund is not a payment.
    { name: "processedAt", label: "Processed at", kind: "date" },
    // Free text, deliberately not an enum — Stripe ships ~90 live values.
    { name: "method", label: "Method", kind: "string", maxLength: 100 },
    { name: "failureReason", label: "Failure reason", kind: "string", maxLength: 255 },
    { name: "isDisputed", label: "Is disputed", kind: "boolean" },
    {
      name: "providerReference",
      label: "Provider reference",
      kind: "string",
      maxLength: 255,
    },
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    // Both optional on the row: a Chargebee refund has no invoice and a Stripe
    // charge raised outside an invoice has none either.
    {
      name: "associatedInvoiceId",
      label: "Associated invoice",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedCustomerId",
      label: "Associated customer",
      kind: "string",
      readOnly: true,
    },
  ],
};

export const BILLING_OBJECT_SCHEMA = {
  invoice: INVOICE_SCHEMA,
  invoiceLine: INVOICE_LINE_SCHEMA,
  payment: PAYMENT_SCHEMA,
} as const;
