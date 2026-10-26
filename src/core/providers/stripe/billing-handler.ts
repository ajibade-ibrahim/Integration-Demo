/**
 * Stripe's `billing` function: invoices, their lines, and the money that
 * actually moved.
 *
 * Five endpoints, and each carries a Stripe-shaped hazard:
 *
 *   1. **No status filter, unlike subscriptions.** `/v1/invoices` and
 *      `/v1/charges` already return every state without a query parameter.
 *      This is the one place Stripe's defaults do *not* hide the interesting
 *      rows, which is exactly why `SUBSCRIPTION_FILTER = { status: "all" }`
 *      exists one function over and why no equivalent is needed here. Stating
 *      it is the point: the next reader will assume the opposite.
 *   2. **Invoice lines are inlined, first ten only.** `lines.has_more` is the
 *      identical hazard to a subscription's `items.has_more`, and the identical
 *      consequence — `writeInvoiceLines` reconciles, so a truncated list would
 *      delete every line past the tenth on every sync. `completeInvoiceLines`
 *      pages to exhaustion and **throws** rather than return a short list.
 *   3. **A charge carries no invoice field.** Neither does a refund. The only
 *      resource mapping a payment object to an invoice is `InvoicePayment`
 *      (`inpay_…`), read here as an index rather than as rows. Taking it as the
 *      row would fill `invoiceId` but darken `method`, `disputed` and
 *      `failure_code` on every charge.
 *   4. **The subscription link moved.** On the pinned API version an invoice's
 *      subscription is under `parent.subscription_details.subscription`, not at
 *      a top-level field. `stripeInvoiceSubscriptionId` reads all three
 *      spellings; reading one leaves every invoice with no agreement, no
 *      warning, and no null to notice.
 *
 * Docs: https://docs.stripe.com/api/invoices/list, .../invoice-line-items,
 * .../charges/list, .../refunds/list, .../invoice-payment/list
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession, type ProviderSession } from "../http";
import {
  flattenInvoicePaymentIndex,
  flattenStripeCharge,
  flattenStripeInvoice,
  flattenStripeInvoiceLine,
  flattenStripeRefund,
  invoiceIdFromIndex,
  invoiceLines,
  invoiceLinesComplete,
  invoiceLinesUrl,
  listUrl,
  parseListPage,
  stripePageSize,
  STRIPE_MAX_PAGES,
} from "./api";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

/**
 * Every line on one invoice, completed if Stripe truncated the list.
 *
 * The invoice-line twin of `completeItems` in the agreement handler, written
 * separately rather than generalized: the two differ in their URL, their
 * inlined field name and their record shape, and a shared abstraction would
 * have to branch on all three.
 *
 * It **throws** when the page bound is hit rather than returning what it has.
 * A short list is what licenses the writer to delete live lines, so "too many
 * pages" must fail the run: a failed sync costs a retry, and a successful one
 * that deleted live data costs the data.
 *
 * The starting cursor is the last *inlined* line rather than nothing, because
 * the endpoint returns the same list from the top and re-fetching the first
 * page would duplicate ten rows into the result.
 */
async function completeInvoiceLines(
  session: ProviderSession,
  invoice: RawRecord
): Promise<readonly RawRecord[]> {
  const inlined = invoiceLines(invoice);
  if (invoiceLinesComplete(invoice)) return inlined;

  const invoiceId = asString(invoice["id"]);
  if (invoiceId === undefined) {
    throw new Error(
      "Invoice has more lines than Stripe inlined but carries no id; cannot complete its line list"
    );
  }

  const perPage = stripePageSize();
  const lines = [...inlined];
  let cursor = asString(lines[lines.length - 1]?.["id"]);
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(invoiceLinesUrl(invoiceId, perPage, cursor))
    );
    lines.push(...body.records);

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) {
      throw new Error(
        `Invoice '${invoiceId}' has more line pages than ${STRIPE_MAX_PAGES} allows; refusing to sync a partial line list`
      );
    }

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }

  return lines;
}

/**
 * One page of invoices flat-mapped to the line records they carry.
 *
 * The same fan-out shape as `itemRecords` one function over: N source records
 * become M > N target records, keyed on each line's own `il_…` at `id`. The
 * invoice id is injected from the invoice actually fetched, never read off the
 * line's own `invoice` field — this is a writer that deletes, so a line must
 * not be able to name a different parent.
 */
async function invoiceLineRecords(
  session: ProviderSession,
  invoices: readonly RawRecord[]
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];

  for (const invoice of invoices) {
    const invoiceId = asString(invoice["id"]);
    if (invoiceId === undefined) continue;

    const lines = await completeInvoiceLines(session, invoice);
    lines.forEach((line) => {
      records.push({
        ...line,
        ...flattenStripeInvoiceLine(line, invoiceId),
      });
    });
  }

  return records;
}

/**
 * One page of invoices, yielding the invoice page and then its line page.
 *
 * Two pages out of one fetch, as `pageSubscriptions` does, for the same reason:
 * fetching twice would double the API cost for identical bytes and could
 * observe the invoice changing between passes.
 *
 * Only the line page declares `complete: true`, and it may because
 * `invoiceLineRecords` finishes every invoice's list before returning. The
 * invoice page reconciles nothing.
 */
