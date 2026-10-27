/**
 * Reads over the agreements the sync engine wrote.
 *
 * Sibling of `catalog-repository`, with one structural difference: an agreement
 * has **two** nullable associations, so there are two unresolved counts rather
 * than one. Reporting a single "unresolved" figure would be wrong about half of
 * every half-linked row — and half-linked is the common case, because the two
 * parents come from two other functions that may not both be connected.
 *
 * The detail row is joined rather than flattened into the agreement. That is
 * the point of the split: `currentPeriodEnd` exists on subscriptions and will
 * not exist on the order forms and contracts that land in the same table, so a
 * reader asks for it by joining the type it belongs to.
 *
 * Scoped by `userId` through the integration, like every other request-scoped
 * read. There is no cross-integration merge here and inventing one would be a
 * guess — the same subscription sold through two providers is a claim only a
 * human can make, and `CustomerAccount` is where that kind of claim lives.
 */

import { prisma } from "@/lib/prisma";
import { priceLabel } from "../price-format";
import { readJsonObject } from "./json-column";

/**
 * One priced line, as the page renders it.
 *
 * No amount and no line total, and that is a decision rather than an omission:
 * an item is the *selection*, the price it points at holds the money, and a
 * subscription's true total is the provider's to state. Summing our lines here
 * would produce a confident number that is wrong the moment a line failed to
 * link — and this page has no way to know it did.
 */
export interface AgreementItemRow {
  id: string;
  offeringName: string | null;
  /** The provider's own offering id, present even when the link is unresolved. */
  externalOfferingId: string | null;
  /**
   * The provider's own price id — which of the offering's prices this line went
   * for. Present even when the price did not resolve, which is the state that
   * makes an unresolved line worth showing rather than hiding.
   */
  externalPriceId: string | null;
  quantity: number | null;
  /** plan | add_on | usage | charge, or null where the provider did not say. */
  itemType: string | null;
  /** flat_fee | per_unit | tiered | usage_based | one_time, or null. */
  billingModel: string | null;
  /**
   * What the provider says this line bills per unit *for this subscription*,
   * in minor units. Null for Stripe, which states no such price on a line.
   */
  unitPriceMinor: number | null;
  /** Units included at no charge — Chargebee's `free_quantity`. */
  freeQuantity: number | null;
}

/**
 * One effective entitlement under an agreement, as the page renders it.
 *
 * Distinct from a catalog `Entitlement` — this is what *this subscriber* gets,
 * inherited values and overrides already folded together — so the page reads
 * one or the other and never sums them. `featureName` is joined from `Feature`
 * because the payload's own name is deliberately not denormalized; when the
 * catalog feature is not linked, `externalFeatureId` is the fallback label.
 */
export interface AgreementEntitlementRow {
  id: string;
  featureName: string | null;
  externalFeatureId: string | null;
  value: string | null;
  valueName: string | null;
  limitValue: number | null;
  isOverride: boolean | null;
  isEnabled: boolean | null;
}

