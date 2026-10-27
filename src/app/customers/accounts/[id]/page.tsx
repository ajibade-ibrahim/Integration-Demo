import Link from "next/link";
import { notFound } from "next/navigation";

import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import { formatAmount } from "@/core/repositories/billing-repository";
import {
  loadAccountCommercial,
  type CommercialStatusCount,
} from "@/core/repositories/account-commercial-repository";
import { Empty, Table, Td } from "../../../data-table";

export const dynamic = "force-dynamic";

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export default async function AccountCommercialPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const view = await loadAccountCommercial(await currentUserId(), id);

  if (view === null) notFound();

  const { account, agreements, invoices, payments, summary } = view;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/customers?tab=accounts"
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← Accounts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {account.name}
        </h1>
        <p className="mt-1 text-slate-600">
          Commercial and payment context from the customer records resolved onto
          this account.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          {account.domain ?? "No domain"}
          {account.email === null ? "" : ` · ${account.email}`}
        </p>
      </div>

      <p className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
        This view covers commercial and payment context only. It does not
        measure usage, cost, reliability, communication, profitability or
        account health.
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        <span className="uppercase tracking-wide">Source records</span>
        {account.members.length === 0 ? (
          <span className="text-slate-400">none</span>
        ) : (
          account.members.map((member) => (
            <span
              key={member.id}
              title={`${member.name} · ${member.providerName} · ${member.integrationLabel}`}
              className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
            >
              {member.integrationLabel} #{member.externalSourceId}
            </span>
          ))
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <SummaryCard title="Commercial status">
          <p className="text-sm text-slate-500">
            {summary.agreementTotal} agreement
            {summary.agreementTotal === 1 ? "" : "s"} linked
          </p>
          {summary.agreementStatuses.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No agreements are linked to this account&apos;s records.
            </p>
          ) : (
            <StatusCounts counts={summary.agreementStatuses} />
          )}
          <p className="mt-3 text-xs text-slate-500">
            {summary.inForce} in force (trialing, active or past due)
            {summary.cancellingAgreements > 0
              ? ` · ${summary.cancellingAgreements} scheduled to end rather than renew`
              : ""}
          </p>
        </SummaryCard>

        <SummaryCard title="Next renewal">
          {summary.renewal === null ? (
            <p className="text-sm text-slate-500">
              No scheduled renewal from a live subscription.
            </p>
          ) : (
            <>
              <p className="text-xl font-semibold text-slate-900">
                {formatDate(summary.renewal.at)}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {summary.renewal.agreementNames.slice(0, 2).join(", ")}
                {summary.renewal.agreementNames.length > 2
                  ? ` +${summary.renewal.agreementNames.length - 2} more`
                  : ""}
              </p>
            </>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Earliest next billing date, or period end when the provider states
            no billing date. Agreements already scheduled to end are excluded.
          </p>
        </SummaryCard>

        <SummaryCard title="Payment state">
          <p className="text-sm text-slate-500">
            {summary.invoiceTotal} invoice
            {summary.invoiceTotal === 1 ? "" : "s"} linked
          </p>
          {summary.invoiceStatuses.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No invoices are linked to this account&apos;s records.
            </p>
          ) : (
            <StatusCounts counts={summary.invoiceStatuses} />
          )}
          <p className="mt-3 text-xs text-slate-500">
            {summary.paymentTotal} money movement
            {summary.paymentTotal === 1 ? "" : "s"}: {summary.payments} payment
            {summary.payments === 1 ? "" : "s"}, {summary.refunds} refund
            {summary.refunds === 1 ? "" : "s"}
            {summary.lastPaymentAt === null
              ? ""
              : ` · last activity ${formatDate(summary.lastPaymentAt)}`}
            {summary.failedPayments > 0
              ? ` · ${summary.failedPayments} failed payment${
                  summary.failedPayments === 1 ? "" : "s"
                }`
              : ""}
            {summary.disputedPayments > 0
              ? ` · ${summary.disputedPayments} disputed`
              : ""}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Invoice and payment states are shown separately from the commercial
            state.
          </p>
        </SummaryCard>
      </div>

      <CommercialSection
        title="Agreements"
        total={summary.agreementTotal}
        empty="No agreements are linked to this account's customer records."
      >
        <Table
          headers={[
            "Agreement",
            "Type",
            "Status",
            "Renewal",
            "Source",
          ]}
        >
          {agreements.map((row) => (
            <tr key={row.id} className="border-t border-slate-100">
              <Td className="font-medium">
                {row.name}
                <span className="ml-1 font-mono text-xs text-slate-400">
                  #{row.externalSourceId}
                </span>
              </Td>
              <Td className="text-slate-600">
                {row.agreementType.replace("_", " ")}
              </Td>
              <Td>
                <StatusBadge status={row.status} />
                {row.cancelAt !== null ? (
                  <span className="ml-1 text-xs text-slate-500">
                    cancels on {formatDate(row.cancelAt)}
                  </span>
                ) : row.cancelAtPeriodEnd === true ? (
                  <span className="ml-1 rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">
                    cancelling
                  </span>
                ) : null}
                {row.trialEndsAt !== null && (
                  <span className="ml-1 text-xs text-slate-500">
                    trial ends {formatDate(row.trialEndsAt)}
                  </span>
                )}
              </Td>
              <Td className="text-slate-600">
                {row.renewalAt === null ? <Empty /> : formatDate(row.renewalAt)}
              </Td>
              <Td className="text-xs text-slate-400">{row.integrationLabel}</Td>
            </tr>
          ))}
        </Table>
      </CommercialSection>

      <CommercialSection
        title="Invoices"
        total={summary.invoiceTotal}
        empty="No invoices are linked to this account's customer records or their agreements."
      >
        <Table
          headers={[
            "Invoice",
            "Status",
            "Agreement",
            "Total",
            "Due",
            "Issued",
            "Source",
          ]}
        >
          {invoices.map((row) => (
            <tr key={row.id} className="border-t border-slate-100">
              <Td className="font-medium">
                {row.number ?? row.externalSourceId}
                <span className="ml-1 font-mono text-xs text-slate-400">
                  #{row.externalSourceId}
                </span>
              </Td>
              <Td>
                <StatusBadge status={row.status} />
              </Td>
              <Td className="text-slate-600">
                {row.agreementName ?? <Empty />}
              </Td>
              <Td className="whitespace-nowrap text-slate-600">
                {formatAmount(row.totalMinor, row.currency) ?? <Empty />}
              </Td>
              <Td className="whitespace-nowrap">
                {row.amountDueMinor === null ? (
                  <Empty />
                ) : (
                  <span
                    className={
                      row.amountDueMinor === 0
                        ? "text-slate-600"
                        : "text-amber-700"
                    }
                  >
                    {formatAmount(row.amountDueMinor, row.currency)}
                  </span>
                )}
              </Td>
              <Td className="text-slate-600">
                {row.issuedAt === null ? <Empty /> : formatDate(row.issuedAt)}
              </Td>
              <Td className="text-xs text-slate-400">{row.integrationLabel}</Td>
            </tr>
          ))}
        </Table>
      </CommercialSection>

      <CommercialSection
        title="Payments and refunds"
        total={summary.paymentTotal}
        empty="No payments or refunds are linked to this account's customer records or their invoices."
      >
        <Table
          headers={[
            "Movement",
            "Status",
            "Amount",
            "Processed",
            "Invoice",
            "Source",
          ]}
        >
          {payments.map((row) => (
            <tr key={row.id} className="border-t border-slate-100">
              <Td className="font-medium">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    row.kind === "refund"
                      ? "bg-rose-50 text-rose-700"
                      : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {row.kind === "refund" ? "Refund" : "Payment"}
                </span>
                <span className="ml-1 font-mono text-xs text-slate-400">
                  #{row.externalSourceId}
                </span>
                {row.method !== null && (
                  <span className="ml-1 text-xs text-slate-500">
                    {row.method}
                  </span>
                )}
              </Td>
              <Td>
                <StatusBadge status={row.status} />
                {row.failureReason !== null && (
                  <span className="ml-1 text-xs text-rose-700">
                    {row.failureReason}
                  </span>
                )}
                {row.isDisputed === true && (
                  <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                    disputed
                  </span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-slate-600">
                {formatAmount(row.amountMinor, row.currency) ?? <Empty />}
              </Td>
              <Td className="text-slate-600">
                {row.processedAt === null ? (
                  <Empty />
                ) : (
                  formatDate(row.processedAt)
                )}
              </Td>
              <Td className="text-slate-600">
                {row.invoiceLabel ?? <Empty />}
              </Td>
              <Td className="text-xs text-slate-400">{row.integrationLabel}</Td>
            </tr>
          ))}
        </Table>
      </CommercialSection>
    </div>
  );
}

function SummaryCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function StatusCounts({ counts }: { counts: CommercialStatusCount[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {counts.map((row) => (
        <span
          key={row.status ?? "unknown"}
          className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
        >
          <StatusBadge status={row.status} />
          <span className="ml-1 font-medium">{row.count}</span>
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === null) {
    return <span className="text-xs text-slate-400">not stated</span>;
  }

  const tone =
    status === "active" || status === "paid" || status === "succeeded"
      ? "bg-emerald-100 text-emerald-800"
      : status === "trialing" || status === "open"
        ? "bg-sky-100 text-sky-800"
        : status === "past_due" || status === "pending"
          ? "bg-amber-100 text-amber-800"
          : status === "canceled" ||
              status === "expired" ||
              status === "uncollectible" ||
              status === "failed" ||
              status === "refunded" ||
              status === "reversed"
            ? "bg-rose-100 text-rose-800"
            : "bg-slate-100 text-slate-600";

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function CommercialSection({
  title,
  total,
  empty,
  children,
}: {
  title: string;
  total: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className="text-sm text-slate-500">
          {total} linked
        </span>
      </div>
      {total === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}
