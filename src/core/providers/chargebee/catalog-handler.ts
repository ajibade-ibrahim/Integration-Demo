/**
 * Chargebee catalog sync handler — Item Families (Products), Items (Offerings),
 * Item Prices (Prices), and Item Entitlements (Features).
 *
 * Features come from Chargebee's Entitlements API, which is separate from the
 * item catalog: `/features` lists the definitions, and each definition's
 * `/item_entitlements` lists the items that include it. An item entitlement is
 * the attachment of one feature to one item, which is exactly what a `Feature`
 * row is — so each one becomes a row, linked to the offering its `item_id`
 * names.
 *
 * That pass is conditional, as Stripe's is: it runs only when a mapping rule
 * targets `feature`, and a site with no feature definitions costs the one list
 * request that says so.
 *
 * The definitions are read for more than their ids: `metered` is a property of
 * the definition, so the handler carries it onto each of that definition's
 * entitlement rows as the synthesized `feature_metered` the mapping layer
 * targets.
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
  chargebeeAuthHeaders,
  chargebeePageSize,
  CHARGEBEE_MAX_PAGES,
  epochToIso,
  featureItemEntitlementsUrl,
  featuresUrl,
  flattenItemPrice,
  itemFamiliesUrl,
  itemPricesUrl,
  itemsUrl,
  parseChargebeeCredential,
  parseFeaturesPage,
  parseItemEntitlementsPage,
  parseItemFamiliesPage,
  parseItemPricesPage,
  parseItemsPage,
  type ChargebeeListPage,
} from "./api";

export const CHARGEBEE_SESSION_OPTIONS = {
  authHeaders: chargebeeAuthHeaders,
  credentialNoun: "API key",
} as const;

export const chargebeeCatalogHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Chargebee",
      CHARGEBEE_SESSION_OPTIONS
    );

    const site =
      ctx.metadata["site"] ??
      parseChargebeeCredential(ctx.accessToken).site;

    if (site === undefined || site === "") {
      throw new Error(
        "Chargebee catalog sync failed: missing site in integration metadata"
      );
    }

    const perPage = chargebeePageSize();

    // 1. Fetch Item Families -> Products
    let offset: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseItemFamiliesPage(
        await session.getJson(itemFamiliesUrl(site, perPage, offset))
      );

      const products = body.records.map((family: RawRecord) => ({
        ...family,
        ...withCreatedAt(family),
      }));

      yield { object: "product", records: products };

      pagesFetched += 1;
      if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

      if (body.nextOffset === undefined || body.nextOffset === offset) break;
      offset = body.nextOffset;
    }

    // 2. Fetch Items -> Offerings
    offset = undefined;
    pagesFetched = 0;

    for (;;) {
      const body = parseItemsPage(
        await session.getJson(itemsUrl(site, perPage, offset))
      );

      // Chargebee item types are "plan", "addon", and "charge" — all map to
      // offerings. Features are not items; they come from the Entitlements API
      // in step 4.
      const offerings: RawRecord[] = [];

      for (const item of body.records) {
        const familyId = asString(item["item_family_id"]);
        offerings.push({
          ...item,
          product_id: familyId,
          ...withCreatedAt(item),
        });
      }

      if (offerings.length > 0) {
        yield { object: "offering", records: offerings };
      }

      pagesFetched += 1;
      if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

      if (body.nextOffset === undefined || body.nextOffset === offset) break;
      offset = body.nextOffset;
    }

    // 3. Fetch Item Prices -> Prices
    offset = undefined;
    pagesFetched = 0;

    for (;;) {
      const body = parseItemPricesPage(
        await session.getJson(itemPricesUrl(site, perPage, offset))
      );

      const prices = body.records.map((price: RawRecord) => ({
        ...price,
        ...flattenItemPrice(price),
      }));

      yield { object: "price", records: prices };

      pagesFetched += 1;
      if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

      if (body.nextOffset === undefined || body.nextOffset === offset) break;
      offset = body.nextOffset;
    }

    // 4. Fetch Item Entitlements -> Features
    //
    // Last, so every offering a feature names was written before it. Skipped
    // entirely when nothing is mapped to `feature`: the pass is one request per
    // feature definition, and without a rule there is nowhere to put the rows.
    const featuresAreMapped =
      (ctx.requestedSourcePaths.get("feature") ?? []).length > 0;
    if (!featuresAreMapped) return;

    // Collected before the fan-out rather than interleaved with it, so a
    // feature page and an entitlement page never share an offset variable.
    //
    // `metered` is captured here and not at the entitlement, because it lives
    // on the feature *definition*: the item entitlement that attaches the
    // feature to an item never carries it. Capturing it now avoids a second
    // read of the definition per entitlement.
    const featureIds: string[] = [];
    const meteredByFeatureId = new Map<string, boolean>();
    for await (const records of pageList((next) =>
      session
        .getJson(featuresUrl(site, perPage, next))
        .then(parseFeaturesPage)
    )) {
      for (const feature of records) {
        const id = asString(feature["id"]);
        if (id === undefined || id === "") continue;
        featureIds.push(id);
        const metered = feature["metered"];
        if (typeof metered === "boolean") meteredByFeatureId.set(id, metered);
      }
    }

    for (const featureId of featureIds) {
      // Chargebee documents `metered` as required, but an absent one is left
      // absent rather than written as `false`: only a real boolean is a claim
      // the provider made, and the column is nullable precisely to hold the
      // difference.
      const metered = meteredByFeatureId.get(featureId);
      for await (const records of pageList((next) =>
        session
          .getJson(featureItemEntitlementsUrl(site, featureId, perPage, next))
          .then(parseItemEntitlementsPage)
      )) {
        if (records.length > 0) {
          yield {
            object: "feature",
            records:
              metered === undefined
                ? records
                : records.map((record) => ({
                    ...record,
                    feature_metered: metered,
                  })),
          };
        }
      }
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      case "offering":
        return {
          product:
            asString(record["item_family_id"]) ?? asString(record["product_id"]),
        };
      case "price":
        return {
          offering:
            asString(record["item_id"]) ?? asString(record["offering_id"]),
        };
      // Read from the payload: every item entitlement names its own item.
      case "feature":
        return { offering: asString(record["item_id"]) };
      default:
        return {};
    }
  },
};

/**
 * Page one Chargebee list endpoint to the end, yielding each page's records.
 *
 * The same three stopping conditions as the inline loops above: no
 * `next_offset`, an offset that fails to advance, and the page cap.
 */
async function* pageList(
  fetchPage: (offset: string | undefined) => Promise<ChargebeeListPage>
): AsyncGenerator<readonly RawRecord[]> {
  let offset: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = await fetchPage(offset);
    yield body.records;

    pagesFetched += 1;
    if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

    if (body.nextOffset === undefined || body.nextOffset === offset) break;
    offset = body.nextOffset;
  }
}

function withCreatedAt(record: RawRecord): RawRecord {
  const createdAt = epochToIso(record["created_at"]);
  return createdAt === undefined ? {} : { created_at: createdAt };
}
