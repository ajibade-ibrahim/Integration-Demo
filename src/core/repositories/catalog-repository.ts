/**
 * Reads over the catalog the sync engine wrote.
 *
 * Reports the count of *unlinked* offerings alongside the rows, for the same
 * reason `synced-data-repository` reports unlinked contacts: an offering whose
 * product could not be resolved is kept rather than dropped, and that decision
 * is only defensible if the consequence is visible. Otherwise it is silent data
 * loss wearing a different hat — the rows are all there, one column is just
 * permanently empty.
 *
 * Scoped by `userId` through the integration, like every other request-scoped
 * read. The catalog is per-integration data: two connections to two Stripe
 * accounts hold two separate catalogs, and nothing here merges them. There is
 * no catalog equivalent of identity resolution, and inventing one would be a
 * guess — the same product sold through two providers is a claim only a human
 * can make.
 */

import { prisma } from "@/lib/prisma";
import { priceLabel } from "../price-format";
import { readJsonObject } from "./json-column";

export interface OfferingRow {
  id: string;
  externalSourceId: string;
  name: string;
  amountMinor: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount: number | null;
  active: boolean | null;
  productName: string | null;
  /** The provider's own product id, present even when the link is unresolved. */
  externalProductId: string | null;
  featureCount: number;
  customFields: Record<string, string>;
  integrationLabel: string;
}

/**
 * One offering a feature belongs to, as the page renders it in the list.
 */
export interface FeatureOffering {
  /** Resolved internal offering name, or null when the link is unresolved. */
  name: string | null;
  /** The provider's own offering id, present even when the link is unresolved. */
  externalId: string | null;
}

/**
 * One feature, deduplicated across the offerings that include it.
 *
 * The `Feature` table stores one row per *attachment*, so the same feature on
 * three offerings is three rows. The page is written in terms of the feature,
 * not the attachment, so those rows are grouped here — see `featureGroupKey`.
 */
export interface FeatureRow {
  id: string;
  externalSourceId: string;
  name: string;
  lookupKey: string | null;
  featureId: string | null;
  /** Every offering this feature belongs to, deduplicated and name-sorted. */
  offerings: FeatureOffering[];
  customFields: Record<string, string>;
  integrationLabel: string;
}

export interface ProductRow {
  id: string;
  externalSourceId: string;
  name: string;
  description: string | null;
  active: boolean | null;
  customFields: Record<string, string>;
  integrationLabel: string;
  providerName: string;
  offeringCount: number;
}

export interface CatalogPage {
  products: ProductRow[];
  offerings: OfferingRow[];
  features: FeatureRow[];
  totals: {
    products: number;
    offerings: number;
    features: number;
    /** Offerings that named a product we could not resolve. */
    unlinkedOfferings: number;
    /**
     * Features that named an offering we could not resolve.
     */
    unlinkedFeatures: number;
  };
}

export async function loadCatalog(
  userId: string,
  take = 200
): Promise<CatalogPage> {
  const scope = { integration: { userId } };

  const [products, offerings, features, productTotal, offeringTotal, unlinked] =
    await Promise.all([
      prisma.product.findMany({
        where: scope,
        orderBy: { name: "asc" },
        take,
        include: {
          integration: { select: { instanceLabel: true, providerName: true } },
          _count: { select: { offerings: true } },
        },
      }),
      prisma.offering.findMany({
        where: scope,
        // By product, then by name: a catalog reads as a list of things with
        // their tiers underneath.
        orderBy: [{ product: { name: "asc" } }, { name: "asc" }],
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          product: { select: { name: true } },
          prices: true,
          _count: { select: { features: true } },
        },
      }),
      prisma.feature.findMany({
        where: scope,
        orderBy: [{ offering: { name: "asc" } }, { name: "asc" }],
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          offering: { select: { name: true } },
        },
      }),
      prisma.product.count({ where: scope }),
      prisma.offering.count({ where: scope }),
      prisma.offering.count({
        where: { ...scope, productId: null, externalProductId: { not: null } },
      }),
    ]);

  const featureRows = groupFeatures(
    features.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      lookupKey: row.lookupKey,
      featureId: row.externalFeatureId,
      offeringName: row.offering?.name ?? null,
      externalOfferingId: row.externalOfferingId,
      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
      integrationId: row.integrationId,
    }))
  );

  return {
    products: products.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      description: row.description,
      active: row.active,
      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
      providerName: row.integration.providerName,
      offeringCount: row._count.offerings,
    })),
    offerings: offerings.map((row) => {
      const primaryPrice = row.prices[0];
      return {
        id: row.id,
        externalSourceId: row.externalSourceId,
        name: row.name,
        amountMinor: primaryPrice?.amountMinor ?? null,
        currency: primaryPrice?.currency ?? null,
        interval: primaryPrice?.interval ?? null,
        intervalCount: primaryPrice?.intervalCount ?? null,
        active: row.active,
        productName: row.product?.name ?? null,
        externalProductId: row.externalProductId,
        featureCount: row._count.features,
        customFields: readJsonObject(row.customFields),
        integrationLabel: row.integration.instanceLabel,
      };
    }),
    features: featureRows,
    // Feature counts come from the grouped rows rather than `prisma.feature`,
    // which counts attachments. A tab reading "Features (12)" above six rows —
    // the same feature on two offerings is two attachments — would make the
    // grouping look like a bug.
    totals: {
      products: productTotal,
      offerings: offeringTotal,
      features: featureRows.length,
      unlinkedOfferings: unlinked,
      unlinkedFeatures: featureRows.filter((row) =>
        row.offerings.some((offering) => offering.name === null)
      ).length,
    },
  };
}

