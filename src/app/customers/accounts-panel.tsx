"use client";

/**
 * The Accounts tab: what identity resolution decided, and how to correct it.
 *
 * A grouping the user cannot inspect is one they cannot trust, so every account
 * carries its own explanation — a provider chip on each resolved field saying
 * which connection supplied it, and the keys the grouping was actually made on.
 * Traceability is a stated requirement, and it is also the only way the two
 * correction actions make sense: "not the same company" is unanswerable unless
 * you can see why the matcher thought otherwise.
 *
 * ## The two actions send a list of pairs, not one pair
 *
 * Both post to `/api/identity/assertions` with every pair the sentence implies,
 * because one pair does not produce the outcome the button promises — the route
 * header sets out why in full. In short: an account with a member outside the
 * asserted cluster is still a rival for its keys, so a single `same` pair moves
 * one straggler instead of merging, and a single `distinct` pair leaves the
 * remaining members holding the record in place.
 *
 * ## Why the pass is triggered here rather than by the writes
 *
 * Assertions and priorities are recorded without resolving. This component runs
 * the pass once, after the write, because a user correcting three accounts in a
 * row would otherwise pay for three whole-tenant scans of which only the last
 * one's answer survives.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IdentityIssue } from "@/core/types/common";

export interface AccountView {
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  /** ISO, because a Date does not survive the server-to-client boundary. */
  createDate: string | null;
  type: string | null;
  customFields: Record<string, string>;
  fieldProvenance: Record<string, string>;
  members: Array<{
    id: string;
    externalSourceId: string;
    name: string;
    integrationId: string;
    integrationLabel: string;
    providerName: string;
  }>;
  keys: Array<{ kind: string; rawValue: string; source: string }>;
}

export interface AssertionView {
  id: string;
  kind: "same" | "distinct";
  note: string | null;
  left: { id: string; name: string; integrationLabel: string };
  right: { id: string; name: string; integrationLabel: string };
}

