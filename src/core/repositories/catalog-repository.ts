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
import { ownedScope, pageWindow, type DataPageQuery } from "./data-page";
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
  query: DataPageQuery = {}
): Promise<CatalogPage> {
  const scope = ownedScope(userId, query.integrationId);
  const window = pageWindow(query.page, query.pageSize);

  const [
    products,
    offerings,
    featureDefinitions,
    productTotal,
    offeringTotal,
    unlinked,
    unlinkedEntitlements,
  ] = await Promise.all([
    prisma.product.findMany({
      where: scope,
      // The id tiebreak keeps page boundaries stable when two products share a
      // name; without it the same row can appear on two pages.
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...window,
      include: {
        integration: { select: { instanceLabel: true, providerName: true } },
        _count: { select: { offerings: true } },
      },
    }),
    prisma.offering.findMany({
      where: scope,
      // By product, then by name: a catalog reads as a list of things with
      // their tiers underneath.
      orderBy: [{ product: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
      ...window,
      include: {
        integration: { select: { instanceLabel: true } },
        product: { select: { name: true } },
        prices: true,
        _count: { select: { entitlements: true } },
      },
    }),
    // Every definition in scope, with no `take`. Features are grouped by lookup
    // key *before* pagination, so slicing here would split a merged group
    // across two pages and make the total disagree with the tab count.
    prisma.feature.findMany({
      where: scope,
      orderBy: [{ name: "asc" }, { lookupKey: "asc" }, { id: "asc" }],
      include: {
        integration: { select: { instanceLabel: true } },
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

  // The grouping is the paginated unit, so it happens over the whole scope.
  // Only the visible groups then cost an entitlement read.
  const groups = groupFeatures(featureDefinitions);
  const visibleGroups = groups.slice(window.skip, window.skip + window.take);
  const visibleFeatureIds = visibleGroups.flatMap((group) => group.featureIds);

  const entitlements =
    visibleFeatureIds.length === 0
      ? []
      : await prisma.entitlement.findMany({
          where: { ...scope, featureId: { in: visibleFeatureIds } },
          include: {
            offering: { select: { name: true } },
          },
        });

  attachOfferings(visibleGroups, entitlements);

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
    features: visibleGroups.map((group) => group.row),
    totals: {
      products: productTotal,
      offerings: offeringTotal,
      // The merged-group count, not the number of definitions on this page:
      // two definitions sharing a lookup key are one row here, which is what
      // the tab claims to show.
      features: groups.length,
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
 * A merged feature row, plus every definition that was folded into it.
 *
 * The ids are kept because an entitlement points at a *definition*, and the
 * definitions sharing a lookup key are otherwise indistinguishable from the
 * row. Without them, a page containing the group would fetch the offerings for
 * whichever definition happened to be first and silently drop the rest.
 */
interface FeatureGroup {
  row: FeatureRow;
  featureIds: string[];
}

/**
 * Fold definitions together on `(integrationId, lookupKey ?? externalSourceId)`.
 *
 * That is what "unique by lookup key" means: a shared key brings two
 * definitions into one row, and a definition with no key falls back to its
 * provider id so it is never merged with an unrelated one. Insertion order is
 * the order the definitions arrived in, and it is preserved because it is the
 * page's stable sort — the id tiebreak in the query makes that order total.
 *
 * Offerings are attached in a later pass — see {@link attachOfferings} — so the
 * grouped rows can be paginated first. Slicing definitions before this fold
 * would split a group across two pages.
 */
function groupFeatures(
  features: readonly FeatureWithIntegration[]
): FeatureGroup[] {
  const grouped = new Map<string, FeatureGroup>();

  for (const feature of features) {
    const key = `${feature.integrationId}:${feature.lookupKey ?? feature.externalSourceId}`;

    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        featureIds: [feature.id],
        row: {
          id: feature.id,
          externalSourceId: feature.externalSourceId,
          name: feature.name,
          lookupKey: feature.lookupKey,
          isMetered: feature.isMetered,
          unit: feature.unit,
          offerings: [],
          customFields: readJsonObject(feature.customFields),
          integrationLabel: feature.integration.instanceLabel,
        },
      });
      continue;
    }

    existing.featureIds.push(feature.id);

    // A gap in one definition is filled from the other rather than kept. These
    // rows describe the same feature — a shared lookup key is the whole premise
    // of the fold — so a field one of them states and the other leaves unset is
    // a field the group knows. Without this, which definition happened to sort
    // first would decide whether the metered and unit columns were populated,
    // and the two orderings differ only by a null.
    existing.row.lookupKey ??= feature.lookupKey;
    existing.row.isMetered ??= feature.isMetered;
    existing.row.unit ??= feature.unit;
  }

  return [...grouped.values()];
}

/**
 * Attach each visible group's offering list.
 *
 * The entitlement rows are bucketed by internal `featureId` — the join the
 * schema actually holds, so no key stand-in is needed — then each group merges
 * the buckets of all its definitions and dedupes by offering identity. An
 * entitlement whose *feature* half did not resolve has no definition to attach
 * to and is skipped here; it is still counted, by `unlinkedEntitlements`.
 */
function attachOfferings(
  groups: readonly FeatureGroup[],
  entitlements: readonly EntitlementWithOffering[]
): void {
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

  for (const group of groups) {
    const merged: FeatureOffering[] = [];
    const seen = new Set<string>();

    for (const featureId of group.featureIds) {
      for (const offering of offeringsByFeature.get(featureId) ?? []) {
        const identity = offeringIdentity(offering);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(offering);
      }
    }

    merged.sort(compareOfferings);
    group.row.offerings = merged;
  }
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
