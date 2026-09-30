/**
 * Stripe catalog sync handler — products, the prices that sell them, and the
 * feature definitions and entitlements that tie them together.
 *
 * Stripe's resources map onto ours: a `product` is a Product *and* the source
 * of the Offering synthesised from it, a `price` is a Price sold under that
 * offering, an `EntitlementFeature` (`feat_…`) nested on a `ProductFeature`
 * attachment is a Feature definition, and the attachment itself is the
 * Entitlement linking it to an offering. Four details still need handling here:
 *
 * 1. **A price usually has no name.** `nickname` is optional and in practice
 *    usually null, while `Price.name` is required, so an unnamed price would be
 *    rejected on every sync forever. `offeringDisplayName` builds one from the
 *    amount and interval. This is the single most load-bearing line in the
 *    file.
 *
 * 2. **The interval is nested and sometimes absent.** `recurring.interval` is
 *    two levels down and missing entirely for a one-time price, so it is
 *    flattened and defaulted to `one_time` — a value, not a null, because "does
 *    not recur" is a fact and the writer reads null as "not told".
 *
 * 3. **Ordering.** Each product page is followed by the offering page built
 *    from it, and those come before any price page, which in turn comes before
 *    any feature or entitlement page. That is what lets a price and an
 *    entitlement resolve their offering against the index those pages build —
 *    the same invariant customers-before-contacts keeps on the identity side.
 *
 *    The synthesised offering is why this file writes the same row twice.
 *    Stripe has no separate item object: a product *is* what gets sold, so it is
 *    written once as a Product and once as the Offering its prices, features and
 *    entitlements attach to, under two ids that are equal by construction.
 *
 * 4. **An attachment's payload does not name its offering.** Features are read
 *    from `/v1/products/{id}/features`, a per-product sub-resource, and the
 *    response carries no offering field at all. The offering id (which equals
 *    the product id — each product has one synthesised offering with the same
 *    id) comes from the URL, so this handler retains the product ids it listed
 *    and hands each one to `flattenFeatureEntitlement`. Lose track and every
 *    row is linked to the wrong offering with no error and no null to notice.
 *
 *    That pass is also the only one that is conditional, on two counts: most
 *    accounts define no entitlement features, and an integration may map
 *    neither `feature` nor `entitlement`. Either way the fan-out is pure cost,
 *    so both are checked before a single per-product request is made.
 *
 * Pagination is Stripe's cursor, with the same three terminating conditions the
 * identity handler documents — `has_more`, an absent cursor, and a cursor that
 * fails to advance — because the cursor is built from ids we read out of the
 * response rather than handed to us.
 *
 * Stripe has no field-selection parameter, so `ctx.requestedSourcePaths` is
 * not used to *narrow* a request — a mapped field cannot go missing because it
 * was not requested. It is read for one other thing: whether the features and
 * entitlements pass is worth running at all. See `fetchPages`.
 *
 * Docs: https://docs.stripe.com/api/products/list, .../prices/list,
 * .../product-feature/list
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
  entitlementFeaturesUrl,
  epochToIso,
  flattenFeatureDefinition,
  flattenFeatureEntitlement,
  flattenPrice,
  listUrl,
  parseListPage,
  priceProductId,
  productFeaturesUrl,
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

/**
 * Page the features attached to one product, as two streams of records.
 *
 * Each attachment is both a *definition* (the nested `feat_…`) and a *link*
 * (this product includes that feature). Both are yielded, and each may be
 * suppressed by the caller when nothing is mapped to its object — a page for an
 * unmapped object is a page whose every record is rejected for a missing name,
 * which turns a clean run into a `partial` one.
 *
 * A definition is yielded **at most once per `feat_…` across the whole run**,
 * which is what `seenFeatureIds` is for. The same feature attached to two
 * products arrives twice, and the `Feature` table must hold it once; without
 * the set, `feature` counts would report attachments and the run report would
 * overstate what was written. The link is yielded every time, because two
 * attachments really are two entitlements.
 *
 * Uses the product id as both the URL segment and the offering id — each Stripe
 * product has a synthesised offering with the same id, so the two are
 * interchangeable here.
 */
