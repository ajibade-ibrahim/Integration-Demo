/**
 * Metrifox's `agreement` function: subscriptions as agreements, their inline
 * lines, and their effective entitlements.
 *
 * Everything here follows from one API fact: **Metrifox publishes no list
 * endpoint for subscriptions or orders.** `GET /api/v1/customers` is the only
 * paged list, and the only list-shaped subscription source is
 * `GET /customers/{customer_key}/details`, which groups a customer's
 * subscriptions by product. So the handler pages customers and calls details
 * once per customer. With identity selected too the customers list is paginated
 * twice — the two handlers cannot share state — and every customer costs a
 * details request in each run. That is the documented cost of the public API; a
 * future list endpoint should replace the fan-out.
 *
 * Four rules carry the risk:
 *
 *   1. **Current before history, first copy wins.** Each group carries the
 *      current `subscription` beside `subscriptions_history[]`, and the API's
 *      own example repeats the current subscription in its history. Reading
 *      history first would let a stale copy overwrite the fresh one. So the
 *      current record is processed first and a subscription id seen once is
 *      skipped for the rest of the run.
 *
 *   2. **The customer id must be the customers-list `id`.** Identity keys
 *      customer rows on that id; the details payload's own `metrifox_id` and
 *      `customer_key` would never resolve, so the agreement's customer link
 *      would warn on every run without ever joining.
 *
 *   3. **Completeness is a deletion licence.** `agreementItem` declares
 *      `complete: true` only when every emitted subscription carried a
 *      `subscription_items` **array** — an absent or non-array key withholds
 *      it. `agreementEntitlement` additionally must yield a page for every
 *      customer that produced a subscription, even an empty one: the gated
 *      writer reads a written agreement with no entitlement rows as "has no
 *      entitlements" and deletes. Omitting the page would delete data this run
 *      never checked.
 *
 *   4. **A 404 details call is a vanished customer, not a failed run.** It is
 *      skipped, and a customer whose `data.subscriptions` is not an array is
 *      skipped too. If details were attempted and *none* were usable, the
 *      handler throws: a silent zero-agreement "success" is exactly what the
 *      fake Metrifox (which serves customers only and 404s `/details`), a wrong
 *      `METRIFOX_API_BASE`, or a changed response shape would otherwise
 *      produce.
 *
 * Orders are deliberately not read: the public API has no order read endpoint
 * at all, which is why the provider's agreement scope no longer claims one.
 *
 * Docs: https://docs.metrifox.com/api-reference/customers/get-customer-details
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
  flattenMetrifoxAgreementEntitlement,
  flattenMetrifoxSubscription,
  flattenMetrifoxSubscriptionItem,
  METRIFOX_MAX_PAGES,
  metrifoxPageSize,
  parseCustomerDetails,
  parseCustomersPage,
  parseEntitlementsSummary,
  subscriptionEntitlementsSummaryUrl,
  subscriptionItems,
} from "./api";
import { METRIFOX_SESSION_OPTIONS } from "./identity-handler";

export const metrifoxAgreementHandler: SyncHandler = {
  objects: [
    "agreement",
    "subscription",
    "agreementItem",
    "agreementEntitlement",
  ],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Metrifox",
      METRIFOX_SESSION_OPTIONS
    );

    const perPage = metrifoxPageSize();

    // The entitlement summary is one request per subscription, so it is gated
    // on a mapping rule the way Chargebee's fan-out is. A site that maps no
    // entitlement target pays nothing for this pass.
    const entitlementsMapped =
      (ctx.requestedSourcePaths.get("agreementEntitlement") ?? []).length > 0;

    // Across the whole run, so a subscription repeated in history — or on a
    // second customer page — is emitted once, with the first (freshest) copy
    // winning.
    const seenSubscriptions = new Set<string>();

    let detailsAttempted = 0;
    let detailsUsable = 0;

    let page: number | undefined = 1;
    let pagesFetched = 0;

    while (page !== undefined && pagesFetched < METRIFOX_MAX_PAGES) {
      const body = parseCustomersPage(
        await session.getJson(customersUrl(page, perPage))
      );

      for (const customer of body.customers) {
        const customerId = asString(customer["id"]);
        const customerKey = asString(customer["customer_key"]);

        // No list id means no ref for the agreement to hang off; no key means
        // no details endpoint to call. Either way this customer cannot be
        // synced, so it is skipped rather than emitted broken.
        if (customerId === undefined || customerKey === undefined) continue;

        detailsAttempted += 1;

        let details;
        try {
          details = parseCustomerDetails(
            await session.getJson(customerDetailsUrl(customerKey))
          );
        } catch (error) {
          // The customer vanished between pages, or has no details resource.
          // One missing customer must not fail the whole run.
          if (error instanceof ProviderHttpError && error.status === 404) {
            continue;
          }
          throw error;
        }

        // A present-but-non-array `data.subscriptions` is a malformed response,
        // not an empty account. Skipping keeps the run alive; the all-unusable
        // guard below is what stops that becoming a silent success.
        if (details.groups === undefined) continue;

        detailsUsable += 1;

        const agreements: RawRecord[] = [];
        const subscriptions: RawRecord[] = [];
        const items: RawRecord[] = [];
        const entitlements: RawRecord[] = [];

        let itemsComplete = true;
        let entitlementsComplete = true;
        let producedSubscription = false;

        for (const group of details.groups) {
          // Current first, history second — see the header.
          const ordered: RawRecord[] = [
            ...(group.current === undefined ? [] : [group.current]),
            ...group.history,
          ];

          for (const subscription of ordered) {
            const subscriptionId = asString(subscription["id"]);
            // No id means no upsert key and no way to name its children.
            if (subscriptionId === undefined) continue;
            if (seenSubscriptions.has(subscriptionId)) continue;
            seenSubscriptions.add(subscriptionId);

            producedSubscription = true;

            // Spread first, so the synthesized fields win where names collide.
            const flattened: RawRecord = {
              ...subscription,
              ...flattenMetrifoxSubscription(subscription, customerId),
            };

            agreements.push(flattened);
            subscriptions.push(flattened);

            const offeringKey = asString(subscription["offering_key"]);
            subscriptionItems(subscription).forEach((item, position) => {
              items.push({
                ...item,
                ...flattenMetrifoxSubscriptionItem(
                  item,
                  subscriptionId,
                  offeringKey,
                  position
                ),
              });
            });

            // The key-presence gate, not the array length: an absent or
            // non-array key would otherwise look exactly like "no lines" and
            // license deleting every stored line.
            if (!Array.isArray(subscription["subscription_items"])) {
              itemsComplete = false;
            }

            if (!entitlementsMapped) continue;

            let summary;
            try {
              summary = parseEntitlementsSummary(
                await session.getJson(
                  subscriptionEntitlementsSummaryUrl(subscriptionId)
                )
              );
            } catch (error) {
              // A 404 means the entitlement feature is not available for this
              // subscription. Withholding `complete` disables entitlement
              // deletion for the whole run; the agreements, subscriptions and
              // lines still sync.
              if (error instanceof ProviderHttpError && error.status === 404) {
                entitlementsComplete = false;
                continue;
              }
              throw error;
            }

            // `undefined` is a 200 we could not read. Same treatment as a 404,
            // and for the same reason: never let an unreadable list delete.
            if (summary === undefined) {
              entitlementsComplete = false;
              continue;
            }

            summary.forEach((row, position) => {
              entitlements.push({
                ...row,
                ...flattenMetrifoxAgreementEntitlement(
                  row,
                  subscriptionId,
                  position
                ),
              });
            });
          }
        }

        // A customer with no subscriptions writes nothing and needs no pages.
        if (!producedSubscription) continue;

        yield { object: "agreement", records: agreements };
        yield { object: "subscription", records: subscriptions };
        // The engine ANDs `complete` across pages, so a later customer that
        // carried the key cannot rescue an earlier one that did not.
        yield {
          object: "agreementItem",
          records: items,
          complete: itemsComplete,
        };

        if (entitlementsMapped) {
          // Always yielded for a customer that produced subscriptions, even
          // when empty. This is the page the gated writer needs: an agreement
          // with no entitlement rows is read as "has none" and reconciled.
          yield {
            object: "agreementEntitlement",
            records: entitlements,
            complete: entitlementsComplete,
          };
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
        "Metrifox agreement sync failed: no customer details response was usable. " +
          "The built-in fake Metrifox serves customers only and does not serve " +
          "`/details`; check METRIFOX_API_BASE and the details response shape."
      );
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // A line carries the synthesized `item_id`; an entitlement carries either
    // the summary row's own `id` or, when that was absent, the injected
    // `entitlement_row_id`. Agreement and subscription carry Metrifox's
    // subscription id. The synthetic keys are checked first so they cannot be
    // shadowed by a raw field.
    return (
      asString(record["item_id"]) ??
      asString(record["id"]) ??
      asString(record["entitlement_row_id"])
    );
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // The customer is the customers-list id identity already keys on; the
      // offering is the subscription's product. The offering ref warns until a
      // Metrifox catalog handler exists, which is expected.
      case "agreement":
        return {
          customer: asString(record["customer_id"]),
          offering: asString(record["offering_key"]),
        };

      // Same source record, same provider id, its own table.
      case "subscription":
        return { agreement: asString(record["id"]) };

      // The agreement is the injected `agreement_id`, not a payload field. The
      // offering is present only on a plan line; the price is the option this
      // line went for.
      case "agreementItem":
        return {
          agreement: asString(record["agreement_id"]),
          offering: asString(record["offering_id"]),
          price: asString(record["price_id"]),
        };

      // Both come from injected keys: the agreement from the subscription this
      // summary was fetched for, the feature from `feature_key`.
      case "agreementEntitlement":
        return {
          agreement: asString(record["agreement_id"]),
          feature: asString(record["feature_id"]),
        };

      default:
        return {};
    }
  },
};
