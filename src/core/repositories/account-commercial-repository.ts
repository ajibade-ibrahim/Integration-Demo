/**
 * One account's commercial and payment context, read from the member records
 * identity resolution already grouped together.
 *
 * This is a read model over existing rows, not a new source of truth. It uses
 * the `CustomerAccount` only as membership: the agreements, invoices and
 * payments remain the provider's records, keep their own status vocabulary,
 * and are never merged into one derived account status. The view therefore
 * has two independent summaries — commercial (agreement states and renewal
 * dates) and payment (invoice and money-movement states) — because the
 * framework's rule is that an account has no single status.
 *
 * Every query is scoped to one user and one account, and all member ids are
 * collected once. That keeps the read at a fixed query count regardless of how
 * many records identity resolution matched.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  AGREEMENT_STATUSES,
  INVOICE_STATUSES,
} from "../types/common";import { LIVE_AGREEMENT_STATUSES } from "./agreement-repository";

/** One customer record that resolved onto the account. */
export interface CommercialAccountMember {
  id: string;
  externalSourceId: string;
  name: string;
  integrationLabel: string;
  providerName: string;
}

/** An agreement linked to one of the account's member records. */
export interface CommercialAgreementRow {
  id: string;
  externalSourceId: string;
  name: string;
  agreementType: string;
  status: string | null;
  currency: string | null;
  renewalAt: Date | null;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  trialEndsAt: Date | null;
  integrationLabel: string;
}

/** An invoice linked directly to a member, or through a member's agreement. */
export interface CommercialInvoiceRow {
  id: string;
  externalSourceId: string;
  number: string | null;
  status: string | null;
  currency: string | null;
  totalMinor: number | null;
  amountDueMinor: number | null;
  issuedAt: Date | null;
  agreementName: string | null;
  integrationLabel: string;
}

/** A payment or refund linked to a member, directly or through an invoice. */
export interface CommercialPaymentRow {
  id: string;
  externalSourceId: string;
  kind: string;
  status: string | null;
  amountMinor: number | null;
  currency: string | null;
  processedAt: Date | null;
  method: string | null;
  failureReason: string | null;
  isDisputed: boolean | null;
  invoiceLabel: string | null;
  integrationLabel: string;
}

export interface CommercialStatusCount {
  status: string | null;
  count: number;
}

export interface CommercialRenewal {
  at: Date;
  /** Every agreement whose next date is this earliest one. */
  agreementNames: string[];
}

export interface AccountCommercialSummary {
  agreementTotal: number;
  /** Trialing, active or past due — the same definition as /agreements. */
  inForce: number;
  /** Live subscriptions already scheduled to end rather than renew. */
  cancellingAgreements: number;
  agreementStatuses: CommercialStatusCount[];

  renewal: CommercialRenewal | null;

  invoiceTotal: number;
  invoiceStatuses: CommercialStatusCount[];

  paymentTotal: number;
  payments: number;
  refunds: number;
  failedPayments: number;
  disputedPayments: number;
  lastPaymentAt: Date | null;
}

export interface AccountCommercialPage {
  account: {
    id: string;
    name: string;
    domain: string | null;
    email: string | null;
    members: CommercialAccountMember[];
  };
  agreements: CommercialAgreementRow[];
  invoices: CommercialInvoiceRow[];
  payments: CommercialPaymentRow[];
  summary: AccountCommercialSummary;
}

const AGREEMENT_STATUS_ORDER: readonly string[] = AGREEMENT_STATUSES;
const INVOICE_STATUS_ORDER: readonly string[] = INVOICE_STATUSES;

function sortStatusCounts(
  counts: CommercialStatusCount[],
  order: readonly string[]
): CommercialStatusCount[] {
  const rank = new Map(order.map((status, index) => [status, index]));

  return [...counts].sort((left, right) => {
    const leftRank =
      left.status === null
        ? order.length
        : (rank.get(left.status) ?? order.length);
    const rightRank =
      right.status === null
        ? order.length
        : (rank.get(right.status) ?? order.length);

    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.status ?? "").localeCompare(right.status ?? "");
  });
}

/**
 * The account view, or `null` when the account does not belong to this user.
 *
 * `take` bounds the detail tables. The summary counts come from aggregate
 * queries, so they remain accurate even when a table is capped.
 */
