/**
 * Chargebee catalog sync handler — Item Families (Products), Items (Offerings / Features),
 * and Item Prices (Prices).
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
  flattenItemPrice,
  itemFamiliesUrl,
  itemPricesUrl,
  itemsUrl,
  parseChargebeeCredential,
  parseItemFamiliesPage,
  parseItemPricesPage,
  parseItemsPage,
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

    // 2. Fetch Items -> Offerings or ProductFeatures
    offset = undefined;
    pagesFetched = 0;

    for (;;) {
      const body = parseItemsPage(
        await session.getJson(itemsUrl(site, perPage, offset))
      );

      const offerings: RawRecord[] = [];
      const features: RawRecord[] = [];

      for (const item of body.records) {
        const itemType = asString(item["type"]);
        const familyId = asString(item["item_family_id"]);

        if (itemType === "feature") {
          features.push({
            ...item,
            feature_name: asString(item["name"]),
            lookup_key: asString(item["id"]),
            product_id: familyId,
            ...withCreatedAt(item),
          });
        } else {
          offerings.push({
            ...item,
            product_id: familyId,
            ...withCreatedAt(item),
          });
        }
      }

      if (offerings.length > 0) {
        yield { object: "offering", records: offerings };
      }
      if (features.length > 0) {
        yield { object: "productFeature", records: features };
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
      case "productFeature":
        return {
          product:
            asString(record["item_family_id"]) ?? asString(record["product_id"]),
        };
      default:
        return {};
    }
  },
};

function withCreatedAt(record: RawRecord): RawRecord {
  const createdAt = epochToIso(record["created_at"]);
  return createdAt === undefined ? {} : { created_at: createdAt };
}
