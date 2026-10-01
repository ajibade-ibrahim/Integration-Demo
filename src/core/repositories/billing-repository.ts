/**
 * Reads over the invoices, lines and payments the sync engine wrote.
 *
 * Sibling of `agreement-repository`, with the shape its own data demands:
 *
 *   - An invoice has **two** nullable associations, like an agreement, so there
 *     are two unresolved counts rather than one.
 *   - The *money is on the invoice line*, which is the departure from the
 *     agreement page's no-amount rule. An agreement line is a selection and its
 *     amount would duplicate the price; an invoice line is the billed figure
 *     itself, so it is rendered. Nothing is summed into `Invoice.totalMinor`,
 *     which the provider states.
 *   - Payments nest under the invoice, `kind`-labelled, because "Refunded" is
 *     not "Paid" and the direction is the first thing a reader needs.
 *
 * Scoped by `userId` through the integration, like every other request-scoped
 * read. There is no cross-integration merge here and inventing one would be a
 * guess — the same invoice seen through two providers is a claim only a human
 * can make.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { formatMoney } from "../price-format";
import { readJsonObject } from "./json-column";

/** One line on an invoice, as the page renders it. */
export interface InvoiceLineRow {
  id: string;
  description: string | null;
  quantity: number | null;
  /**
   * The money, in minor units, exactly as billed. Unlike an agreement line
   * these are rendered, because an invoice line *is* the billed figure rather
   * than a selection of one.
   */
  unitAmountMinor: number | null;
  amountMinor: number | null;
  /** The service window — what was delivered in March. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Stripe states proration; Chargebee has no spelling, so null there. */
  isProration: boolean | null;
  /** plan | add_on | usage | charge | proration | discount | credit | adjustment. */
  itemType: string | null;
  offeringName: string | null;
  /** The provider's own offering id, present even when the link is unresolved. */
  externalOfferingId: string | null;
  externalPriceId: string | null;
}

/** One money movement under an invoice. */
export interface PaymentRow {
  id: string;
  /** payment | refund. */
  kind: string;
  status: string | null;
  amountMinor: number | null;
  currency: string | null;
  processedAt: Date | null;
  method: string | null;
  failureReason: string | null;
  isDisputed: boolean | null;
  providerReference: string | null;
  /**
   * The provider's own invoice id, present even when the link is unresolved —
   * or when there is no link at all, which is the ordinary case for a refund.
   */
  externalInvoiceId: string | null;
  externalCustomerId: string | null;
  customerName: string | null;
}

export interface InvoiceRow {
  id: string;
  externalSourceId: string;
  number: string | null;
  status: string | null;
  currency: string | null;

  customerName: string | null;
  /** The provider's own customer id, present even when the link is unresolved. */
  externalCustomerId: string | null;
  agreementName: string | null;
  externalAgreementId: string | null;

  subtotalMinor: number | null;
  discountMinor: number | null;
  taxMinor: number | null;
  /** Stated by the provider, never computed from the lines. */
  totalMinor: number | null;
  amountDueMinor: number | null;
  /** Stated by the provider, never summed from the payments. */
  amountPaidMinor: number | null;

  issuedAt: Date | null;
  dueAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  hostedUrl: string | null;

  lines: InvoiceLineRow[];
  payments: PaymentRow[];

  customFields: Record<string, string>;
  providerMetadata: Record<string, string>;
  integrationLabel: string;
}

export interface BillingPage {
  invoices: InvoiceRow[];
  totals: {
    invoices: number;
    /**
     * Invoices with money still owed according to the provider: anything not
     * paid, void or uncollectible. A draft counts, because a reader watching
     * what is about to be collectable wants it.
     */
    outstanding: number;
    /** Invoices that named a customer we could not resolve. */
    unlinkedCustomers: number;
    /** Invoices that named an agreement we could not resolve. */
    unlinkedAgreements: number;
    /** Money movements stored, refunds included. */
    payments: number;
  };
}

/** Statuses that mean nothing more is owed. */
const SETTLED_STATUSES = ["paid", "void", "uncollectible"];

