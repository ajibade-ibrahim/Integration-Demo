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

  /** The offering's price, when it resolved — what the agreement is worth. */
  price: string | undefined;

  /** Joined from the detail table; null for an agreement of another type. */
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  quantity: number | null;
  itemCount: number | null;

  customFields: Record<string, string>;
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
    /** Subscriptions carrying more priced lines than the one we linked. */
    multiItem: number;
  };
}

/** Statuses that mean the agreement is currently in force. */
const LIVE_STATUSES = ["trialing", "active", "past_due"];

export async function loadAgreements(
  userId: string,
  take = 200
): Promise<AgreementPage> {
  const scope = { integration: { userId } };

  const [agreements, total, active, unlinkedCustomers, unlinkedOfferings, multiItem] =
    await Promise.all([
      prisma.agreement.findMany({
        where: scope,
        // Soonest renewal first among the live ones, because "what is coming
        // up" is the question this page exists to answer. Agreements with no
        // period sort last rather than first — Postgres puts NULLs last on an
        // ascending sort, which is the order we want here.
        orderBy: [{ subscription: { currentPeriodEnd: "asc" } }, { name: "asc" }],
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          customer: { select: { name: true } },
          offering: {
            select: {
              name: true,
              amountMinor: true,
              currency: true,
              interval: true,
              intervalCount: true,
            },
          },
          subscription: true,
        },
      }),
      prisma.agreement.count({ where: scope }),
      prisma.agreement.count({
        where: { ...scope, status: { in: LIVE_STATUSES } },
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

  return {
    agreements: agreements.map((row) => ({
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

      // Formatted from the offering rather than stored on the agreement: the
      // price belongs to what was sold, and duplicating it here would be a
      // second copy to keep in step.
      price:
        row.offering === null
          ? undefined
          : priceLabel({
              amountMinor: row.offering.amountMinor,
              currency: row.offering.currency,
              interval: row.offering.interval,
              intervalCount: row.offering.intervalCount,
            }),

      currentPeriodEnd: row.subscription?.currentPeriodEnd ?? null,
      trialEndsAt: row.subscription?.trialEndsAt ?? null,
      cancelAtPeriodEnd: row.subscription?.cancelAtPeriodEnd ?? null,
      quantity: row.subscription?.quantity ?? null,
      itemCount: row.subscription?.itemCount ?? null,

      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
    })),
    totals: {
      agreements: total,
      active,
      unlinkedCustomers,
      unlinkedOfferings,
      multiItem,
    },
  };
}
