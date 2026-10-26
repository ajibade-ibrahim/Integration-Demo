/**
 * Chargebee's `agreement` function: subscriptions as agreements, their inline
 * lines, their effective entitlements, and their discounts.
 *
 * Four things here are Chargebee-shaped rather than ours, and each is the
 * opposite of the Stripe handler's corresponding problem:
 *
 *   1. **Lines are inline.** `/api/v2/subscriptions` carries each
 *      `subscription_items` array in the list payload, so a line needs no
 *      second request — where Stripe inlines only the first ten and must page
 *      `/v1/subscription_items`. A missing `subscription_items` key is still
 *      possible, and is why the item page withholds its `complete` flag when
 *      one is absent: absence would otherwise read as "no lines".
 *   2. **Entitlements are a per-subscription fan-out.** The effective list
 *      lives at `/subscriptions/{id}/subscription_entitlements`, itself
 *      paginated, so this handler pages each subscription to exhaustion. The
 *      fan-out is gated on a mapping rule targeting `agreementEntitlement`, the
 *      same way the catalog handler gates its own entitlement pass.
 *   3. **No name and no item price.** Chargebee gives a subscription no name
 *      and does not inline the item price, so `agreement_name` is the plan
 *      line's `item_price_id`. A nicer label needs the item price object; that
 *      is one request per subscription and is deliberately not paid here.
 *   4. **The Entitlements feature can be off.** When it is, the endpoint 404s.
 *      A 404 is not retryable and would fail the run uncaught, so it is caught
 *      here, the entitlement page withholds `complete` so nothing is deleted,
 *      and the agreement records `site_feature_disabled` so the behaviour is
 *      visible rather than silent.
 *
 * Docs: https://apidocs.chargebee.com/docs/api/subscriptions
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
  chargebeePageSize,
  CHARGEBEE_MAX_PAGES,
  flattenChargebeeDiscount,
  flattenChargebeeSubscription,
  flattenChargebeeSubscriptionEntitlement,
  flattenChargebeeSubscriptionItem,
  hasDiscountsKey,
  hasSubscriptionItemsKey,
  parseChargebeeCredential,
  parseSubscriptionEntitlementsPage,
  parseSubscriptionsPage,
  subscriptionDiscounts,
  subscriptionEntitlementsUrl,
  subscriptionItems,
  subscriptionsUrl,
  type ChargebeeListPage,
} from "./api";
import { CHARGEBEE_SESSION_OPTIONS } from "./catalog-handler";

/**
 * The metadata key written onto an agreement when the site has no Entitlements
 * feature, so `/agreements` and the run report can show why the entitlement
 * list is empty rather than looking like a subscription with none.
 */
const ENTITLEMENTS_DISABLED_KEY = "entitlements";
const ENTITLEMENTS_DISABLED_VALUE = "site_feature_disabled";

/**
 * Page one list endpoint to the end, reporting whether it was reached.
 *
 * `complete` is the whole reason this does not reuse the catalog handler's
 * `pageList`: that one yields records and discards the stopping reason, which
 * is right for an upsert-only pass and wrong here. Hitting `CHARGEBEE_MAX_PAGES`
 * means the list is *not* whole, and a reconciling writer must be told so — a
 * partial list that claims completeness licenses a wrongful delete.
 */
async function collectPages(
  fetchPage: (offset: string | undefined) => Promise<ChargebeeListPage>
): Promise<{ records: RawRecord[]; complete: boolean }> {
  const records: RawRecord[] = [];
  let offset: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = await fetchPage(offset);
    records.push(...body.records);

    pagesFetched += 1;
    if (pagesFetched >= CHARGEBEE_MAX_PAGES) {
      return { records, complete: false };
    }

    if (body.nextOffset === undefined || body.nextOffset === offset) break;
    offset = body.nextOffset;
  }

  return { records, complete: true };
}

