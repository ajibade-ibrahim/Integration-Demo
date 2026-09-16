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
  totals: {
    products: number;
    offerings: number;
    /** Offerings that named a product we could not resolve. */
    unlinkedOfferings: number;
  };
}

export async function loadCatalog(
  userId: string,
  take = 200
): Promise<CatalogPage> {
  const scope = { integration: { userId } };

  const [products, offerings, productTotal, offeringTotal, unlinked] =
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
        // By product, then by price: a catalog reads as a list of things with
        // their tiers underneath, not as an alphabetical jumble of prices.
        orderBy: [{ product: { name: "asc" } }, { amountMinor: "asc" }],
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          product: { select: { name: true } },
        },
      }),
      prisma.product.count({ where: scope }),
      prisma.offering.count({ where: scope }),
      prisma.offering.count({
        where: { ...scope, productId: null, externalProductId: { not: null } },
      }),
    ]);

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
    offerings: offerings.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      amountMinor: row.amountMinor,
      currency: row.currency,
      interval: row.interval,
      intervalCount: row.intervalCount,
      active: row.active,
      productName: row.product?.name ?? null,
      externalProductId: row.externalProductId,
      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
    })),
    totals: {
      products: productTotal,
      offerings: offeringTotal,
      unlinkedOfferings: unlinked,
    },
  };
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
