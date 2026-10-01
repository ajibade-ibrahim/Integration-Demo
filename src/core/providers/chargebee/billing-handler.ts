/**
 * Chargebee's `billing` function: invoices, their inline lines, and the money
 * that moved.
 *
 * Chargebee is the mirror image of Stripe here, in the ways that matter:
 *
 *   1. **Lines are inline.** `/api/v2/invoices` carries each `line_items` array
 *      in the list payload, so a line needs no second request — where Stripe
 *      inlines only ten and must page for the rest. The absence of the key is
 *      still possible, and is the whole reason the line page withholds
 *      `complete` when one is missing: an absent list would otherwise read as
 *      "this invoice has no lines", which licenses deleting every line of every
 *      invoice written this run.
 *   2. **The invoice link is on the transaction.** A Chargebee transaction
 *      names its invoice through `linked_invoices`, so there is no index to
 *      build — unlike Stripe, where a charge carries no invoice at all. The
 *      link is present only for a `payment`, so a refund legitimately leaves it
 *      null.
 *   3. **Authorizations are dropped.** A `transaction.type` of `authorization`
 *      moves no money; writing a `payment` row for one would overstate what the
 *      customer paid. This table is movements, not attempts.
 *   4. **Consolidated invoicing.** An invoice whose lines span several
 *      subscriptions has no `subscription_id`, and the whole invoice must not be
 *      linked to one of them. `agreementId` stays null and the state is
 *      recorded in `providerMetadata` as `subscription_id: "consolidated"`.
 *
 * Docs: https://apidocs.chargebee.com/docs/api/invoices,
 * .../docs/api/transactions
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession } from "../http";
import {
  chargebeePageSize,
  CHARGEBEE_MAX_PAGES,
  flattenChargebeeInvoice,
  flattenChargebeeInvoiceLine,
  flattenChargebeeTransaction,
  hasLineItemsKey,
  invoiceLineItems,
  parseChargebeeCredential,
  parseInvoicesPage,
  parseTransactionsPage,
  invoicesUrl,
  transactionsUrl,
} from "./api";
import { CHARGEBEE_SESSION_OPTIONS } from "./catalog-handler";

export const chargebeeBillingHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Chargebee",
      CHARGEBEE_SESSION_OPTIONS
    );

    const site =
      ctx.metadata["site"] ?? parseChargebeeCredential(ctx.accessToken).site;
    if (site === undefined || site === "") {
      throw new Error(
        "Chargebee billing sync failed: missing site in integration metadata"
      );
    }

    const perPage = chargebeePageSize();

    const invoicesMapped =
      (ctx.requestedSourcePaths.get("invoice") ?? []).length > 0;
    const linesMapped =
      (ctx.requestedSourcePaths.get("invoiceLine") ?? []).length > 0;
    const paymentsMapped =
      (ctx.requestedSourcePaths.get("payment") ?? []).length > 0;

    if (invoicesMapped || linesMapped) {
      let offset: string | undefined;
      let pagesFetched = 0;

      for (;;) {
        const body = parseInvoicesPage(
          await session.getJson(invoicesUrl(site, perPage, offset))
        );

        const invoices: RawRecord[] = [];
        const lines: RawRecord[] = [];
        // ANDed across invoices and pages: one invoice whose payload omitted
        // `line_items` withholds the guarantee for the whole object.
        let pageLinesComplete = true;

        for (const invoice of body.records) {
          const invoiceId = asString(invoice["id"]);
          // No id means no upsert key and no invoice to hang lines off.
          if (invoiceId === undefined) continue;

          invoices.push({
            ...invoice,
            ...flattenChargebeeInvoice(invoice),
          });

          if (!hasLineItemsKey(invoice)) pageLinesComplete = false;

          invoiceLineItems(invoice).forEach((line) => {
            // A line with no id cannot be reconciled reliably, so it is skipped
            // rather than keyed positionally — unlike subscription items, a
            // Chargebee invoice line carries a real id, so there is no need for
            // a positional fallback.
            if (asString(line["id"]) === undefined) return;
            lines.push({
              ...line,
              ...flattenChargebeeInvoiceLine(line, invoiceId),
            });
          });
        }

        if (invoicesMapped) yield { object: "invoice", records: invoices };
        if (linesMapped) {
          yield {
            object: "invoiceLine",
            records: lines,
            complete: pageLinesComplete,
          };
        }

        pagesFetched += 1;
        if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

        if (body.nextOffset === undefined || body.nextOffset === offset) break;
        offset = body.nextOffset;
      }
    }

    if (paymentsMapped) {
      let offset: string | undefined;
      let pagesFetched = 0;

      for (;;) {
        const body = parseTransactionsPage(
          await session.getJson(transactionsUrl(site, perPage, offset))
        );

        const payments: RawRecord[] = [];
        for (const transaction of body.records) {
          const flattened: RawRecord = {
            ...transaction,
            ...flattenChargebeeTransaction(transaction),
          };
          // An authorization carries no `kind`, and is dropped rather than
          // written as a movement that never happened. The filter is on the
          // flattened `kind` so it stays correct if the type table grows.
          if (asString(flattened["kind"]) === undefined) continue;
          payments.push(flattened);
        }

        yield { object: "payment", records: payments };

        pagesFetched += 1;
        if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

        if (body.nextOffset === undefined || body.nextOffset === offset) break;
        offset = body.nextOffset;
      }
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // An invoice, an invoice line and a transaction each carry their own real
    // id, so one read serves all three.
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // The customer link is real; the agreement link is present only when the
      // invoice names exactly one subscription. A consolidated invoice leaves
      // it absent on purpose — see the module comment.
      case "invoice":
        return {
          customer: asString(record["customer_id"]),
          agreement: asString(record["agreement_id"]),
        };

      // The invoice is the injected `invoice_id`, never the line's own
      // `invoice_id`. The price is the item price an item-shaped line went for;
      // no offering ref, because the list payload does not inline it.
      case "invoiceLine":
        return {
          invoice: asString(record["invoice_id"]),
          price: asString(record["price_id"]),
        };

      // Both come from the payload: `linked_invoices` supplies the invoice for
      // a payment, and `customer_id` is always there.
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
