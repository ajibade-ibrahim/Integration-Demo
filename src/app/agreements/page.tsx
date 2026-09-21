import Link from "next/link";

import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import { loadAgreements } from "@/core/repositories/agreement-repository";
import { Empty, Table, Td } from "../data-table";

export const dynamic = "force-dynamic";

export default async function AgreementsPage() {
  bootstrap();

  const { agreements, totals } = await loadAgreements(await currentUserId());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agreements</h1>
        <p className="mt-1 text-slate-600">
          What your customers agreed to — subscriptions today, order forms and
          contracts when a provider supplies them.
        </p>
      </div>

      {totals.agreements === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-slate-600">Nothing synced yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Connect an integration that serves the Agreement function, then run
            a sync.
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
            <Stat label="Agreements" value={totals.agreements} />
            <Stat label="In force" value={totals.active} />
          </div>

          {/*
            Two unresolved counts, not one. An agreement's customer comes from
            the identity function and its offering from catalog, so a row can
            have either half linked and the other not — and reporting a single
            "unresolved" figure would be wrong about half of every such row.
          */}
          {totals.unlinkedCustomers > 0 && (
            <Notice>
              {totals.unlinkedCustomers} agreement
              {totals.unlinkedCustomers === 1 ? "" : "s"} named a customer that
              is not synced. Add the <strong>Identity</strong> function to that
              integration and they will link themselves on the next sync.
            </Notice>
          )}

          {totals.unlinkedOfferings > 0 && (
            <Notice>
              {totals.unlinkedOfferings} agreement
              {totals.unlinkedOfferings === 1 ? "" : "s"} named an offering that
              is not in the catalog. Add the <strong>Catalog</strong> function to
              that integration and they will link themselves on the next sync.
            </Notice>
          )}

          {/*
            The multi-item caveat, stated where someone can act on it. Only the
            first priced line of a subscription is linked to an offering, so a
            subscription billing for a plan plus 25 seats shows the plan's price
            alone. Saying nothing would make that look like the whole amount.
          */}
          {totals.multiItem > 0 && (
            <Notice>
              {totals.multiItem} subscription
              {totals.multiItem === 1 ? " carries" : "s carry"} more than one
              priced item. Only the first is linked to an offering, so the price
              shown is that item&apos;s and not the total.
            </Notice>
          )}

          <Table
            headers={[
              "Agreement",
              "Type",
              "Status",
              "Customer",
              "Price",
              "Renews",
              "Source",
            ]}
          >
            {agreements.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Td className="font-medium">
                  {row.name}
                  {row.itemCount !== null && row.itemCount > 1 && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                      {row.itemCount} items
                    </span>
                  )}
                </Td>
                <Td className="text-slate-600">
                  {row.agreementType.replace("_", " ")}
                </Td>
                <Td>
                  <StatusCell
                    status={row.status}
                    cancelAtPeriodEnd={row.cancelAtPeriodEnd}
                    trialEndsAt={row.trialEndsAt}
                  />
                </Td>
                <Td>
                  <LinkCell
                    name={row.customerName}
                    externalId={row.externalCustomerId}
                  />
                </Td>
                <Td>
                  {row.price ?? (
                    <LinkCell
                      name={row.offeringName}
                      externalId={row.externalOfferingId}
                    />
                  )}
                  {row.quantity !== null && row.quantity > 1 && (
                    <span className="ml-1 text-xs text-slate-500">
                      × {row.quantity}
                    </span>
                  )}
                </Td>
                <Td className="text-slate-600">
                  {row.currentPeriodEnd === null ? (
                    <Empty />
                  ) : (
                    row.currentPeriodEnd.toISOString().slice(0, 10)
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
 * An association that may not have resolved.
 *
 * Three states, like `ActiveCell` on the catalog page: linked, named but
 * unresolved, or never claimed at all. The middle one is the reason this is not
 * just `{name ?? <Empty />}` — an agreement that names a customer we do not
 * have is a different situation from one that names nobody, and only the first
 * will fix itself.
 */
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
 * Status, plus the two things that change what it means.
 *
 * `active` and `active but cancelling at period end` are the same column value
 * and opposite commercial facts, so the badge says so. A trial end date gets
 * the same treatment: `trialing` without a date is a state, with one it is a
 * deadline.
 */
function StatusCell({
  status,
  cancelAtPeriodEnd,
  trialEndsAt,
}: {
  status: string | null;
  cancelAtPeriodEnd: boolean | null;
  trialEndsAt: Date | null;
}) {
  if (status === null) return <Empty />;

  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "trialing"
        ? "bg-sky-100 text-sky-800"
        : status === "past_due"
          ? "bg-amber-100 text-amber-800"
          : status === "canceled" || status === "expired"
            ? "bg-rose-100 text-rose-800"
            : "bg-slate-100 text-slate-600";

  return (
    <span className="whitespace-nowrap">
      <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>
        {status.replace("_", " ")}
      </span>
      {cancelAtPeriodEnd === true && (
        <span className="ml-1 rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">
          cancelling
        </span>
      )}
      {status === "trialing" && trialEndsAt !== null && (
        <span className="ml-1 text-xs text-slate-500">
          until {trialEndsAt.toISOString().slice(0, 10)}
        </span>
      )}
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