/** A feature attachment row, before grouping. */
interface FlatFeature {
  id: string;
  externalSourceId: string;
  name: string;
  lookupKey: string | null;
  featureId: string | null;
  offeringName: string | null;
  externalOfferingId: string | null;
  customFields: Record<string, string>;
  integrationLabel: string;
  integrationId: string;
}

/**
 * The identity a feature row is grouped by.
 *
 * `lookupKey` is the stable key an application gates on, so it is the key the
 * page groups by. It can be null — Stripe does not require one — and grouping
 * every null together would merge distinct features into one row, so the
 * provider's own feature id, and finally the attachment id, stand in.
 *
 * The integration id is part of the key, not the display label: two connections
 * to two accounts hold two separate catalogs, and nothing here merges them.
 */
function featureGroupKey(row: FlatFeature): string {
  const identity = row.lookupKey ?? row.featureId ?? row.externalSourceId;
  return `${row.integrationId}\u0000${identity}`;
}

/**
 * Collapse the attachment rows into one row per feature.
 *
 * Resolved offerings sort before unresolved ones, and both sort by name or, for
 * an unresolved one, by the provider's id — so the list a person reads is
 * stable and the "unresolved #off_x" badges land at the end.
 */
function groupFeatures(rows: readonly FlatFeature[]): FeatureRow[] {
  const grouped = new Map<string, FeatureRow>();

  for (const row of rows) {
    const offering: FeatureOffering | null =
      row.offeringName === null && row.externalOfferingId === null
        ? null
        : { name: row.offeringName, externalId: row.externalOfferingId };

    const key = featureGroupKey(row);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        id: row.id,
        externalSourceId: row.externalSourceId,
        name: row.name,
        lookupKey: row.lookupKey,
        featureId: row.featureId,
        offerings: offering === null ? [] : [offering],
        customFields: row.customFields,
        integrationLabel: row.integrationLabel,
      });
      continue;
    }

    const duplicate =
      offering !== null &&
      existing.offerings.some(
        (it) => it.name === offering.name && it.externalId === offering.externalId
      );
    if (offering !== null && !duplicate) {
      existing.offerings.push(offering);
    }
  }

  const result = [...grouped.values()];
  for (const row of result) {
    row.offerings.sort(compareOfferings);
  }
  result.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.lookupKey ?? "").localeCompare(b.lookupKey ?? "")
  );
  return result;
}

function compareOfferings(a: FeatureOffering, b: FeatureOffering): number {
  if (a.name !== null && b.name !== null) return a.name.localeCompare(b.name);
  if (a.name !== null) return -1;
  if (b.name !== null) return 1;
  return (a.externalId ?? "").localeCompare(b.externalId ?? "");
}

/**
 * An offering's price as a person would read it: "$49/month".
 *
 * A thin pass-through to `priceLabel`, which the Stripe handler also uses to
 * synthesize `Offering.name`. Deliberately not a second implementation: this
 * function and that name are two renderings of the same three columns, and a
 * row reading "$49/month" in one place and "$49.00 / month" in the other would
 * look like two different prices.
 *
 * @returns undefined when there is no amount or no currency to interpret it
 *   with. An amount alone is not a price.
 */
export function formatOfferingPrice(row: {
  amountMinor: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount: number | null;
}): string | undefined {
  return priceLabel(row);
}