const INVOICE_INCLUDE = {
  integration: { select: { instanceLabel: true } },
  customer: { select: { name: true } },
  agreement: { select: { name: true } },
  // No ordinal on an invoice line, so id order is the stable one the database
  // can promise. The provider's own order is not preserved, which is why the
  // page never claims the lines are in billing order.
  lines: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      description: true,
      quantity: true,
      unitAmountMinor: true,
      amountMinor: true,
      periodStart: true,
      periodEnd: true,
      isProration: true,
      itemType: true,
      externalOfferingId: true,
      externalPriceId: true,
      offering: { select: { name: true } },
    },
  },
  payments: {
    // Cast because `as const` would make this a readonly tuple, which Prisma's
    // mutable `orderBy` array type rejects. The two keys keep the order stable
    // when two movements share a timestamp.
    orderBy: [
      { processedAt: "asc" },
      { id: "asc" },
    ] as Prisma.PaymentOrderByWithRelationInput[],
    select: {
      id: true,
      kind: true,
      status: true,
      amountMinor: true,
      currency: true,
      processedAt: true,
      method: true,
      failureReason: true,
      isDisputed: true,
      providerReference: true,
      externalInvoiceId: true,
      externalCustomerId: true,
      customer: { select: { name: true } },
    },
  },
} as const;

/**
 * The invoices, newest issued first, with their lines and payments nested.
 *
 * `issuedAt` descending with nulls last: a draft-heavy account still surfaces
 * its newest issued document first, which is the question a billing page is
 * opened to answer.
 */
export async function loadInvoices(
  userId: string,
  take = 200
): Promise<BillingPage> {
  const scope = { integration: { userId } };

  const [invoices, total, outstanding, unlinkedCustomers, unlinkedAgreements, payments] =
    await Promise.all([
      prisma.invoice.findMany({
        where: scope,
        orderBy: { issuedAt: { sort: "desc", nulls: "last" } },
        take,
        include: INVOICE_INCLUDE,
      }),
      prisma.invoice.count({ where: scope }),
      prisma.invoice.count({
        where: {
          ...scope,
          OR: [{ status: null }, { status: { notIn: SETTLED_STATUSES } }],
        },
      }),
      prisma.invoice.count({
        where: { ...scope, customerId: null, externalCustomerId: { not: null } },
      }),
      prisma.invoice.count({
        where: { ...scope, agreementId: null, externalAgreementId: { not: null } },
      }),
      prisma.payment.count({ where: { integration: { userId } } }),
    ]);

  return {
    invoices: invoices.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      number: row.number,
      status: row.status,
      currency: row.currency,

      customerName: row.customer?.name ?? null,
      externalCustomerId: row.externalCustomerId,
      agreementName: row.agreement?.name ?? null,
      externalAgreementId: row.externalAgreementId,

      subtotalMinor: row.subtotalMinor,
      discountMinor: row.discountMinor,
      taxMinor: row.taxMinor,
      totalMinor: row.totalMinor,
      amountDueMinor: row.amountDueMinor,
      amountPaidMinor: row.amountPaidMinor,

      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      paidAt: row.paidAt,
      hostedUrl: row.hostedUrl,

      lines: row.lines.map((line) => ({
        id: line.id,
        description: line.description,
        quantity: line.quantity,
        unitAmountMinor: line.unitAmountMinor,
        amountMinor: line.amountMinor,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
        isProration: line.isProration,
        itemType: line.itemType,
        offeringName: line.offering?.name ?? null,
        externalOfferingId: line.externalOfferingId,
        externalPriceId: line.externalPriceId,
      })),

      payments: row.payments.map((payment) => ({
        id: payment.id,
        kind: payment.kind,
        status: payment.status,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        processedAt: payment.processedAt,
        method: payment.method,
        failureReason: payment.failureReason,
        isDisputed: payment.isDisputed,
        providerReference: payment.providerReference,
        externalInvoiceId: payment.externalInvoiceId,
        externalCustomerId: payment.externalCustomerId,
        customerName: payment.customer?.name ?? null,
      })),

      customFields: readJsonObject(row.customFields),
      providerMetadata: readJsonObject(row.providerMetadata),
      integrationLabel: row.integration.instanceLabel,
    })),
    totals: {
      invoices: total,
      outstanding,
      unlinkedCustomers,
      unlinkedAgreements,
      payments,
    },
  };
}

/**
 * Format a minor-unit amount for display, falling back to the raw figure when
 * there is no currency to interpret it with.
 *
 * An amount without a currency is not a price, but on an invoice row it is
 * still the number the provider stated, so it is shown bare rather than hidden.
 */
export function formatAmount(
  amountMinor: number | null,
  currency: string | null
): string | null {
  if (amountMinor === null) return null;
  if (currency === null) return String(amountMinor);
  return formatMoney(amountMinor, currency) ?? String(amountMinor);
}
