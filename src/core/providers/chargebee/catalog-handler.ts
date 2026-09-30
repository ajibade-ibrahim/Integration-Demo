/**
 * Chargebee catalog sync handler — Item Families (Products), Items (Offerings),
 * Item Prices (Prices), Features (Feature definitions), and Item Entitlements
 * (Entitlements).
 *
 * Features come from Chargebee's Entitlements API, which is separate from the
 * item catalog: `/features` lists the definitions, and each definition's
 * `/item_entitlements` lists the items that include it. The definition becomes a
 * `Feature` row and the item entitlement becomes an `Entitlement` linking it to
 * an offering — which is exactly the definition/link split the two tables
 * express. `metered` is a property of the definition and now stays there, rather
 * than being carried onto every attachment.
 *
 * That pass is conditional, as Stripe's is: it runs only when a mapping rule
 * targets `feature` or `entitlement`, and a site with no feature definitions
 * costs the one list request that says so.
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

    // 4. Fetch Feature definitions -> Features, then Item Entitlements -> Entitlements
    //
    // Last, so every offering an entitlement names was written before it. The
    // pass runs when either object is mapped: the definitions come off
    // `/features` and the links off each definition's `/item_entitlements`, so a
    // rule set mapping only `entitlement` still pays the first request, and one
    // mapping neither makes no request at all.
    const definitionsAreMapped =
      (ctx.requestedSourcePaths.get("feature") ?? []).length > 0;
    const linksAreMapped =
      (ctx.requestedSourcePaths.get("entitlement") ?? []).length > 0;
    if (!definitionsAreMapped && !linksAreMapped) return;

    const featureIds: string[] = [];
    for await (const records of pageList((next) =>
      session
        .getJson(featuresUrl(site, perPage, next))
        .then(parseFeaturesPage)
    )) {
      if (definitionsAreMapped && records.length > 0) {
        yield { object: "feature", records };
      }
      // Collected regardless of whether the definition itself is mapped: the
      // entitlement fan-out below still needs their ids.
      for (const feature of records) {
        const id = asString(feature["id"]);
        if (id === undefined || id === "") continue;
        featureIds.push(id);
      }
    }

    if (!linksAreMapped) return;

    for (const featureId of featureIds) {
      for await (const records of pageList((next) =>
        session
          .getJson(featureItemEntitlementsUrl(site, featureId, perPage, next))
          .then(parseItemEntitlementsPage)
      )) {
        if (records.length > 0) {
          yield { object: "entitlement", records };
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
      // A definition is a root record: it hangs off nothing.
      case "feature":
        return {};
      // Read from the payload: every item entitlement names both its item and
      // the feature definition it attaches.
      case "entitlement":
        return {
          offering: asString(record["item_id"]),
          feature: asString(record["feature_id"]),
        };
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