export const chargebeeAgreementHandler: SyncHandler = {
  objects: [
    "agreement",
    "subscription",
    "agreementItem",
    "agreementEntitlement",
    "agreementDiscount",
  ],
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
        "Chargebee agreement sync failed: missing site in integration metadata"
      );
    }

    const perPage = chargebeePageSize();

    // The two optional passes are gated on a mapping rule, as the catalog
    // handler gates its entitlement pass. A site that does not map entitlements
    // pays nothing for them, which matters because this one is a request per
    // subscription.
    const entitlementsMapped =
      (ctx.requestedSourcePaths.get("agreementEntitlement") ?? []).length > 0;
    const discountsMapped =
      (ctx.requestedSourcePaths.get("agreementDiscount") ?? []).length > 0;

    // Set on the first 404 and never cleared: the endpoint 404s because the
    // Entitlements feature is off for the whole site, not for one subscription,
    // so every later request would 404 too. Each agreement still records the
    // flag, so the withholding is visible on every row rather than only the
    // first.
    let entitlementsSiteDisabled = false;

    let offset: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseSubscriptionsPage(
        await session.getJson(subscriptionsUrl(site, perPage, offset))
      );

      const agreements: RawRecord[] = [];
      const subscriptions: RawRecord[] = [];
      const items: RawRecord[] = [];
      const discounts: RawRecord[] = [];
      let pageItemsComplete = true;
      let pageDiscountsComplete = true;

      for (const subscription of body.records) {
        const subscriptionId = asString(subscription["id"]);
        // No id means no upsert key and no way to name the parent, so the
        // record is skipped. The writer's rejection path would say the same
        // thing less specifically.
        if (subscriptionId === undefined) continue;

        const extraMetadata: Record<string, string> = {};

        if (entitlementsMapped) {
          if (entitlementsSiteDisabled) {
            extraMetadata[ENTITLEMENTS_DISABLED_KEY] =
              ENTITLEMENTS_DISABLED_VALUE;
          } else {
            try {
              const page = await collectPages((next) =>
                session
                  .getJson(
                    subscriptionEntitlementsUrl(site, subscriptionId, perPage, next)
                  )
                  .then(parseSubscriptionEntitlementsPage)
              );

              yield {
                object: "agreementEntitlement",
                records: page.records.map((record: RawRecord) => ({
                  ...record,
                  ...flattenChargebeeSubscriptionEntitlement(subscriptionId),
                })),
                // Each subscription's page carries its own verdict; the engine
                // ANDs them, so one exhausted-but-empty list reconciles that
                // agreement down to nothing while a withheld one disables
                // deletion for the object entirely.
                complete: page.complete,
              };
            } catch (error) {
              if (error instanceof ProviderHttpError && error.status === 404) {
                entitlementsSiteDisabled = true;
                extraMetadata[ENTITLEMENTS_DISABLED_KEY] =
                  ENTITLEMENTS_DISABLED_VALUE;
                // An empty page that explicitly withholds completeness. Without
                // it a later subscription's `complete: true` would AND the
                // object back to reconciling, and this subscription's live
                // entitlements would be deleted.
                yield {
                  object: "agreementEntitlement",
                  records: [],
                  complete: false,
                };
              } else {
                throw error;
              }
            }
          }
        }

        // Spread first, so the synthesized fields win where the names collide.
        const flattened: RawRecord = {
          ...subscription,
          ...flattenChargebeeSubscription(subscription, extraMetadata),
        };

        agreements.push(flattened);
        subscriptions.push(flattened);

        subscriptionItems(subscription).forEach((item, position) => {
          items.push({
            ...item,
            ...flattenChargebeeSubscriptionItem(item, subscriptionId, position),
          });
        });

        // The key-presence gate, not the array length: an absent
        // `subscription_items` would otherwise look exactly like "this
        // subscription has no lines".
        if (!hasSubscriptionItemsKey(subscription)) pageItemsComplete = false;

        if (discountsMapped) {
          if (!hasDiscountsKey(subscription)) pageDiscountsComplete = false;
          for (const discount of subscriptionDiscounts(subscription)) {
            discounts.push(flattenChargebeeDiscount(discount, subscriptionId));
          }
        }
      }

      yield { object: "agreement", records: agreements };
      yield { object: "subscription", records: subscriptions };
      // `complete` is per page and the engine ANDs pages, so a later page that
      // carried the key cannot rescue an earlier one that did not.
      yield { object: "agreementItem", records: items, complete: pageItemsComplete };
      if (discountsMapped) {
        yield {
          object: "agreementDiscount",
          records: discounts,
          complete: pageDiscountsComplete,
        };
      }

      pagesFetched += 1;
      if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

      if (body.nextOffset === undefined || body.nextOffset === offset) break;
      offset = body.nextOffset;
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // A subscription is its own id. A discount carries one too, so it is caught
    // by the same read.
    const id = asString(record["id"]);
    if (id !== undefined) return id;

    // Neither an inline line nor a subscription entitlement has an id of its
    // own, so both are keyed off the subscription they came from. The
    // entitlement gets the feature id from the payload; the line had none to
    // use — `subscription_items` elements carry no id at all — so its position
    // in the list stands in. A reorder therefore churns ids rather than
    // corrupting the list, the same trade Stripe's `position` makes.
    const subscriptionId = asString(record["agreement_id"]);
    if (subscriptionId === undefined) return undefined;

    const featureId = asString(record["feature_id"]);
    if (featureId !== undefined) return `${subscriptionId}:${featureId}`;

    const position = record["position"];
    if (typeof position === "number") return `${subscriptionId}:${position}`;

    return undefined;
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // The customer link is real; the offering link is not, because the list
      // payload does not inline the item price's product. `offeringId` stays
      // null and `externalPriceId` on each line keeps the item price id — the
      // exact state `AgreementItem.priceId`'s comment anticipates.
      case "agreement":
        return { customer: asString(record["customer_id"]) };

      // Same source record, same provider id, its own table.
      case "subscription":
        return { agreement: asString(record["id"]) };

      // The agreement is the injected `agreement_id`, not the item's own
      // (absent) `subscription_id`; the price is the item price this line went
      // for. No offering ref: the product behind the price is not inlined.
      case "agreementItem":
        return {
          agreement: asString(record["agreement_id"]),
          price: asString(record["price_id"]),
        };

      // Both refs come from the payload, but the agreement one is the injected
      // id rather than the payload's own `subscription_id` — see
      // `flattenChargebeeSubscriptionEntitlement`.
      case "agreementEntitlement":
        return {
          agreement: asString(record["agreement_id"]),
          feature: asString(record["feature_id"]),
        };

      // One parent only; a discount has no coupon table to point at.
      case "agreementDiscount":
        return { agreement: asString(record["agreement_id"]) };

      default:
        return {};
    }
  },
};