async function* pageProductFeatures(
  session: ProviderSession,
  productId: string,
  seenFeatureIds: Set<string>,
  emitDefinitions: boolean,
  emitLinks: boolean
): AsyncGenerator<SourcePage> {
  const perPage = stripePageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseListPage(
      await session.getJson(productFeaturesUrl(productId, perPage, cursor))
    );

    const definitions: RawRecord[] = [];
    const links: RawRecord[] = [];

    for (const record of body.records) {
      const definition = flattenFeatureDefinition(record);
      if (definition !== undefined) {
        const id = asString(definition["id"]);
        if (id !== undefined && !seenFeatureIds.has(id)) {
          seenFeatureIds.add(id);
          definitions.push(definition);
        }
      }
      links.push(flattenFeatureEntitlement(record, productId));
    }

    if (emitDefinitions && definitions.length > 0) {
      yield { object: "feature", records: definitions };
    }
    if (emitLinks && links.length > 0) {
      yield { object: "entitlement", records: links };
    }

    pagesFetched += 1;
    if (pagesFetched >= STRIPE_MAX_PAGES) break;

    if (!body.hasMore) break;
    if (body.lastId === undefined || body.lastId === cursor) break;
    cursor = body.lastId;
  }
}

/**
 * Whether this account defines any entitlement features at all.
 *
 * One request that decides whether the next N are worth making. Most Stripe
 * accounts do not use Entitlements, and for those the per-product fan-out is
 * pure cost: one request per product, every sync, to discover nothing. The
 * feature *definitions* endpoint is flat and listable, so `limit=1` answers it.
 *
 * This is a behavioural contract rather than an optimization, which is why
 * `tests/integration/stripe-catalog.test.ts` asserts the request *count* and not
 * just the output: a refactor that made the probe always return true would pass
 * every output assertion while quietly restoring the cost it exists to remove.
 *
 * A failure here is not swallowed. If the probe cannot be read the run should
 * fail loudly through the session's normal policy rather than silently deciding
 * the account has no features — "we could not ask" and "the answer is no" must
 * not produce the same sync.
 */
async function accountUsesEntitlements(
  session: ProviderSession
): Promise<boolean> {
  const body = parseListPage(await session.getJson(entitlementFeaturesUrl(1)));
  return body.records.length > 0;
}

export const stripeCatalogHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    const productIds: string[] = [];
    for await (const page of pageResource(
      session,
      "products",
      "product",
      withCreatedAt
    )) {
      const offerings: RawRecord[] = [];
      for (const record of page.records) {
        const id = asString(record["id"]);
        if (id !== undefined) {
          productIds.push(id);
          offerings.push({
            id,
            name: asString(record["name"]) ?? id,
            description: asString(record["description"]),
            active: record["active"] === true,
            product_id: id,
          });
        }
      }
      yield page;
      if (offerings.length > 0) {
        yield { object: "offering", records: offerings };
      }
    }

    yield* pageResource(session, "prices", "price", flattenPrice);

    // Either object turns the fan-out on. They come off one request, so a rule
    // set that maps only `entitlement` still needs the per-product call — and
    // an integration that maps neither must make none at all, probe included.
    const definitionsAreMapped =
      (ctx.requestedSourcePaths.get("feature") ?? []).length > 0;
    const linksAreMapped =
      (ctx.requestedSourcePaths.get("entitlement") ?? []).length > 0;

    if (
      (definitionsAreMapped || linksAreMapped) &&
      (await accountUsesEntitlements(session))
    ) {
      // Shared across every product, so a feature attached to several products
      // is emitted once.
      const seenFeatureIds = new Set<string>();
      for (const productId of productIds) {
        yield* pageProductFeatures(
          session,
          productId,
          seenFeatureIds,
          definitionsAreMapped,
          linksAreMapped
        );
      }
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      case "offering":
        return { product: asString(record["product_id"]) ?? asString(record["id"]) };
      case "price":
        return { offering: priceProductId(record) };
      // A definition is a root record: it hangs off nothing.
      case "feature":
        return {};
      // The link names both of its parents, and neither is primary.
      case "entitlement":
        return {
          offering: asString(record["offering_id"]),
          feature: asString(record["feature_id"]),
        };
      default:
        return {};
    }
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
