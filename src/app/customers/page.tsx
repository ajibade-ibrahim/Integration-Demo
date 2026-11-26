import Link from "next/link";
import { redirect } from "next/navigation";
import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  buildDataHref,
  pageCount,
  parsePage,
  resolveIntegrationScope,
} from "@/lib/integration-scope";
import {
  loadAssertionsForDisplay,
  loadCustomerAccounts,
  loadSyncedData,
} from "@/core/repositories/synced-data-repository";
import { listResolutionRuns } from "@/core/repositories/identity-repository";
import {
  countEmailMessagesForUser,
  loadEmailMessagesForUser,
  type EmailMessageListRow,
} from "@/core/repositories/email-message-repository";
import {
  countSlackConversationsForUser,
  loadSlackConversationsForUser,
  type SlackConversationListRow,
} from "@/core/repositories/slack-conversation-repository";
import {
  isSlackConversationKind,
  SLACK_CONVERSATION_KIND_FILTERS,
  SLACK_CONVERSATION_KIND_LABELS,
} from "./slack-kind";
import { Pager } from "../pager";
import { ScopeBanner, UnresolvedScopeNotice } from "../scope-banner";
import { AccountsPanel } from "./accounts-panel";

export const dynamic = "force-dynamic";

export default async function SyncedDataPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    kind?: string;
    integration?: string;
    page?: string;
  }>;
}) {
  bootstrap();

  const { tab, kind, integration, page: rawPage } = await searchParams;
  const showContacts = tab === "contacts";
  const showAccounts = tab === "accounts";
  const showEmail = tab === "email";
  const showSlack = tab === "slack";

  // An unrecognised kind is "All", not an error: this is a read-only filter and
  // a stale bookmark should still render the tab.
  const slackKind =
    showSlack && isSlackConversationKind(kind) ? kind : undefined;

  const userId = await currentUserId();
  const { scope, unresolved } = await resolveIntegrationScope(
    integration,
    userId
  );
  const integrationId = scope?.integrationId;
  const page = parsePage(rawPage);

  // The tab label counts every conversation; the pager needs the count the
  // active kind filter produces, or "Showing 1–2 of 40" would describe rows the
  // table never fetched.
  const [
    { customers, contacts, totals },
    emailTotal,
    slackTotal,
    slackPageTotal,
    emailMessages,
    slackConversations,
  ] = await Promise.all([
    loadSyncedData(userId, { integrationId, page }),
    countEmailMessagesForUser(userId, integrationId),
    countSlackConversationsForUser(userId, { integrationId }),
    showSlack
      ? countSlackConversationsForUser(userId, {
          integrationId,
          kind: slackKind,
        })
      : Promise.resolve(0),
    showEmail
      ? loadEmailMessagesForUser(userId, { integrationId, page })
      : Promise.resolve([]),
    showSlack
      ? loadSlackConversationsForUser(userId, slackKind, {
          integrationId,
          page,
        })
      : Promise.resolve([]),
  ]);

  // Only for the tab that renders them. The accounts read pulls members and
  // keys for every account, which is a lot of rows to fetch for a page showing
  // the customer table.
  const [accounts, assertions, runs] = showAccounts
    ? await Promise.all([
        loadCustomerAccounts(userId, { integrationId, page }),
        loadAssertionsForDisplay(userId),
        listResolutionRuns(userId, 1),
      ])
    : [[], [], []];

  // The issues of the most recent pass are the current ones by construction:
  // resolution recomputes every account, key and field from scratch, so
  // anything it did not report again has been settled.
  const latestRun = runs[0];

  // The active tab decides what "page N" means. Redirecting before render
  // keeps the URL truthful rather than showing an empty table under a page
  // number that cannot exist.
  const activeTotal = showEmail
    ? emailTotal
    : showSlack
      ? slackPageTotal
      : showAccounts
        ? totals.accounts
        : showContacts
          ? totals.contacts
          : totals.customers;
  const activeTab = showEmail
    ? "email"
    : showSlack
      ? "slack"
      : showAccounts
        ? "accounts"
        : showContacts
          ? "contacts"
          : undefined;

  if (page > pageCount(activeTotal)) {
    redirect(
      buildDataHref("/customers", {
        tab: activeTab,
        integration,
        page: pageCount(activeTotal),
        kind: showSlack ? slackKind : undefined,
      })
    );
  }

  const empty =
    totals.customers === 0 &&
    totals.contacts === 0 &&
    emailTotal === 0 &&
    slackTotal === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Synced data</h1>
        <p className="mt-1 text-slate-600">
          Records written by your integrations, after field mapping.
        </p>
      </div>

      {scope !== null && (
        <ScopeBanner
          label={scope.label}
          clearHref={buildDataHref("/customers", { tab: activeTab })}
          // The Accounts tab is a cross-source merge. Saying "only this
          // connection" there would be a promise the account card cannot keep:
          // every field and member it shows is merged from all sources.
          note={
            showAccounts
              ? "Accounts combine records from every source. Each account below contains at least one record from this connection; its fields and members may still come from other connections."
              : undefined
          }
        />
      )}
      {unresolved && <UnresolvedScopeNotice />}

      {empty ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          {scope !== null ? (
            <>
              <p className="text-slate-600">
                Nothing synced from {scope.label} yet.
              </p>
              <Link
                href={`/integrations/${scope.integrationId}`}
                className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Back to connection
              </Link>
            </>
          ) : (
            <>
              <p className="text-slate-600">Nothing synced yet.</p>
              <Link
                href="/integrations"
                className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Go to integrations
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-slate-200">
            {/*
              Every tab link is built through `buildDataHref` so the connection
              filter survives a tab switch. A hand-written `?tab=…` here would
              silently show every source while the banner still claimed one.
            */}
            <Tab
              href={buildDataHref("/customers", { integration })}
              active={!showContacts && !showAccounts && !showEmail && !showSlack}
            >
              Customers ({totals.customers})
            </Tab>
            <Tab
              href={buildDataHref("/customers", {
                tab: "contacts",
                integration,
              })}
              active={showContacts}
            >
              Contacts ({totals.contacts})
            </Tab>
            {/*
              Listed last but it is the answer the other two raise: the same
              company appears once per integration in Customers, and this is
              where those rows become one company.
            */}
            <Tab
              href={buildDataHref("/customers", {
                tab: "accounts",
                integration,
              })}
              active={showAccounts}
            >
              Accounts ({totals.accounts})
            </Tab>
            <Tab
              href={buildDataHref("/customers", {
                tab: "email",
                integration,
              })}
              active={showEmail}
            >
              Email messages ({emailTotal})
            </Tab>
            <Tab
              href={buildDataHref("/customers", {
                tab: "slack",
                integration,
              })}
              active={showSlack}
            >
              Slack conversations ({slackTotal})
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

          {showEmail ? (
            <EmailMessageTable rows={emailMessages} />
          ) : showSlack ? (
            <SlackConversationTable
              rows={slackConversations}
              kind={slackKind}
              integration={integration}
            />
          ) : showAccounts ? (
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
              scopeLabel={scope?.label}
              focusIntegrationId={scope?.integrationId}
            />
          ) : showContacts ? (
            <ContactTable rows={contacts} />
          ) : (
            <CustomerTable rows={customers} />
          )}

          <Pager
            page={page}
            total={activeTotal}
            path="/customers"
            params={{
              tab: activeTab,
              integration,
              kind: showSlack ? slackKind : undefined,
            }}
          />
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

function EmailMessageTable({ rows }: { rows: EmailMessageListRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <Th>From</Th>
            <Th>Subject</Th>
            <Th>To</Th>
            <Th>Sent</Th>
            <Th>Direction</Th>
            <Th>Primary party</Th>
            <Th>Snippet</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="font-medium text-slate-900">
                <Link
                  href={`/customers/messages/email/${row.id}`}
                  className="hover:underline"
                >
                  {row.fromName ?? row.fromEmail ?? "(unknown sender)"}
                </Link>
              </Td>
              <Td>
                <Link
                  href={`/customers/messages/email/${row.id}`}
                  className="hover:underline"
                >
                  {row.subject ?? <Empty />}
                </Link>
              </Td>
              <Td className="max-w-xs truncate text-slate-600">
                {row.toEmails.length === 0 ? <Empty /> : row.toEmails.join(", ")}
              </Td>
              <Td>{row.sentAt.toLocaleString()}</Td>
              <Td>{row.direction}</Td>
              <Td>{row.primaryLabel}</Td>
              <Td className="max-w-md truncate text-slate-600">
                {row.snippet ?? <Empty />}
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

function SlackConversationTable({
  rows,
  kind,
  integration,
}: {
  rows: SlackConversationListRow[];
  kind?: SlackConversationListRow["conversationKind"];
  /** Kept in the kind links so the connection filter survives a chip click. */
  integration?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {SLACK_CONVERSATION_KIND_FILTERS.map((filter) => {
          const active = filter.kind === kind;
          const href = buildDataHref("/customers", {
            tab: "slack",
            integration,
            kind: filter.kind,
          });
          return (
            <Link
              key={filter.key}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs ${
                active
                  ? "border-slate-900 bg-slate-900 font-medium text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:text-slate-900"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <Th>Conversation</Th>
              <Th>Kind</Th>
              <Th>Customer</Th>
              <Th>Members</Th>
              <Th>Messages</Th>
              <Th>Last message</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.mappingId}>
                <Td className="font-medium text-slate-900">
                  <Link
                    href={`/customers/slack/${row.mappingId}`}
                    className="hover:underline"
                  >
                    {row.label}
                  </Link>
                  <p className="font-mono text-xs font-normal text-slate-400">
                    {row.conversationId}
                  </p>
                </Td>
                <Td>{SLACK_CONVERSATION_KIND_LABELS[row.conversationKind].singular}</Td>
                <Td>{row.customerName}</Td>
                <Td>{row.memberCount}</Td>
                <Td>{row.messageCount}</Td>
                <Td className="max-w-md text-slate-600">
                  {row.latestMessage === null ? (
                    <span className="text-slate-400">No messages</span>
                  ) : (
                    <>
                      <span className="font-medium text-slate-800">
                        {row.latestMessage.authorName ?? row.latestMessage.authorId}
                      </span>
                      <span className="ml-2 text-xs text-slate-400">
                        {row.latestMessage.sentAt.toLocaleString()}
                      </span>
                      <p className="truncate">
                        {row.latestMessage.snippet ?? <Empty />}
                      </p>
                    </>
                  )}
                </Td>
                <Td className="text-xs text-slate-400">{row.integrationLabel}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
