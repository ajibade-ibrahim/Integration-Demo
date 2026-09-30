/**
 * Stripe's `agreement` function: subscriptions, as agreements plus their
 * recurring detail.
 *
 * Three things here carry the risk, and all three are Stripe-shaped rather than
 * ours:
 *
 *   1. **Canceled subscriptions are not returned by default.** `/v1/subscriptions`
 *      lists live ones only, so without `status=all` a subscription canceled at
 *      Stripe would stay `active` in our database permanently — and this system
 *      has no absence detection to catch it. Churn is the main thing a
 *      subscription sync is for, so the filter is not optional.
 *   2. **A subscription has no name.** `Agreement.name` is required, so
 *      `agreementDisplayName` synthesizes one. Skip it and every subscription
 *      in the account is rejected on every sync.
 *   3. **One source record, more than one object.** Each subscription is
 *      yielded twice — as `agreement`, then as `subscription` — and again once
 *      per line as an `agreementItem`, because the mapping layer resolves one
 *      table per target object and the type-specific detail lives in its own
 *      table. The identity handler does the same thing when it derives a
 *      contact from a customer.
 *
 * Docs: https://docs.stripe.com/api/subscriptions/list
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
  flattenAgreementItem,
  flattenSubscription,
  listUrl,
  parseListPage,
  stripePageSize,
  subscriptionCustomerId,
  subscriptionItems,
  subscriptionItemsComplete,
  subscriptionItemsUrl,
  subscriptionOfferingId,
  STRIPE_MAX_PAGES,
} from "./api";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

/**
 * `status=all` — include canceled, incomplete and paused subscriptions.
 *
 * Stripe's default is to return only subscriptions it considers current, which
 * silently makes cancellation invisible: the row stops arriving, nothing marks
 * it stale, and it reads as active forever. Asking for everything turns
 * cancellation into a status change, which upsert handles correctly.
 */
const SUBSCRIPTION_FILTER = { status: "all" } as const;

/**
 * Every item on one subscription, completed if Stripe truncated the list.
 *
 * Stripe inlines the first ten subscription items and sets `items.has_more`
 * beyond that. The common case therefore costs nothing; a subscription with
 * eleven or more lines costs one request per extra page, and this function
 * exists solely so that cost is paid rather than the list silently truncated.
 *
 * That is not an optimization detail, it is the precondition for
 * `writeAgreementItems` deleting anything. The writer reconciles an
 * agreement's stored lines against what arrives here, so a truncated list
 * would delete every line past the tenth on every sync — a data loss with no
 * error and no null to notice, which is precisely the failure mode
 * `SyncHandler`'s completeness obligation is written down to prevent.
 *
 * The starting cursor is the last *inlined* item rather than nothing, because
 * the endpoint returns the same list from the top and re-fetching the first
 * page would duplicate ten rows into the result.
 */
async function completeItems(
  session: ProviderSession,
  subscription: RawRecord
): Promise<readonly RawRecord[]> {
  const inlined = subscriptionItems(subscription);
  if (subscriptionItemsComplete(subscription)) return inlined;

  const subscriptionId = asString(subscription["id"]);
  // Without an id there is nothing to page against. Returning the inlined
  // partial list would be the truncation this function exists to avoid, so
  // this fails the run instead.
  if (subscriptionId === undefined) {
    throw new Error(
      "Subscription has more items than Stripe inlined but carries no id; cannot complete its item list"
    );
  }

  const perPage = stripePageSize();
  const items = [...inlined];
  let cursor = asString(items[items.length - 1]?.["id"]);
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(
        subscriptionItemsUrl(subscriptionId, perPage, cursor)
      )
    );
    items.push(...body.records);

    pagesFetched += 1;
    // The same bound every other loop here uses — but hitting it means the
    // list is still incomplete, and a silently short list is what licenses a
    // wrongful delete. Loud, rather than returning what we have.
    if (pagesFetched >= STRIPE_MAX_PAGES) {
      throw new Error(
        `Subscription '${subscriptionId}' has more item pages than ${STRIPE_MAX_PAGES} allows; refusing to sync a partial item list`
      );
    }

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }

  return items;
}

/**
 * One page of subscriptions, flat-mapped to the item records they carry.
 *
 * The one place in this system where a page of N source records becomes a page
 * of M > N target records. Every other object is one row per record, which is
 * why `externalIdOf` can be a single function for the whole handler: an item's
 * own `si_…` sits at `id` exactly as a subscription's `sub_…` does.
 */