export function AccountsPanel({
  accounts,
  issues,
  assertions,
  lastRunAt,
}: {
  accounts: AccountView[];
  issues: IdentityIssue[];
  assertions: AssertionView[];
  lastRunAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({});

  /**
   * Run the request, then the pass, then refresh.
   *
   * The pass is what makes the change visible — the write only records the
   * user's verdict, and every account on this page is recomputed from scratch
   * by resolution. Refreshing without it would show the same page back.
   */
  async function act(request: () => Promise<Response>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? "That did not work");
        return;
      }
      await fetch("/api/identity/resolve", { method: "POST" });
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  function assert(
    kind: "same" | "distinct",
    customerId: string,
    otherCustomerIds: string[]
  ): void {
    void act(() =>
      fetch("/api/identity/assertions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, customerId, otherCustomerIds }),
      })
    );
  }

  const conflicts = issues.filter(
    (issue) => issue.kind === "key_claimed_elsewhere"
  );
  const fieldConflicts = issues.filter((issue) => issue.kind === "field_conflict");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {accounts.length} account{accounts.length === 1 ? "" : "s"} resolved
          from your synced customers
          {lastRunAt === null ? "" : ` · last run ${lastRunAt}`}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => fetch("/api/identity/resolve", { method: "POST" }))}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "Working…" : "Re-run resolution"}
        </button>
      </div>

      {error !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}

      {/*
        Two accounts claim one address, and the matcher will not guess. Shown
        rather than silently resolved: a false merge is the worst failure this
        feature has, and it has no automatic undo.
      */}
      {conflicts.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">
            {conflicts.length} match{conflicts.length === 1 ? "" : "es"} needs a
            decision
          </p>
          <ul className="mt-2 space-y-1">
            {conflicts.map((issue, index) => (
              <li key={index}>{issue.reason}</li>
            ))}
          </ul>
          <p className="mt-2">
            Use “Same company as…” below to join them, or leave them apart.
          </p>
        </div>
      )}

      {/*
        Priority defaults to 100 everywhere, so most ties are accidental rather
        than a preference anyone expressed. Saying which field and which sources
        turns a silent coin-flip into a prompt.
      */}
      {fieldConflicts.length > 0 && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <p className="font-medium">
            {fieldConflicts.length} field
            {fieldConflicts.length === 1 ? "" : "s"} resolved by a tie-break
          </p>
          <ul className="mt-2 space-y-1">
            {fieldConflicts.map((issue, index) => (
              <li key={index}>{issue.reason}</li>
            ))}
          </ul>
          <p className="mt-2">
            Equal-ranked sources disagree. Set a source priority on the
            integration to say which one you trust for these.
          </p>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-600">
          <p>No accounts yet. Sync an integration, then run resolution.</p>
        </div>
      ) : (
        accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            others={accounts.filter((other) => other.id !== account.id)}
            busy={busy}
            mergeTarget={mergeInto[account.id] ?? ""}
            onMergeTargetChange={(value) => {
              setMergeInto((current) => ({ ...current, [account.id]: value }));
            }}
            onAssert={assert}
          />
        ))
      )}

      {assertions.length > 0 && (
        <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Your identity decisions
          </h3>
          {/*
            Listed so the undo is reachable. Nothing else on this page reveals
            that an assertion is in play — a `same` group looks exactly like a
            successful match — and the resolver will never revise one on its own.
          */}
          <ul className="divide-y divide-slate-100 text-sm">
            {assertions.map((assertion) => (
              <li
                key={assertion.id}
                className="flex items-start justify-between gap-4 py-2"
              >
                <span>
                  <span
                    className={
                      assertion.kind === "same"
                        ? "font-medium text-emerald-700"
                        : "font-medium text-rose-700"
                    }
                  >
                    {assertion.kind === "same" ? "Same:" : "Not the same:"}
                  </span>{" "}
                  {assertion.left.name}{" "}
                  <span className="text-slate-400">
                    ({assertion.left.integrationLabel})
                  </span>{" "}
                  ↔ {assertion.right.name}{" "}
                  <span className="text-slate-400">
                    ({assertion.right.integrationLabel})
                  </span>
                  {assertion.note !== null && (
                    <span className="block text-xs text-slate-500">
                      {assertion.note}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      fetch(`/api/identity/assertions?id=${assertion.id}`, {
                        method: "DELETE",
                      })
                    )
                  }
                  className="shrink-0 text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800 disabled:opacity-50"
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AccountCard({
  account,
  others,
  busy,
  mergeTarget,
  onMergeTargetChange,
  onAssert,
}: {
  account: AccountView;
  others: AccountView[];
  busy: boolean;
  mergeTarget: string;
  onMergeTargetChange: (value: string) => void;
  onAssert: (
    kind: "same" | "distinct",
    customerId: string,
    otherCustomerIds: string[]
  ) => void;
}) {
  // Provenance names an integration id, and every winning value came from a
  // member, so the members are a complete lookup for it.
  const sourceOf = (field: string): string | undefined => {
    const integrationId = account.fieldProvenance[field];
    if (integrationId === undefined) return undefined;
    return account.members.find(
      (member) => member.integrationId === integrationId
    )?.integrationLabel;
  };

  const anchor = account.members[0];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">{account.name}</h3>
        <span className="text-xs text-slate-400">
          {account.members.length} source
          {account.members.length === 1 ? "" : "s"}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Domain" value={account.domain} source={sourceOf("domain")} />
        <Field label="Email" value={account.email} source={sourceOf("email")} />
        <Field
          label="Industry"
          value={account.industry}
          source={sourceOf("industry")}
        />
        <Field label="Type" value={account.type} source={sourceOf("type")} />
        <Field
          label="Created"
          value={
            account.createDate === null
              ? null
              : new Date(account.createDate).toLocaleDateString()
          }
          source={sourceOf("createDate")}
        />
        <Field label="Name from" value={account.name} source={sourceOf("name")} />
      </dl>

      {account.keys.length > 0 && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Matched on
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {account.keys.map((key) => (
              <span
                key={`${key.kind}:${key.rawValue}`}
                title={`${key.kind} · ${key.source.replace(/_/g, " ")}`}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
              >
                {key.rawValue}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">Records</p>
        <ul className="mt-1 space-y-1 text-sm">
          {account.members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-3">
              <span>
                {member.name}{" "}
                <span className="text-xs text-slate-400">
                  {member.integrationLabel}
                  <span className="ml-1 font-mono">#{member.externalSourceId}</span>
                </span>
              </span>
              {/*
                Only offered when there is something to separate from. Splitting
                a lone record off its own account means nothing, and the button
                would suggest otherwise.
              */}
              {account.members.length > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onAssert(
                      "distinct",
                      member.id,
                      account.members
                        .filter((other) => other.id !== member.id)
                        .map((other) => other.id)
                    );
                  }}
                  className="shrink-0 text-xs text-rose-600 underline underline-offset-2 hover:text-rose-800 disabled:opacity-50"
                >
                  Not this company
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {anchor !== undefined && others.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <label
            htmlFor={`merge-${account.id}`}
            className="text-xs uppercase tracking-wide text-slate-400"
          >
            Same company as…
          </label>
          <select
            id={`merge-${account.id}`}
            value={mergeTarget}
            onChange={(event) => {
              onMergeTargetChange(event.target.value);
            }}
            className="min-w-0 max-w-xs rounded-lg border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Choose an account</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || mergeTarget === ""}
            onClick={() => {
              const other = others.find((candidate) => candidate.id === mergeTarget);
              if (other === undefined) return;
              // Every member of the other account, against this account's
              // anchor. One pair would leave that account holding members
              // outside the cluster, and it would contest rather than merge.
              onAssert(
                "same",
                anchor.id,
                other.members.map((member) => member.id)
              );
            }}
            className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Join
          </button>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  source,
}: {
  label: string;
  value: string | null;
  source: string | undefined;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-1.5 text-sm text-slate-800">
        {value ?? <span className="text-slate-300">—</span>}
        {/*
          The chip appears only when a value did. Provenance for an empty field
          would name the source that supplied nothing, which is the one thing
          survivorship guarantees never happened — a null is not an opinion, so
          no member ever "wins" a field by leaving it blank.
        */}
        {value !== null && source !== undefined && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
            {source}
          </span>
        )}
      </dd>
    </div>
  );
}
