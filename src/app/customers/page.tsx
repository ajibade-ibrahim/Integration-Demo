import Link from "next/link";
import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  loadAssertionsForDisplay,
  loadCustomerAccounts,
  loadSyncedData,
} from "@/core/repositories/synced-data-repository";
import { listResolutionRuns } from "@/core/repositories/identity-repository";
import { AccountsPanel } from "./accounts-panel";

export const dynamic = "force-dynamic";

export default async function SyncedDataPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  bootstrap();

  const { tab } = await searchParams;
  const showContacts = tab === "contacts";
  const showAccounts = tab === "accounts";

  const userId = await currentUserId();
  const { customers, contacts, totals } = await loadSyncedData(userId);

  // Only for the tab that renders them. The accounts read pulls members and
  // keys for every account, which is a lot of rows to fetch for a page showing
  // the customer table.
  const [accounts, assertions, runs] = showAccounts
    ? await Promise.all([
        loadCustomerAccounts(userId),
        loadAssertionsForDisplay(userId),
        listResolutionRuns(userId, 1),
      ])
    : [[], [], []];

  // The issues of the most recent pass are the current ones by construction:
  // resolution recomputes every account, key and field from scratch, so
  // anything it did not report again has been settled.
  const latestRun = runs[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Synced data</h1>
        <p className="mt-1 text-slate-600">
          Records written by your integrations, after field mapping.
        </p>
      </div>

      {totals.customers === 0 && totals.contacts === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-slate-600">Nothing synced yet.</p>
          <Link
            href="/integrations"
            className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Go to integrations
          </Link>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-slate-200">
            <Tab href="/customers" active={!showContacts && !showAccounts}>
              Customers ({totals.customers})
            </Tab>
            <Tab href="/customers?tab=contacts" active={showContacts}>
              Contacts ({totals.contacts})
            </Tab>
            {/*
              Listed last but it is the answer the other two raise: the same
              company appears once per integration in Customers, and this is
              where those rows become one company.
            */}
            <Tab href="/customers?tab=accounts" active={showAccounts}>
              Accounts
            </Tab>
          </div>

          {/*
            Surfaced rather than buried: a contact that named a company we could
            not resolve is kept with a null link, and a later sync relinks it
            once that company arrives. Showing the count is what makes that a
            transparent policy rather than quiet data loss.
          */}
          {showContacts && totals.unlinkedContacts > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {totals.unlinkedContacts} contact
              {totals.unlinkedContacts === 1 ? "" : "s"} named a company that has
              not been synced yet. They are kept and will link automatically once
              that company arrives.
            </p>
          )}

          {showAccounts ? (
            <AccountsPanel
              accounts={accounts.map((account) => ({
                ...account,
                // Serialized for the client boundary; a Date does not cross it.
                createDate: account.createDate?.toISOString() ?? null,
              }))}
              issues={latestRun?.issues ?? []}
              assertions={assertions}
              lastRunAt={
                latestRun?.completedAt?.toLocaleString() ??
                latestRun?.startedAt.toLocaleString() ??
                null
              }
            />
          ) : showContacts ? (
            <ContactTable rows={contacts} />
          ) : (
            <CustomerTable rows={customers} />
          )}
        </>
      )}
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`-mb-px border-b-2 px-3 py-2 text-sm ${
        active
          ? "border-slate-900 font-medium text-slate-900"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
    >
      {children}
    </Link>
  );
}

function CustomerTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof loadSyncedData>>["customers"];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <Th>Name</Th>
            <Th>Domain</Th>
            <Th>Email</Th>
            <Th>Industry</Th>
            <Th>Type</Th>
            <Th>Created</Th>
            <Th>Contacts</Th>
            <Th>Custom fields</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="font-medium text-slate-900">{row.name}</Td>
              <Td>{row.domain ?? <Empty />}</Td>
              <Td>{row.email ?? <Empty />}</Td>
              <Td>{row.industry ?? <Empty />}</Td>
              <Td>{row.type ?? <Empty />}</Td>
              <Td>
                {row.createDate === null ? (
                  <Empty />
                ) : (
                  row.createDate.toLocaleDateString()
                )}
              </Td>
              <Td>{row.contactCount}</Td>
              <Td>
                {Object.keys(row.customFields).length === 0 ? (
                  <Empty />
                ) : (
                  <span className="font-mono text-xs text-slate-600">
                    {Object.entries(row.customFields)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(", ")}
                  </span>
                )}
              </Td>
              <Td className="text-xs text-slate-400">
                {row.integrationLabel}
                <span className="ml-1 font-mono">#{row.externalSourceId}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof loadSyncedData>>["contacts"];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Job title</Th>
            <Th>Phone</Th>
            <Th>Customer</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="font-medium text-slate-900">{row.name}</Td>
              <Td>{row.email ?? <Empty />}</Td>
              <Td>{row.jobTitle ?? <Empty />}</Td>
              <Td>{row.phone ?? <Empty />}</Td>
              <Td>
                {row.customerName !== null ? (
                  row.customerName
                ) : row.externalCustomerId !== null ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                    unresolved #{row.externalCustomerId}
                  </span>
                ) : (
                  <Empty />
                )}
              </Td>
              <Td className="text-xs text-slate-400">
                {row.integrationLabel}
                <span className="ml-1 font-mono">#{row.externalSourceId}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-2 align-top ${className}`}>{children}</td>;
}

function Empty() {
  return <span className="text-slate-300">—</span>;
}