/** One discount stated on an agreement. Stated values only — no computed net. */
export interface AgreementDiscountRow {
  id: string;
  label: string | null;
  kind: string | null;
  percentOff: number | null;
  amountOffMinor: number | null;
  status: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface AgreementRow {
  id: string;
  externalSourceId: string;
  name: string;
  agreementType: string;
  status: string | null;
  effectiveDate: Date | null;
  endDate: Date | null;
  currency: string | null;

  customerName: string | null;
  /** The provider's own customer id, present even when the link is unresolved. */
  externalCustomerId: string | null;
  offeringName: string | null;
  externalOfferingId: string | null;

  /** The sold price, when it resolved — what the agreement is worth. */
  price: string | undefined;

  /** Joined from the detail table; null for an agreement of another type. */
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  trialStartsAt: Date | null;
  /**
   * The moment the provider says the subscription stops. Distinct from
   * `cancelAtPeriodEnd`, which is only whether it will, and from `endDate`,
   * which is the shared node's view of when it did.
   */
  cancelAt: Date | null;
  /**
   * The next scheduled renewal. The date the page sorts on, falling back to
   * `currentPeriodEnd`; Stripe never states it, so most Stripe rows rely on
   * the fallback.
   */
  nextBillingAt: Date | null;
  /** The primary line's cadence — day | week | month | year | null. */
  billingPeriod: string | null;
  billingPeriodCount: number | null;
  cancelAtPeriodEnd: boolean | null;
  quantity: number | null;
  /**
   * The provider's own count of priced lines, which is not the same fact as
   * `items.length`. That one is how many we stored; this one is how many it
   * said there were, and the two differing is how a rejected line becomes
   * visible instead of silently shortening the list.
   */
  itemCount: number | null;

  /** Every priced line, in the provider's own order. */
  items: AgreementItemRow[];

  /** The effective entitlements, with the catalog feature joined where it linked. */
  entitlements: AgreementEntitlementRow[];

  /** The discounts the provider stated on the agreement. */
  discounts: AgreementDiscountRow[];

  customFields: Record<string, string>;
  providerMetadata: Record<string, string>;
  integrationLabel: string;
}

export interface AgreementPage {
  agreements: AgreementRow[];
  totals: {
    agreements: number;
    /** Live in the commercial sense: trialing or active, nothing terminal. */
    active: number;
    /** Agreements that named a customer we could not resolve. */
    unlinkedCustomers: number;
    /** Agreements that named an offering we could not resolve. */
    unlinkedOfferings: number;
    /**
     * Subscriptions carrying more than one priced line.
     *
     * No longer a warning that data is missing — every line is stored now —
     * but still worth counting, because the Price column shows the first
     * line's price rather than the total, and a reader should know when the
     * figure they are looking at is one line of several.
     */
    multiItem: number;
  };
}

/** Statuses that mean the agreement is currently in force. */
export const LIVE_AGREEMENT_STATUSES = ["trialing", "active", "past_due"] as const;

/**
 * The includes every agreement read shares.
 *
 * Hoisted because the ordering split below needs two `findMany` calls over the
 * same shape, and two copies of an eleven-line include is two places for them
 * to drift.
 */
const AGREEMENT_INCLUDE = {
  integration: { select: { instanceLabel: true } },
  customer: { select: { name: true } },
  offering: { select: { name: true } },
  subscription: true,
  // Ordered by the provider's own sequence rather than by name or price,
  // because the order a subscription lists its lines in is information — the
  // base plan first, the things added to it after. Nulls last, which is where
  // Postgres puts them ascending.
  items: {
    orderBy: { position: "asc" as const },
    select: {
      id: true,
      externalOfferingId: true,
      externalPriceId: true,
      quantity: true,
      itemType: true,
      billingModel: true,
      unitPriceMinor: true,
      freeQuantity: true,
      offering: { select: { name: true } },
      // Read for the agreement-level price below, which is the *sold* price
      // rather than the offering's first one.
      price: {
        select: {
          amountMinor: true,
          currency: true,
          interval: true,
          intervalCount: true,
        },
      },
    },
  },
  entitlements: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      externalFeatureId: true,
      value: true,
      valueName: true,
      limitValue: true,
      isOverride: true,
      isEnabled: true,
      feature: { select: { name: true } },
    },
  },
  discounts: {
    orderBy: { id: "asc" as const },
    select: {
      id: true,
      label: true,
      kind: true,
      percentOff: true,
      amountOffMinor: true,
      status: true,
      startsAt: true,
      endsAt: true,
    },
  },
} as const;

/**
 * The date a row renews on: `nextBillingAt` when the provider stated it,
 * otherwise `currentPeriodEnd`. Null when neither is present.
 */
function renewalAt(row: {
  subscription: {
    nextBillingAt: Date | null;
    currentPeriodEnd: Date | null;
  } | null;
}): Date | null {
  return (
    row.subscription?.nextBillingAt ?? row.subscription?.currentPeriodEnd ?? null
  );
}

