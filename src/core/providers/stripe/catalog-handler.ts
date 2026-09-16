/**
 * Stripe catalog sync handler — products, and the prices that sell them.
 *
 * Stripe's two resources map onto ours one for one: a `product` is a Product, a
 * `price` is an Offering. That is a happier fit than the identity side got —
 * there is no synthesis of a record that does not exist, as `synthesizeContact`
 * has to do — but three details still need handling here rather than downstream:
 *
 * 1. **A price usually has no name.** `nickname` is optional and in practice
 *    usually null, while `Offering.name` is required, so an unnamed price would
 *    be rejected on every sync forever. `offeringDisplayName` builds one from
 *    the amount and interval. This is the single most load-bearing line in the
 *    file.
 *
 * 2. **The interval is nested and sometimes absent.** `recurring.interval` is
 *    two levels down and missing entirely for a one-time price, so it is
 *    flattened and defaulted to `one_time` — a value, not a null, because "does
 *    not recur" is a fact and the writer reads null as "not told".
 *
 * 3. **Ordering.** Products are yielded before prices so an offering resolves
 *    its product against the index the product pages build, the same invariant
 *    customers-before-contacts keeps on the identity side.
 *
 * Pagination is Stripe's cursor, with the same three terminating conditions the
 * identity handler documents — `has_more`, an absent cursor, and a cursor that
 * fails to advance — because the cursor is built from ids we read out of the
 * response rather than handed to us.
 *
 * Stripe has no field-selection parameter, so `ctx.requestedSourcePaths` is
 * unused; a mapped field cannot go missing because it was not requested.
 *
 * Docs: https://docs.stripe.com/api/products/list, .../prices/list
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type { HandlerContext, SourcePage, SyncHandler } from "../../types/registry";
import { asString, createProviderSession, type ProviderSession } from "../http";
import {
  epochToIso,
  flattenPrice,
  listUrl,
  parseListPage,
  priceProductId,
  stripePageSize,
  STRIPE_MAX_PAGES,
  type StripeResource,
} from "./api";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

/**
 * Page one Stripe list resource, applying `decorate` to every record.
 *
 * Shared by both objects rather than written twice: the cursor logic is where
 * a pagination bug hides, and the two loops would be identical but for the
 * resource name. The three break conditions are each load-bearing — see the
 * note in `identity-handler.ts`.
 */
async function* pageResource(
  session: ProviderSession,
  resource: StripeResource,
  object: TargetObject,
  decorate: (record: RawRecord) => RawRecord
): AsyncGenerator<SourcePage> {
  const perPage = stripePageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(listUrl(resource, perPage, cursor))
    );

    yield {
      object,
      records: body.records.map((record: RawRecord) => ({
        // Spread first, so ours wins if Stripe ever ships a field of this name.
        ...record,
        ...decorate(record),
      })),
    };

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }
}

export const stripeCatalogHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    // Products first, in full, before any price is yielded. Prices resolve
    // their product through the index the engine builds from these pages, and
    // a price that arrives first is kept but left unlinked until a later run.
    yield* pageResource(session, "products", "product", withCreatedAt);

    yield* pageResource(session, "prices", "offering", flattenPrice);
  },

  externalIdOf(record: RawRecord): string | undefined {
    // Both objects carry Stripe's own `id`, and unlike the identity handler
    // there is no synthesized record to tell apart from a real one — every row
    // here came off the wire.
    return asString(record["id"]);
  },

  externalParentIdOf(
    record: RawRecord,
    object: TargetObject
  ): string | undefined {
    // A product is a root; only an offering hangs off one.
    if (object !== "offering") return undefined;
    return priceProductId(record);
  },
};

/**
 * The `created_at` addition for one product.
 *
 * Same shape and same reason as the identity handler's: epoch seconds do not
 * survive `new Date(string)`, and returning a spreadable object rather than a
 * value keeps an unparseable `created` from writing `created_at: undefined`
 * onto the record, which the mapping editor would then offer as a field that is
 * always blank.
 */
function withCreatedAt(record: RawRecord): RawRecord {
  const createdAt = epochToIso(record["created"]);
  return createdAt === undefined ? {} : { created_at: createdAt };
}