async function itemRecords(
  session: ProviderSession,
  subscriptions: readonly RawRecord[]
): Promise<RawRecord[]> {
  const records: RawRecord[] = [];

  for (const subscription of subscriptions) {
    const subscriptionId = asString(subscription["id"]);
    if (subscriptionId === undefined) continue;

    const items = await completeItems(session, subscription);
    items.forEach((item, position) => {
      records.push({
        // Spread first, so ours wins. The item's own `subscription` field
        // survives underneath and is offered as a raw source path, but it is
        // not what the association reads — `flattenAgreementItem` writes
        // `agreement_id` from the id we actually fetched from, on purpose.
        ...item,
        ...flattenAgreementItem(item, subscriptionId, position),
      });
    });
  }

  return records;
}

/**
 * Page `/v1/subscriptions` once, yielding each record under every object it
 * feeds.
 *
 * One request per page, two pages out. Fetching twice would double the API cost
 * to get identical bytes, and — worse — could observe a subscription changing
 * between the two passes, producing an agreement and a detail row that disagree
 * about the same subscription.
 *
 * The three break conditions are each load-bearing; see the note in
 * `identity-handler.ts`.
 */
async function* pageSubscriptions(
  session: ProviderSession,
  objects: readonly TargetObject[]
): AsyncGenerator<SourcePage> {
  const perPage = stripePageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(
        listUrl("subscriptions", perPage, cursor, SUBSCRIPTION_FILTER)
      )
    );

    const records = body.records.map((record: RawRecord) => ({
      // Spread first, so ours wins if Stripe ever ships a field of this name.
      ...record,
      ...flattenSubscription(record),
    }));

    // Parent object first. The writer needs the agreement row to exist before
    // the subscription row can name it, and the engine preserves page order.
    //
    // `agreementItem` is the one object whose page is not this page: a
    // subscription yields one agreement, one subscription and as many items as
    // it has lines, so its records are flat-mapped out of the same fetch
    // rather than being the same array under a third name.
    //
    // Its page alone declares `complete: true`, and it may because
    // `itemRecords` pages `/v1/subscription_items` to exhaustion first. Stripe
    // always sends an `items` block on a subscription, so there is no
    // key-presence question here — unlike Chargebee, whose list payload can
    // omit `subscription_items` and must withhold the flag when it does.
    for (const object of objects) {
      yield object === "agreementItem"
        ? { object, records: await itemRecords(session, records), complete: true }
        : { object, records };
    }

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }
}

export const stripeAgreementHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    // Interleaved per page rather than all agreements then all subscriptions.
    // Either order writes parents before children, because the writer buckets
    // by object before writing any of them — but interleaving means one pass
    // over the account instead of two.
    yield* pageSubscriptions(session, [
      "agreement",
      "subscription",
      "agreementItem",
    ]);
  },

  externalIdOf(record: RawRecord): string | undefined {
    // Agreement and subscription carry the same Stripe subscription id, and
    // that is deliberate: they are two halves of one thing, keyed alike in
    // their own tables. Nothing has to tell them apart, because nothing ever
    // sees them in the same table.
    //
    // An item is a different record entirely and carries its own `si_…` at
    // the same key, so it needs no branch here — which is the payoff for
    // flat-mapping items into real records rather than smuggling them through
    // as a field on the subscription.
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // The only record in the system with two parents, and neither is
      // primary: an agreement is an arrangement between a customer and
      // something sold.
      case "agreement":
        return {
          customer: subscriptionCustomerId(record),
          offering: subscriptionOfferingId(record),
        };

      // Its own agreement, which carries the same provider id.
      case "subscription":
        return { agreement: asString(record["id"]) };

      // Two parents again, and the same pair as the agreement above — an item
      // is the agreement's link to the thing sold, one line at a time. The
      // agreement id is read from `agreement_id`, which `flattenAgreementItem`
      // injected from the subscription this item was fetched from, *not* from
      // the item's own `subscription` field.
      //
      // A third ref rides along, and it is not a duplicate of the offering: the
      // offering is *what* was sold, the price is *which of its prices* it went
      // for. Both come off the same nested price object — see
      // `flattenAgreementItem`.
      case "agreementItem":
        return {
          agreement: asString(record["agreement_id"]),
          offering: asString(record["offering_id"]),
          price: asString(record["price_id"]),
        };

      default:
        return {};
    }
  },
};
