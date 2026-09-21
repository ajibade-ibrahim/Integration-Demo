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
 *   3. **One source record, two objects.** Each subscription is yielded twice —
 *      as `agreement`, then as `subscription` — because the mapping layer
 *      resolves one table per target object and the type-specific detail lives
 *      in its own table. The identity handler does the same thing when it
 *      derives a contact from a customer.
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
  flattenSubscription,
  listUrl,
  parseListPage,
  stripePageSize,
  subscriptionCustomerId,
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
    for (const object of objects) {
      yield { object, records };
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
    yield* pageSubscriptions(session, ["agreement", "subscription"]);
  },

  externalIdOf(record: RawRecord): string | undefined {
    // Both objects carry the same Stripe subscription id, and that is
    // deliberate: they are two halves of one thing, keyed alike in their own
    // tables. Nothing has to tell them apart, because nothing ever sees them
    // in the same table.
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

      default:
        return {};
    }
  },
};
