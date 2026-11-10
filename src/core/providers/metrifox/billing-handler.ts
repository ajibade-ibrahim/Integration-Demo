/**
 * Metrifox's `billing` function: invoice summaries only.
 *
 * Everything here follows from two API facts: **there is no invoice list and no
 * invoice read**, and **there is no payment list**. The only invoice-shaped
 * source is `GET /api/v1/subscriptions/{subscription_id}/billing-history`, so
 * the handler pages customers, reads each customer's subscriptions from the
 * details payload, and then asks billing history once per unique subscription.
 *
 * That fan-out is the whole cost of this function: one customers pass, one
 * details request per customer, and one billing-history request per unique
 * subscription. With identity and agreement also selected the customers list is
 * paginated three times and details twice; that is documented rather than
 * hidden, because a future list endpoint should replace it.
 *
 * Five rules carry the risk:
 *
 *   1. **Invoices are upsert-only.** No page declares `complete`, no deletion,
 *      no reconciliation. A subscription that stops returning an invoice leaves
 *      the stored row in place, exactly as agreements and subscriptions behave.
 *      A `draft` invoice is ignored entirely: it is not a bill yet, has no
 *      number, and may not have been issued. Ignoring it happens before the
 *      invoice dedupe so a draft cannot claim an id an issued copy should own.
 *
 *   2. **The customer ref is the customers-list `id`.** Identity keys customer
 *      rows on that id; the details payload's own `metrifox_id` and
 *      `customer_key` would never resolve. The agreement is the subscription id
 *      whose history returned the invoice.
 *
 *   3. **Current before history, first copy wins, globally.** A subscription
 *      repeated in `subscriptions_history[]` or on another customer page is
 *      fetched once. An invoice repeated under several subscriptions is written
 *      once and linked to the first subscription and customer observed; the
 *      subscription id is kept in `provider_metadata`. The API does not state a
 *      single owner for a consolidated invoice, so this is a best effort on the
 *      edges and the document itself — number, amounts, dates — is unaffected.
 *
 *   4. **Amounts are standard units, converted once.** `total_amount`,
 *      `amount_paid` and `balance_due` are major units; they become
 *      `total_amount_minor`, `amount_paid_minor` and `balance_due_minor` using
 *      the currency exponent. Credit notes keep their negative sign. When the
 *      currency is missing or invalid the minor amounts stay absent, and the
 *      raw figures remain in `provider_metadata`.
 *
 *   5. **A 404 is a vanished customer or subscription, not a failed run; all
 *      unusable is a failed run.** One 404 details call skips that customer,
 *      and one 404 history call skips that subscription. But if details were
 *      attempted and none were usable — the built-in fake serves customers only
 *      and 404s `/details` — the handler throws, because a zero-invoice
 *      "success" is exactly what a wrong base or a changed response shape would
 *      otherwise produce. The same guard applies when every history call was
 *      unusable. `data: []` is usable and means "no invoices yet".
 *
 * The built-in fake deliberately gains no billing endpoints: it serves customer
 * identity only. Tests use msw; manual billing checks need the real API.
 *
 * Docs: https://docs.metrifox.com/api-reference/subscriptions/billing-history
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession } from "../http";
import { ProviderHttpError } from "../../sync/errors";
import {
  customerDetailsUrl,
  customersUrl,
  flattenMetrifoxInvoice,
  METRIFOX_MAX_PAGES,
  metrifoxInvoiceStatus,
  metrifoxPageSize,
  parseBillingHistory,
  parseCustomerDetails,
  parseCustomersPage,
  subscriptionBillingHistoryUrl,
} from "./api";
import { METRIFOX_SESSION_OPTIONS } from "./identity-handler";

export const metrifoxBillingHandler: SyncHandler = {
  objects: ["invoice"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    // The fan-out costs a details request per customer and a history request
    // per subscription. A site that maps no invoice target pays nothing.
    const invoicesMapped =
      (ctx.requestedSourcePaths.get("invoice") ?? []).length > 0;
    if (!invoicesMapped) return;

    const session = createProviderSession(
      ctx,
      "Metrifox",
      METRIFOX_SESSION_OPTIONS
    );

    const perPage = metrifoxPageSize();

    // Across the whole run: a subscription repeated in history, or on another
    // customer page, is fetched once and linked to the first customer seen.
    const seenSubscriptions = new Set<string>();
    // First-wins across subscriptions: an invoice returned under several
    // subscriptions is written once, linked to the first observed.
    const seenInvoices = new Set<string>();

    let detailsAttempted = 0;
    let detailsUsable = 0;
    let historyAttempted = 0;
    let historyUsable = 0;

    let page: number | undefined = 1;
    let pagesFetched = 0;

    while (page !== undefined && pagesFetched < METRIFOX_MAX_PAGES) {
      const body = parseCustomersPage(
        await session.getJson(customersUrl(page, perPage))
      );

      for (const customer of body.customers) {
        const customerId = asString(customer["id"]);
        const customerKey = asString(customer["customer_key"]);

        // No list id means no customer ref for the invoice to hang off; no key
        // means no details endpoint to call. Either way the customer cannot be
        // read, so it is skipped rather than emitted broken.
        if (customerId === undefined || customerKey === undefined) continue;

        detailsAttempted += 1;

        let details;
        try {
          details = parseCustomerDetails(
            await session.getJson(customerDetailsUrl(customerKey))
          );
        } catch (error) {
          // The customer vanished between pages, or has no details resource.
          if (error instanceof ProviderHttpError && error.status === 404) {
            continue;
          }
          throw error;
        }

        // A present-but-non-array `data.subscriptions` is a malformed response,
        // not an empty account. The all-unusable guard below is what stops that
        // becoming a silent zero-invoice success.
        if (details.groups === undefined) continue;

        detailsUsable += 1;

        const invoices: RawRecord[] = [];

        for (const group of details.groups) {
          // Current first, history second — the agreement handler's rule. Here
          // it decides which copy of a repeated subscription is fetched first,
          // and therefore which customer owns a duplicate invoice.
          const ordered: RawRecord[] = [
            ...(group.current === undefined ? [] : [group.current]),
            ...group.history,
          ];

          for (const subscription of ordered) {
            const subscriptionId = asString(subscription["id"]);
            // No id means no billing-history path and no agreement ref.
            if (subscriptionId === undefined) continue;
            if (seenSubscriptions.has(subscriptionId)) continue;
            seenSubscriptions.add(subscriptionId);

            historyAttempted += 1;

            let rows;
            try {
              rows = parseBillingHistory(
                await session.getJson(
                  subscriptionBillingHistoryUrl(subscriptionId)
                )
              );
            } catch (error) {
              // A subscription canceled between details and history is the
              // ordinary case. One missing history must not fail the run.
              if (error instanceof ProviderHttpError && error.status === 404) {
                continue;
              }
              throw error;
            }

            // `undefined` is a 200 we could not read. Same treatment as a 404,
            // and for the same reason: never let an unreadable list turn into
            // an empty success.
            if (rows === undefined) continue;

            historyUsable += 1;

            for (const row of rows) {
              const invoiceId = asString(row["invoice_id"]);
              // No id means no upsert key. A stray raw `id` is deliberately not
              // used: the billing-history row's documented key is `invoice_id`,
              // and keying on an unnamed field would create a row the next run
              // cannot find again.
              if (invoiceId === undefined) continue;

              // Drafts are not bills yet: ignore them entirely rather than
              // writing a row that carries a number-less, not-yet-issued
              // document. The check happens before the dedupe set so a draft
              // cannot claim an invoice id that a later issued copy should own.
              // A history containing only drafts is still a usable response.
              if (metrifoxInvoiceStatus(row["status"]) === "draft") continue;

              if (seenInvoices.has(invoiceId)) continue;
              seenInvoices.add(invoiceId);

              invoices.push(
                flattenMetrifoxInvoice(row, customerId, subscriptionId)
              );
            }
          }
        }

        // Empty pages are unnecessary: invoices are upsert-only, so there is no
        // completeness signal for an empty page to carry.
        if (invoices.length > 0) {
          yield { object: "invoice", records: invoices };
        }
      }

      // Only advance on a strictly larger page number, the identity handler's
      // echoed-page guard.
      const next = body.nextPage;
      page = next !== undefined && next > page ? next : undefined;
      pagesFetched += 1;
    }

    if (detailsAttempted > 0 && detailsUsable === 0) {
      throw new Error(
        "Metrifox billing sync failed: no customer details response was usable. " +
          "The built-in fake Metrifox serves customers only and does not serve " +
          "`/details`; check METRIFOX_API_BASE and the details response shape."
      );
    }

    if (historyAttempted > 0 && historyUsable === 0) {
      throw new Error(
        "Metrifox billing sync failed: no billing-history response was usable. " +
          "Check the subscription ids, METRIFOX_API_BASE and the billing-history " +
          "response shape."
      );
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // `invoice_id` only. A row without it was skipped before yielding, and a
    // raw `id` would key the invoice on a field the API did not name.
    return asString(record["invoice_id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // Both are injected by the handler: the customer is the customers-list
      // id identity already keys on; the agreement is the subscription whose
      // billing history returned the invoice.
      case "invoice":
        return {
          customer: asString(record["customer_id"]),
          agreement: asString(record["agreement_id"]),
        };
      default:
        return {};
    }
  },
};
