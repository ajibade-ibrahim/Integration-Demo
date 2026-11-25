"use client";

/**
 * Map Slack conversations to customers.
 *
 * Mapped conversations that are no longer eligible are kept in the list rather
 * than dropped. Slack omits archived, unshared or re-keyed conversations from
 * its list silently, so dropping them here would leave a mapping the user could
 * never remove. They are shown as unavailable with the remove action intact.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ConversationRow {
  conversationId: string;
  conversationKind: string;
  label: string;
  customerId: string;
  customerName: string;
  available: boolean;
  isPrivate?: boolean;
  isMember?: boolean;
  memberCount?: number;
}

interface CustomerChoice {
  id: string;
  name: string;
  integrationLabel: string;
}

const KIND_LABELS: Record<string, string> = {
  shared_channel: "Shared channel",
  connect_dm: "Connect DM",
  group_dm: "Group DM",
};

export function ConversationMapper({
  integrationId,
  rows: initialRows,
  customers,
  disabled,
}: {
  integrationId: string;
  rows: ConversationRow[];
  customers: CustomerChoice[];
  disabled: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState<Record<string, string>>(
    Object.fromEntries(initialRows.map((row) => [row.conversationId, row.customerId]))
  );
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  function markBusy(conversationId: string, value: boolean): void {
    setBusy((current) => ({ ...current, [conversationId]: value }));
  }

  function setError(conversationId: string, message: string | undefined): void {
    setErrors((current) => ({ ...current, [conversationId]: message }));
  }

  async function save(row: ConversationRow): Promise<void> {
    const customerId = selected[row.conversationId] ?? "";
    if (customerId === "") {
      setError(row.conversationId, "Choose a customer first.");
      return;
    }

    markBusy(row.conversationId, true);
    setError(row.conversationId, undefined);

    try {
      const response = await fetch(
        `/api/integrations/${integrationId}/conversations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: row.conversationId,
            customerId,
          }),
        }
      );
      const body = (await response.json()) as {
        error?: string;
        reconnect?: boolean;
      };

      if (!response.ok) {
        setError(
          row.conversationId,
          body.reconnect === true
            ? "Slack needs to be reconnected before mappings can be saved."
            : body.error ?? "Could not save the mapping."
        );
        return;
      }

      const customer = customers.find((option) => option.id === customerId);
      setRows((current) =>
        current.map((entry) =>
          entry.conversationId === row.conversationId
            ? {
                ...entry,
                customerId,
                customerName: customer?.name ?? "",
              }
            : entry
        )
      );
      router.refresh();
    } catch {
      setError(row.conversationId, "Could not reach the server.");
    } finally {
      markBusy(row.conversationId, false);
    }
  }

  async function remove(row: ConversationRow): Promise<void> {
    markBusy(row.conversationId, true);
    setError(row.conversationId, undefined);

    try {
      const response = await fetch(
        `/api/integrations/${integrationId}/conversations?conversationId=${encodeURIComponent(
          row.conversationId
        )}`,
        { method: "DELETE" }
      );
      const body = (await response.json()) as {
        error?: string;
        reconnect?: boolean;
      };

      if (!response.ok) {
        setError(
          row.conversationId,
          body.reconnect === true
            ? "Slack needs to be reconnected before mappings can be removed."
            : body.error ?? "Could not remove the mapping."
        );
        return;
      }

      setRows((current) =>
        current.filter((entry) => entry.conversationId !== row.conversationId)
      );
      router.refresh();
    } catch {
      setError(row.conversationId, "Could not reach the server.");
    } finally {
      markBusy(row.conversationId, false);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        No eligible Slack conversations were found. A shared channel, an external
        DM, or a group DM with an external person is required. Private shared
        channels the authorizing user is not in are not offered.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-semibold">Conversation</th>
            <th className="px-4 py-3 font-semibold">Kind</th>
            <th className="px-4 py-3 font-semibold">Access</th>
            <th className="px-4 py-3 font-semibold">Customer</th>
            <th className="px-4 py-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const isBusy = busy[row.conversationId] === true;
            const hasMapping = row.customerId !== "";
            const choice = selected[row.conversationId] ?? "";

            return (
              <tr key={row.conversationId} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{row.label}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                    {row.conversationId}
                  </p>
                  {errors[row.conversationId] !== undefined && (
                    <p className="mt-2 text-xs text-red-700">
                      {errors[row.conversationId]}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {KIND_LABELS[row.conversationKind] ?? row.conversationKind}
                </td>
                <td className="px-4 py-3">
                  {row.available ? (
                    <div className="space-y-1">
                      <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                        {row.isMember === false ? "not a member" : "member"}
                      </span>
                      {row.isPrivate === true && (
                        <span className="ml-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                          private
                        </span>
                      )}
                      {row.memberCount !== undefined && (
                        <p className="text-xs text-slate-500">
                          {row.memberCount} members
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      unavailable — archived, unshared, or id changed
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.available ? (
                    <select
                      value={choice}
                      disabled={disabled || isBusy}
                      onChange={(event) => {
                        setSelected((current) => ({
                          ...current,
                          [row.conversationId]: event.target.value,
                        }));
                      }}
                      className="w-full min-w-[16rem] rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
                    >
                      <option value="">Choose a customer…</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name} — {customer.integrationLabel}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-slate-700">
                      {row.customerName === "" ? "—" : row.customerName}
                    </p>
                  )}
                  {hasMapping && row.customerName !== "" && (
                    <p className="mt-1 text-xs text-slate-500">
                      Currently {row.customerName}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {row.available && (
                      <button
                        type="button"
                        disabled={disabled || isBusy || choice === "" || choice === row.customerId}
                        onClick={() => void save(row)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {hasMapping ? "Update" : "Map"}
                      </button>
                    )}
                    {hasMapping && (
                      <button
                        type="button"
                        // Removal is local (mapping + messages) and does not
                        // call Slack, so it stays available while reconnecting.
                        disabled={isBusy}
                        onClick={() => void remove(row)}
                        className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