export async function loadAccountCommercial(
  userId: string,
  accountId: string,
  take = 200
): Promise<AccountCommercialPage | null> {
  const account = await prisma.customerAccount.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true,
      name: true,
      domain: true,
      email: true,
      members: {
        orderBy: [{ externalSourceId: "asc" }, { id: "asc" }],
        select: {
          id: true,
          externalSourceId: true,
          name: true,
          integration: {
            select: { instanceLabel: true, providerName: true },
          },
        },
      },
    },
  });

  if (account === null) return null;

  const memberIds = account.members.map((member) => member.id);

  // Direct membership is enough for an agreement. An invoice and a payment can
  // also arrive through an agreement, which is why their filters traverse that
  // relation as well as the customer id.
  const agreementWhere: Prisma.AgreementWhereInput = {
    integration: { userId },
    customerId: { in: memberIds },
  };
  const invoiceOr: Prisma.InvoiceWhereInput[] = [
    { customerId: { in: memberIds } },
    { agreement: { is: { customerId: { in: memberIds } } } },
  ];
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    integration: { userId },
    OR: invoiceOr,
  };
  const paymentWhere: Prisma.PaymentWhereInput = {
    integration: { userId },
    OR: [
      { customerId: { in: memberIds } },
      { invoice: { is: { OR: invoiceOr } } },
    ],
  };

  const [
    agreementRows,
    agreementStatusGroups,
    liveAgreementRows,
    invoiceRows,
    invoiceStatusGroups,
    paymentRows,
    paymentGroups,
  ] = await Promise.all([
    prisma.agreement.findMany({
      where: agreementWhere,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        externalSourceId: true,
        name: true,
        agreementType: true,
        status: true,
        currency: true,
        integration: { select: { instanceLabel: true } },
        subscription: {
          select: {
            nextBillingAt: true,
            currentPeriodEnd: true,
            cancelAt: true,
            cancelAtPeriodEnd: true,
            trialEndsAt: true,
          },
        },
      },
    }),
    prisma.agreement.groupBy({
      by: ["status"],
      where: agreementWhere,
      _count: { _all: true },
    }),
    // The renewal summary is computed from every live subscription rather than
    // from the capped detail list, so a busy account cannot hide its next date
    // behind the first page of agreements.
    prisma.agreement.findMany({
      where: {
        ...agreementWhere,
        status: { in: [...LIVE_AGREEMENT_STATUSES] },
      },
      select: {
        name: true,
        subscription: {
          select: {
            nextBillingAt: true,
            currentPeriodEnd: true,
            cancelAt: true,
            cancelAtPeriodEnd: true,
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: invoiceWhere,
      orderBy: { issuedAt: { sort: "desc", nulls: "last" } },
      take,
      select: {
        id: true,
        externalSourceId: true,
        number: true,
        status: true,
        currency: true,
        totalMinor: true,
        amountDueMinor: true,
        issuedAt: true,
        integration: { select: { instanceLabel: true } },
        agreement: { select: { name: true } },
      },
    }),
    prisma.invoice.groupBy({
      by: ["status"],
      where: invoiceWhere,
      _count: { _all: true },
    }),
    prisma.payment.findMany({
      where: paymentWhere,
      orderBy: [
        { processedAt: { sort: "desc", nulls: "last" } },
        { id: "asc" },
      ],
      take,
      select: {
        id: true,
        externalSourceId: true,
        kind: true,
        status: true,
        amountMinor: true,
        currency: true,
        processedAt: true,
        method: true,
        failureReason: true,
        isDisputed: true,
        integration: { select: { instanceLabel: true } },
        invoice: { select: { number: true, externalSourceId: true } },
      },
    }),
    prisma.payment.groupBy({
      by: ["kind", "status", "isDisputed"],
      where: paymentWhere,
      _count: { _all: true },
    }),
  ]);

  const agreementStatuses = sortStatusCounts(
    agreementStatusGroups.map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
    AGREEMENT_STATUS_ORDER
  );
  const invoiceStatuses = sortStatusCounts(
    invoiceStatusGroups.map((row) => ({
      status: row.status,
      count: row._count._all,
    })),
    INVOICE_STATUS_ORDER
  );

  const liveSubscriptions = liveAgreementRows.flatMap((row) => {
    const subscription = row.subscription;
    if (subscription === null) return [];

    const at = subscription.nextBillingAt ?? subscription.currentPeriodEnd;
    if (at === null) return [];

    return [
      {
        name: row.name,
        at,
        cancelling:
          subscription.cancelAtPeriodEnd === true ||
          subscription.cancelAt !== null,
      },
    ];
  });

  const cancellingAgreements = liveAgreementRows.filter(
    (row) =>
      row.subscription !== null &&
      (row.subscription.cancelAtPeriodEnd === true ||
        row.subscription.cancelAt !== null)
  ).length;
  const renewals = liveSubscriptions
    .filter((row) => !row.cancelling)
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const earliest = renewals[0] ?? null;
  const renewal: CommercialRenewal | null =
    earliest === null
      ? null
      : {
          at: earliest.at,
          agreementNames: renewals
            .filter((row) => row.at.getTime() === earliest.at.getTime())
            .map((row) => row.name)
            .sort(),
        };

  const agreementTotal = agreementStatuses.reduce(
    (total, row) => total + row.count,
    0
  );
  const inForce = agreementStatuses
    .filter(
      (row) =>
        row.status !== null &&
        (LIVE_AGREEMENT_STATUSES as readonly string[]).includes(row.status)
    )
    .reduce((total, row) => total + row.count, 0);
  const invoiceTotal = invoiceStatuses.reduce(
    (total, row) => total + row.count,
    0
  );

  const paymentTotal = paymentGroups.reduce(
    (total, row) => total + row._count._all,
    0
  );
  const payments = paymentGroups
    .filter((row) => row.kind === "payment")
    .reduce((total, row) => total + row._count._all, 0);
  const refunds = paymentGroups
    .filter((row) => row.kind === "refund")
    .reduce((total, row) => total + row._count._all, 0);
  const failedPayments = paymentGroups
    .filter((row) => row.kind === "payment" && row.status === "failed")
    .reduce((total, row) => total + row._count._all, 0);
  const disputedPayments = paymentGroups
    .filter((row) => row.isDisputed === true)
    .reduce((total, row) => total + row._count._all, 0);

  return {
    account: {
      id: account.id,
      name: account.name,
      domain: account.domain,
      email: account.email,
      members: account.members.map((member) => ({
        id: member.id,
        externalSourceId: member.externalSourceId,
        name: member.name,
        integrationLabel: member.integration.instanceLabel,
        providerName: member.integration.providerName,
      })),
    },
    agreements: agreementRows.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      agreementType: row.agreementType,
      status: row.status,
      currency: row.currency,
      renewalAt:
        row.subscription?.nextBillingAt ??
        row.subscription?.currentPeriodEnd ??
        null,
      cancelAt: row.subscription?.cancelAt ?? null,
      cancelAtPeriodEnd: row.subscription?.cancelAtPeriodEnd ?? null,
      trialEndsAt: row.subscription?.trialEndsAt ?? null,
      integrationLabel: row.integration.instanceLabel,
    })),
    invoices: invoiceRows.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      number: row.number,
      status: row.status,
      currency: row.currency,
      totalMinor: row.totalMinor,
      amountDueMinor: row.amountDueMinor,
      issuedAt: row.issuedAt,
      agreementName: row.agreement?.name ?? null,
      integrationLabel: row.integration.instanceLabel,
    })),
    payments: paymentRows.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      kind: row.kind,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      processedAt: row.processedAt,
      method: row.method,
      failureReason: row.failureReason,
      isDisputed: row.isDisputed,
      invoiceLabel: row.invoice?.number ?? row.invoice?.externalSourceId ?? null,
      integrationLabel: row.integration.instanceLabel,
    })),
    summary: {
      agreementTotal,
      inForce,
      cancellingAgreements,
      agreementStatuses,
      renewal,
      invoiceTotal,
      invoiceStatuses,
      paymentTotal,
      payments,
      refunds,
      failedPayments,
      disputedPayments,
      lastPaymentAt: paymentRows[0]?.processedAt ?? null,
    },
  };
}
