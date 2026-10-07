/**
 * Reads over the catalog the sync engine wrote.
 *
 * Reports the count of *unlinked* offerings and entitlements alongside the rows,
 * for the same reason `synced-data-repository` reports unlinked contacts: an
 * offering whose product could not be resolved is kept rather than dropped, and
 * that decision is only defensible if the consequence is visible. Otherwise it
 * is silent data loss wearing a different hat — the rows are all there, one
 * column is just permanently empty.
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
  /** BILLING_MODELS word for the primary price, or null when the provider did not say. */
  billingModel: string | null;
  /** Units per block for a block-priced primary price; Stigg only. */
  blockSize: number | null;
  interval: string | null;
  intervalCount: number | null;
  active: boolean | null;
  productName: string | null;
  /** The provider's own product id, present even when the link is unresolved. */
  externalProductId: string | null;
  /** How many features this offering includes, from its entitlements. */
  entitlementCount: number;
  customFields: Record<string, string>;
  integrationLabel: string;
}

/**
 * One offering a feature belongs to, as the page lists it in the cell.
 */
export interface FeatureOffering {
  /** Resolved internal offering name, or null when the link is unresolved. */
  name: string | null;
  /** The provider's own offering id, present even when the link is unresolved. */
  externalId: string | null;
}

/**
 * One feature, with the offerings that include it.
 *
 * **Unique by lookup key within an integration**, not one row per definition.
 * Two definitions that share a lookup key are the same feature as far as
 * anything reading this page is concerned — that is what a lookup key is *for* —
 * so their offerings are merged into one row. A definition with no lookup key
 * has nothing to merge on and stays its own row, keyed by its provider id.
 *
 * Scoped to one integration on purpose: two connections to two accounts holding
 * a feature that happens to share a key are not the same feature, and merging
 * them would be the false merge the identity layer refuses everywhere else.
 */
export interface FeatureRow {
  id: string;
  externalSourceId: string;
  name: string;
  lookupKey: string | null;
  isMetered: boolean | null;
  unit: string | null;
  /** Every offering that includes this feature, deduplicated and name-sorted. */
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
    /** Features, unique by lookup key within each integration. */
    features: number;
    /** Offerings that named a product we could not resolve. */
    unlinkedOfferings: number;
    /**
     * Entitlements with either half of their two-parent link unresolved.
     */
    unlinkedEntitlements: number;
  };
}

export async function loadCatalog(
  userId: string,
  take = 200
): Promise<CatalogPage> {
  const scope = { integration: { userId } };

  const [
    products,
    offerings,
    features,
    entitlements,
    productTotal,
    offeringTotal,
    unlinked,
    unlinkedEntitlements,
  ] = await Promise.all([
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
        _count: { select: { entitlements: true } },
      },
    }),
    prisma.feature.findMany({
      where: scope,
      orderBy: [{ name: "asc" }, { lookupKey: "asc" }],
      take,
      include: {
        integration: { select: { instanceLabel: true } },
      },
    }),
    prisma.entitlement.findMany({
      where: scope,
      take,
      include: {
        offering: { select: { name: true } },
      },
    }),
    prisma.product.count({ where: scope }),
    prisma.offering.count({ where: scope }),
    prisma.offering.count({
      where: { ...scope, productId: null, externalProductId: { not: null } },
    }),
    prisma.entitlement.count({
      where: { ...scope, OR: [{ offeringId: null }, { featureId: null }] },
    }),
  ]);

  const featureRows = attachOfferings(features, entitlements);

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
        billingModel: primaryPrice?.billingModel ?? null,
        blockSize: primaryPrice?.blockSize ?? null,
        interval: primaryPrice?.interval ?? null,
        intervalCount: primaryPrice?.intervalCount ?? null,
        active: row.active,
        productName: row.product?.name ?? null,
        externalProductId: row.externalProductId,
        entitlementCount: row._count.entitlements,
        customFields: readJsonObject(row.customFields),
        integrationLabel: row.integration.instanceLabel,
      };
    }),
    features: featureRows,
    totals: {
      products: productTotal,
      offerings: offeringTotal,
      features: featureRows.length,
      unlinkedOfferings: unlinked,
      // Counted from the entitlement rows rather than from the grouped
      // offerings: an entitlement whose *feature* did not resolve has no
      // definition to be grouped under, so subtracting linked lists would miss
      // exactly the case this number exists to report.
      unlinkedEntitlements,
    },
  };
}