async function* pageInvoices(
  session: ProviderSession,
  objects: readonly TargetObject[]
): AsyncGenerator<SourcePage> {
  const perPage = stripePageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(listUrl("invoices", perPage, cursor))
    );

    const records = body.records.map((record: RawRecord) => ({
      ...record,
      ...flattenStripeInvoice(record),
    }));

    for (const object of objects) {
      yield object === "invoiceLine"
        ? {
            object,
            records: await invoiceLineRecords(session, records),
            complete: true,
          }
        : { object, records };
    }

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }
}

/**
 * Build the payment-intent → invoice index from `/v1/invoice_payments`.
 *
 * Read once, before charges and refunds, because both need it at yield time. A
 * page bound hit here leaves the index partial, which degrades every unresolved
 * link to a null plus a warning — never a wrong link. That is why this loop
 * does not throw where `completeInvoiceLines` does: an incomplete *index*
 * loses links, an incomplete *line list* deletes rows.
 */
async function buildInvoicePaymentIndex(
  session: ProviderSession
): Promise<Map<string, string>> {
  const perPage = stripePageSize();
  const index = new Map<string, string>();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(listUrl("invoice_payments", perPage, cursor))
    );

    for (const [key, invoiceId] of flattenInvoicePaymentIndex(body.records)) {
      index.set(key, invoiceId);
    }

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }

  return index;
}

/**
 * One page of charges, as `payment` rows of kind `payment`.
 *
 * A charge whose intent is absent from the index resolves to `invoice_id:
 * undefined`, which `externalRefsOf` turns into no invoice ref at all — the
 * writer warns and leaves the link null rather than guessing.
 */
async function* pageCharges(
  session: ProviderSession,
  index: ReadonlyMap<string, string>
): AsyncGenerator<SourcePage> {
  yield* pagePayments(session, "charges", index, flattenStripeCharge);
}

/** One page of refunds, as `payment` rows of kind `refund`. */
async function* pageRefunds(
  session: ProviderSession,
  index: ReadonlyMap<string, string>
): AsyncGenerator<SourcePage> {
  yield* pagePayments(session, "refunds", index, flattenStripeRefund);
}

/**
 * One paginated list of movements, decorated by the caller's flattener.
 *
 * Shared because charges and refunds differ only in their resource name and the
 * function that turns one into a payment row.
 */
async function* pagePayments(
  session: ProviderSession,
  resource: "charges" | "refunds",
  index: ReadonlyMap<string, string>,
  decorate: (
    record: RawRecord,
    invoiceId: string | undefined
  ) => RawRecord
): AsyncGenerator<SourcePage> {
  const perPage = stripePageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(listUrl(resource, perPage, cursor))
    );

    yield {
      object: "payment",
      records: body.records.map((record: RawRecord) => ({
        ...record,
        ...decorate(record, invoiceIdFromIndex(record, index)),
      })),
    };

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }
}

export const stripeBillingHandler: SyncHandler = {
  objects: ["invoice", "invoiceLine", "payment"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    // Each pass is gated on a mapping rule targeting its object, as the catalog
    // and agreement handlers gate theirs. An integration that maps only
    // invoices pays for neither charges nor refunds, and neither pays for the
    // index they share.
    const invoicesMapped =
      (ctx.requestedSourcePaths.get("invoice") ?? []).length > 0;
    const linesMapped =
      (ctx.requestedSourcePaths.get("invoiceLine") ?? []).length > 0;
    const paymentsMapped =
      (ctx.requestedSourcePaths.get("payment") ?? []).length > 0;

    if (invoicesMapped || linesMapped) {
      // The line page needs the invoice fetch, so it turns that pass on even
      // when the invoice object itself is unmapped. Parent first, because
      // `invoiceLine`'s invoice FK is required.
      const objects: TargetObject[] = [];
      if (invoicesMapped) objects.push("invoice");
      if (linesMapped) objects.push("invoiceLine");
      yield* pageInvoices(session, objects);
    }

    if (paymentsMapped) {
      const index = await buildInvoicePaymentIndex(session);
      yield* pageCharges(session, index);
      yield* pageRefunds(session, index);
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // An invoice's own `in_…`, a charge's `ch_…`, a refund's `re_…` and an
    // invoice line's `il_…` all sit at `id`, exactly as a subscription's does.
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // Both parents are optional: either function may be off this
      // integration, and the ids are retained on the row so a later relink can
      // complete them.
      case "invoice":
        return {
          customer: asString(record["customer_id"]),
          agreement: asString(record["agreement_id"]),
        };

      // The invoice is the injected `invoice_id`, never the line's own
      // `invoice` field. Offering and price are the two halves of what was
      // sold and at which of its prices.
      case "invoiceLine":
        return {
          invoice: asString(record["invoice_id"]),
          offering: asString(record["offering_id"]),
          price: asString(record["price_id"]),
        };

      // The invoice comes from the `InvoicePayment` index, so it is absent
      // whenever the index had no entry — a charge raised outside an invoice,
      // or an index page lost to the bound. Absent means "not linked", and the
      // writer warns rather than guessing.
      case "payment":
        return {
          invoice: asString(record["invoice_id"]),
          customer: asString(record["customer_id"]),
        };

      default:
        return {};
    }
  },
};