export async function loadAgreements(
  userId: string,
  take = 200
): Promise<AgreementPage> {
  const scope = { integration: { userId } };

  // Two queries rather than one `orderBy`, because the sort key is
  // `COALESCE(nextBillingAt, currentPeriodEnd)` and Prisma has no expression
  // ordering. Splitting on whether `nextBillingAt` is present lets each half
  // be ordered by the column that is actually populated — the fallback is
  // exact rather than "nextBillingAt first, and rows without one last" — and
  // taking `take` from each before merging is enough, because no row outside a
  // half's own top-`take` can be inside the merged top-`take`.
  const [withNext, withoutNext, total, active, unlinkedCustomers, unlinkedOfferings, multiItem] =
    await Promise.all([
      prisma.agreement.findMany({
        where: { ...scope, subscription: { nextBillingAt: { not: null } } },
        orderBy: [
          { subscription: { nextBillingAt: "asc" } },
          { name: "asc" },
        ],
        take,
        include: AGREEMENT_INCLUDE,
      }),
      prisma.agreement.findMany({
        where: {
          ...scope,
          OR: [{ subscription: null }, { subscription: { nextBillingAt: null } }],
        },
        // `currentPeriodEnd` is the fallback key, so it orders this half. Rows
        // with neither date still sort by name last, via the primary key,
        // which is the "nulls last" the page wants.
        orderBy: [
          { subscription: { currentPeriodEnd: "asc" } },
          { name: "asc" },
        ],
        take,
        include: AGREEMENT_INCLUDE,
      }),
      prisma.agreement.count({ where: scope }),
      prisma.agreement.count({
        where: { ...scope, status: { in: [...LIVE_AGREEMENT_STATUSES] } },
      }),
      prisma.agreement.count({
        where: { ...scope, customerId: null, externalCustomerId: { not: null } },
      }),
      prisma.agreement.count({
        where: { ...scope, offeringId: null, externalOfferingId: { not: null } },
      }),
      prisma.subscription.count({
        where: { integration: { userId }, itemCount: { gt: 1 } },
      }),
    ]);

  const agreements = [...withNext, ...withoutNext]
    .sort((a, b) => {
      const left = renewalAt(a);
      const right = renewalAt(b);
      if (left !== null && right !== null) {
        const delta = left.getTime() - right.getTime();
        if (delta !== 0) return delta;
      } else if (left !== null) {
        return -1;
      } else if (right !== null) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, take);

  return {
    agreements: agreements.map((row) => {
      // The price actually sold, taken from the first line rather than from the
      // offering's price list. An offering has several — monthly and yearly are
      // two rows on one offering — so the offering's first price is whichever
      // the database happened to return, which is a different question from
      // "what is this agreement billed at". The line's own link is the only
      // thing that answers that; see `AgreementItem.priceId`.
      const primaryPrice = row.items[0]?.price;
      return {
        id: row.id,
        externalSourceId: row.externalSourceId,
        name: row.name,
        agreementType: row.agreementType,
        status: row.status,
        effectiveDate: row.effectiveDate,
        endDate: row.endDate,
        currency: row.currency,

        customerName: row.customer?.name ?? null,
        externalCustomerId: row.externalCustomerId,
        offeringName: row.offering?.name ?? null,
        externalOfferingId: row.externalOfferingId,

        // Formatted from the linked price rather than stored on the agreement:
        // the price belongs to what was sold, and duplicating it here would be
        // a second copy to keep in step.
        price:
          primaryPrice === undefined || primaryPrice === null
            ? undefined
            : priceLabel({
                amountMinor: primaryPrice.amountMinor,
                currency: primaryPrice.currency,
                interval: primaryPrice.interval,
                intervalCount: primaryPrice.intervalCount,
              }),

        currentPeriodEnd: row.subscription?.currentPeriodEnd ?? null,
        trialEndsAt: row.subscription?.trialEndsAt ?? null,
        trialStartsAt: row.subscription?.trialStartsAt ?? null,
        cancelAt: row.subscription?.cancelAt ?? null,
        nextBillingAt: row.subscription?.nextBillingAt ?? null,
        billingPeriod: row.subscription?.billingPeriod ?? null,
        billingPeriodCount: row.subscription?.billingPeriodCount ?? null,
        cancelAtPeriodEnd: row.subscription?.cancelAtPeriodEnd ?? null,
        quantity: row.subscription?.quantity ?? null,
        itemCount: row.subscription?.itemCount ?? null,

        items: row.items.map((item) => ({
          id: item.id,
          offeringName: item.offering?.name ?? null,
          externalOfferingId: item.externalOfferingId,
          externalPriceId: item.externalPriceId,
          quantity: item.quantity,
          itemType: item.itemType,
          billingModel: item.billingModel,
          unitPriceMinor: item.unitPriceMinor,
          freeQuantity: item.freeQuantity,
        })),

        entitlements: row.entitlements.map((entitlement) => ({
          id: entitlement.id,
          featureName: entitlement.feature?.name ?? null,
          externalFeatureId: entitlement.externalFeatureId,
          value: entitlement.value,
          valueName: entitlement.valueName,
          limitValue: entitlement.limitValue,
          isOverride: entitlement.isOverride,
          isEnabled: entitlement.isEnabled,
        })),

        discounts: row.discounts.map((discount) => ({
          id: discount.id,
          label: discount.label,
          kind: discount.kind,
          percentOff: discount.percentOff,
          amountOffMinor: discount.amountOffMinor,
          status: discount.status,
          startsAt: discount.startsAt,
          endsAt: discount.endsAt,
        })),

        customFields: readJsonObject(row.customFields),
        providerMetadata: readJsonObject(row.providerMetadata),
        integrationLabel: row.integration.instanceLabel,
      };
    }),
    totals: {
      agreements: total,
      active,
      unlinkedCustomers,
      unlinkedOfferings,
      multiItem,
    },
  };
}