/** A feature definition row plus the entitlement rows that point at it. */
type FeatureWithIntegration = {
  id: string;
  integrationId: string;
  externalSourceId: string;
  name: string;
  lookupKey: string | null;
  isMetered: boolean | null;
  unit: string | null;
  customFields: string;
  integration: { instanceLabel: string };
};

type EntitlementWithOffering = {
  featureId: string | null;
  externalOfferingId: string | null;
  offering: { name: string } | null;
};

/**
 * Group the definitions by lookup key and collect each group's offerings.
 *
 * Two groupings, in order. First the entitlement rows are bucketed by internal
 * `featureId` — the join the schema actually holds, so no key stand-in is
 * needed. Then the definitions are folded together on
 * `(integrationId, lookupKey ?? externalSourceId)`, which is what "unique by
 * lookup key" means: a shared key brings the two offerings into one row, and a
 * definition with no key falls back to its provider id so it is never merged
 * with an unrelated one.
 *
 * An entitlement whose *feature* half did not resolve has no definition to
 * attach to and is skipped here; it is still counted, by `unlinkedEntitlements`.
 */
function attachOfferings(
  features: readonly FeatureWithIntegration[],
  entitlements: readonly EntitlementWithOffering[]
): FeatureRow[] {
  const offeringsByFeature = new Map<string, FeatureOffering[]>();
  const seenByFeature = new Map<string, Set<string>>();

  for (const row of entitlements) {
    if (row.featureId === null) continue;

    const offering: FeatureOffering = {
      name: row.offering?.name ?? null,
      externalId: row.externalOfferingId,
    };

    const seen = seenByFeature.get(row.featureId) ?? new Set<string>();
    const identity = offeringIdentity(offering);
    if (seen.has(identity)) continue;
    seen.add(identity);
    seenByFeature.set(row.featureId, seen);

    const list = offeringsByFeature.get(row.featureId) ?? [];
    list.push(offering);
    offeringsByFeature.set(row.featureId, list);
  }

  const grouped = new Map<string, FeatureRow>();

  for (const feature of features) {
    const key = `${feature.integrationId}:${feature.lookupKey ?? feature.externalSourceId}`;
    const offerings = offeringsByFeature.get(feature.id) ?? [];

    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        id: feature.id,
        externalSourceId: feature.externalSourceId,
        name: feature.name,
        lookupKey: feature.lookupKey,
        isMetered: feature.isMetered,
        unit: feature.unit,
        // Copied, because the sort below must not reorder the source list out
        // from under a second definition that merges into this row.
        offerings: [...offerings],
        customFields: readJsonObject(feature.customFields),
        integrationLabel: feature.integration.instanceLabel,
      });
      continue;
    }

    for (const offering of offerings) {
      if (!existing.offerings.some((it) => offeringIdentity(it) === offeringIdentity(offering))) {
        existing.offerings.push(offering);
      }
    }

    // A gap in one definition is filled from the other rather than kept. These
    // rows describe the same feature — a shared lookup key is the whole premise
    // of the fold — so a field one of them states and the other leaves unset is
    // a field the group knows. Without this, which definition happened to sort
    // first would decide whether the metered and unit columns were populated,
    // and the two orderings differ only by a null.
    existing.lookupKey ??= feature.lookupKey;
    existing.isMetered ??= feature.isMetered;
    existing.unit ??= feature.unit;
  }

  const rows = [...grouped.values()];
  for (const row of rows) row.offerings.sort(compareOfferings);
  return rows;
}

/**
 * What makes two offerings in a cell "the same entry". The provider id alone is
 * not enough when the link is unresolved — two unresolved links both carry a
 * null name but different ids — and the name alone is not enough when one
 * offering is refused and another resolves to the same one.
 */
function offeringIdentity(offering: FeatureOffering): string {
  return `${offering.name ?? ""}#${offering.externalId ?? ""}`;
}

/**
 * Resolved offerings sort before unresolved ones, and both sort by name or, for
 * an unresolved one, by the provider's id — so the list a person reads is
 * stable and the "unresolved #off_x" badges land at the end.
 */
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
