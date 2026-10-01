import Link from "next/link";

import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  formatAmount,
  loadInvoices,
  type InvoiceLineRow,
  type InvoiceRow,
  type PaymentRow,
} from "@/core/repositories/billing-repository";
import { Empty, Table, Td } from "../data-table";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  bootstrap();

  const { invoices, totals } = await loadInvoices(await currentUserId());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-slate-600">
          The invoices your customers were sent, what was on them, and the money
          that actually moved.
        </p>
      </div>

      {totals.invoices === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-slate-600">Nothing synced yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Connect an integration that serves the Billing function, then run a
            sync.
          </p>
          <Link
            href="/integrations"
            className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Go to integrations
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Invoices" value={totals.invoices} />
            <Stat label="Outstanding" value={totals.outstanding} />
            <Stat label="Payments" value={totals.payments} />
          </div>

          {/*
            Two unresolved counts, not one. An invoice's customer comes from the
            identity function and its agreement from agreement, so a row can
            have either half linked and the other not.
          */}
          {totals.unlinkedCustomers > 0 && (
            <Notice>
              {totals.unlinkedCustomers} invoice
              {totals.unlinkedCustomers === 1 ? "" : "s"} named a customer that
              is not synced. Add the <strong>Identity</strong> function to that
              integration and they will link themselves on the next sync.
            </Notice>
          )}

          {totals.unlinkedAgreements > 0 && (
            <Notice>
              {totals.unlinkedAgreements} invoice
              {totals.unlinkedAgreements === 1 ? "" : "s"} named an agreement
              that is not synced. Add the <strong>Agreement</strong> function to
              that integration and they will link themselves on the next sync.
            </Notice>
          )}

          <Table
            headers={[
              "Invoice",
              "Status",
              "Customer",
              "Agreement",
              "Total",
              "Issued",
              "Source",
            ]}
          >
            {invoices.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Td className="font-medium">
                  {row.number ?? row.externalSourceId}
                  <DetailsCell
                    lines={row.lines}
                    payments={row.payments}
                    currency={row.currency}
                  />
                </Td>
                <Td>
                  <StatusCell status={row.status} />
                </Td>
                <Td>
                  <LinkCell
                    name={row.customerName}
                    externalId={row.externalCustomerId}
                  />
                </Td>
                <Td>
                  <LinkCell
                    name={row.agreementName}
                    externalId={row.externalAgreementId}
                  />
                </Td>
                <Td className="whitespace-nowrap">
                  <AmountCell
                    totalMinor={row.totalMinor}
                    paidMinor={row.amountPaidMinor}
                    currency={row.currency}
                  />
                  <DueCell
                    amountDueMinor={row.amountDueMinor}
                    currency={row.currency}
                  />
                </Td>
                <Td className="text-slate-600">
                  {row.issuedAt === null ? (
                    <Empty />
                  ) : (
                    row.issuedAt.toISOString().slice(0, 10)
                  )}
                </Td>
                <Td className="text-xs text-slate-400">
                  {row.integrationLabel}
                  <span className="ml-1 font-mono">
                    #{row.externalSourceId}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * Everything an invoice carries below its header, disclosed on demand.
 *
 * A `<details>` element rather than a click handler, which keeps this a server
 * component — the whole route renders without shipping any JavaScript.
 */
function DetailsCell({
  lines,
  payments,
  currency,
}: {
  lines: InvoiceLineRow[];
  payments: PaymentRow[];
  currency: string | null;
}) {
  if (lines.length === 0 && payments.length === 0) return null;

  const summary = [
    lines.length > 0 ? `${lines.length} lines` : null,
    payments.length > 0 ? `${payments.length} payments` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <details className="mt-1 font-normal">
      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">
        {summary}
      </summary>
      <div className="mt-1 space-y-2">
        {lines.length > 0 && <LineList lines={lines} currency={currency} />}
        {payments.length > 0 && <PaymentList payments={payments} />}
      </div>
    </details>
  );
}

/**
 * The invoice's lines.
 *
 * Each line is shown at the amount the provider billed, and the lines are
 * **not** summed into the Total column — that figure is the provider's own, and
 * a credit or tax adjustment it accounts for is out of scope here, so a sum
 * could disagree with it.
 */
function LineList({
  lines,
  currency,
}: {
  lines: InvoiceLineRow[];
  currency: string | null;
}) {
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line.id} className="text-xs text-slate-600">
          <span className="font-medium">
            {line.description ??
              line.offeringName ??
              line.externalOfferingId ??
              "line"}
          </span>
          {line.quantity !== null && line.quantity > 1 && (
            <span className="ml-1 text-slate-500">× {line.quantity}</span>
          )}
          {line.amountMinor !== null && (
            <span className="ml-1">
              {formatAmount(line.amountMinor, currency) ?? line.amountMinor}
            </span>
          )}
          {line.itemType !== null && (
            <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              {line.itemType.replace("_", " ")}
            </span>
          )}
          {line.isProration === true && (
            <span className="ml-1 rounded bg-sky-100 px-1 py-0.5 text-sky-700">
              prorated
            </span>
          )}
          {line.periodStart !== null && (
            <span className="ml-1 text-slate-400">
              {line.periodStart.toISOString().slice(0, 10)}
              {line.periodEnd !== null &&
                ` – ${line.periodEnd.toISOString().slice(0, 10)}`}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The money that moved under the invoice.
 *
 * Kind-labelled, because "Refunded" is not "Paid" — the direction is the first
 * thing a reader needs and a bare amount would lose it. A payment with no
 * invoice link is not shown here at all (it has no invoice to nest under); a
 * refund that points at this invoice is.
 */
function PaymentList({ payments }: { payments: PaymentRow[] }) {
  return (
    <ul className="space-y-0.5">
      {payments.map((payment) => (
        <li key={payment.id} className="text-xs text-slate-600">
          <span
            className={`rounded px-1 py-0.5 ${
              payment.kind === "refund"
                ? "bg-rose-50 text-rose-700"
                : "bg-emerald-50 text-emerald-700"
            }`}
          >
            {payment.kind === "refund" ? "Refunded" : "Paid"}
          </span>
          {payment.amountMinor !== null && (
            <span className="ml-1">
              {formatAmount(payment.amountMinor, payment.currency) ??
                payment.amountMinor}
            </span>
          )}
          {payment.method !== null && (
            <span className="ml-1 text-slate-500">{payment.method}</span>
          )}
          {payment.status !== null && (
            <span className="ml-1 text-slate-400">{payment.status}</span>
          )}
          {payment.processedAt !== null && (
            <span className="ml-1 text-slate-400">
              {payment.processedAt.toISOString().slice(0, 10)}
            </span>
          )}
          {payment.isDisputed === true && (
            <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-amber-800">
              disputed
            </span>
          )}
          {payment.failureReason !== null && (
            <span className="ml-1 text-rose-700">{payment.failureReason}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Total, with what was actually paid beside it, so "paid $49 of $69" is
 * legible at a glance.
 */
function AmountCell({
  totalMinor,
  paidMinor,
  currency,
}: {
  totalMinor: number | null;
  paidMinor: number | null;
  currency: string | null;
}) {
  const total = formatAmount(totalMinor, currency);
  if (total === null) return <Empty />;

  return (
    <span>
      {total}
      {paidMinor !== null && paidMinor !== totalMinor && (
        <span className="ml-1 text-xs text-slate-500">
          ({formatAmount(paidMinor, currency)} paid)
        </span>
      )}
    </span>
  );
}

/** The amount still owed, shown only when there is one to show. */
function DueCell({
  amountDueMinor,
  currency,
}: {
  amountDueMinor: number | null;
  currency: string | null;
}) {
  if (amountDueMinor === null || amountDueMinor === 0) return null;
  return (
    <span className="ml-1 text-xs text-amber-700">
      {formatAmount(amountDueMinor, currency)} due
    </span>
  );
}

function LinkCell({
  name,
  externalId,
}: {
  name: string | null;
  externalId: string | null;
}) {
  if (name !== null) return <>{name}</>;
  if (externalId !== null) {
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
        unresolved #{externalId}
      </span>
    );
  }
  return <Empty />;
}

/**
 * The invoice's status, in our vocabulary rather than the provider's.
 *
 * `draft` is what Chargebee's `pending` becomes, and `past_due` is where both
 * of Chargebee's retry states land — so the label never shows a provider word.
 */
function StatusCell({ status }: { status: string | null }) {
  if (status === null) return <Empty />;

  const tone =
    status === "paid"
      ? "bg-emerald-100 text-emerald-800"
      : status === "open"
        ? "bg-sky-100 text-sky-800"
        : status === "past_due"
          ? "bg-amber-100 text-amber-800"
          : status === "uncollectible"
            ? "bg-rose-100 text-rose-800"
            : status === "void"
              ? "bg-slate-100 text-slate-500"
              : "bg-slate-100 text-slate-600";

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
      <span className="text-slate-500">{label}</span>{" "}
      <span className="font-medium">{value}</span>
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {children}
    </p>
  );
}
