"use client";

/**
 * Sync trigger and run history.
 *
 * The trigger returns 202 and the sync continues server-side, so this polls the
 * runs endpoint while anything is `running`. Polling stops as soon as nothing
 * is in flight — a demo page that keeps hitting the server after the work is
 * done is its own kind of bug.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Issue {
  sourceRecordId: string;
  targetObject: string;
  reason: string;
  fieldName?: string;
  severity: "warning" | "rejected";
}

interface Run {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  completedAt: string | null;
  /** Rows written per target object; absent keys were not synced at all. */
  recordCounts: Record<string, number>;
  attempt: number;
  issues: Issue[];
}

/** Plural form for the object names a run can report. */
const OBJECT_LABELS: Record<string, [singular: string, plural: string]> = {
  customer: ["customer", "customers"],
  contact: ["contact", "contacts"],
  product: ["product", "products"],
  offering: ["offering", "offerings"],
};

/**
 * "12 customers, 30 contacts" — or "no records" when a run wrote nothing.
 *
 * Reads whatever keys the run recorded rather than a fixed pair, so a catalog
 * sync reports products and offerings instead of claiming zero customers. An
 * unknown key still renders, under its own name: a run that recorded something
 * this build does not know about is worth showing, not hiding.
 */
function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([object, n]) => {
      const [singular, plural] = OBJECT_LABELS[object] ?? [object, `${object}s`];
      return `${n} ${n === 1 ? singular : plural}`;
    });

  return parts.length === 0 ? "no records" : parts.join(", ");
}

const RUN_STATUS: Record<string, string> = {
  running: "bg-blue-100 text-blue-800",
  success: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  discarded: "bg-slate-100 text-slate-600",
};

export function SyncPanel({
  integrationId,
  canSync,
  initialRuns,
}: {
  integrationId: string;
  canSync: boolean;
  initialRuns: Run[];
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>(initialRuns);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyRunning = runs.some((run) => run.status === "running");

  const load = useCallback(async (): Promise<boolean> => {
    const response = await fetch(`/api/integrations/${integrationId}/runs`);
    if (!response.ok) return false;

    const body = (await response.json()) as { runs: Run[] };
    setRuns(body.runs);
    return body.runs.some((run) => run.status === "running");
  }, [integrationId]);

  useEffect(() => {
    if (!anyRunning) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void load().then((stillRunning) => {
        // Refresh the server components once the run settles, so the
        // last-synced timestamp above this panel stops being stale.
        if (!stillRunning && !cancelled) router.refresh();
      });
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [anyRunning, load, router]);

  async function startSync(): Promise<void> {
    setStarting(true);
    setError(null);

    try {
      const response = await fetch(`/api/integrations/${integrationId}/sync`, {
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not start the sync");
        return;
      }
      await load();
    } catch {
      setError("Could not reach the server");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Sync
        </h2>
        <button
          type="button"
          onClick={() => void startSync()}
          disabled={!canSync || starting || anyRunning}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          {anyRunning ? "Syncing…" : starting ? "Starting…" : "Sync now"}
        </button>
      </div>

      {error !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-slate-200 bg-white">
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            No syncs yet.{" "}
            {canSync
              ? "Run one to pull records from the provider."
              : "Connect the integration first."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RunRow({ run }: { run: Run }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${RUN_STATUS[run.status] ?? RUN_STATUS["discarded"]}`}
          >
            {run.status}
          </span>
          <span className="text-sm text-slate-700">{summarizeCounts(run.recordCounts)}</span>
          {run.attempt > 1 && (
            <span className="text-xs text-slate-400">
              after {run.attempt} attempts
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">
            {new Date(run.startedAt).toLocaleString()} · {run.trigger}
          </span>
          {run.issues.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setExpanded((value) => !value);
              }}
              className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              {run.issues.length} issue{run.issues.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>

      {/*
        Per-record issues are surfaced rather than only logged. A run that wrote
        19 of 20 records is a success with a caveat, and the caveat is the part
        the user needs in order to fix their data.
      */}
      {expanded && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
          {run.issues.map((issue, index) => (
            <li key={index} className="flex gap-2 text-xs">
              <span
                className={
                  issue.severity === "rejected"
                    ? "font-medium text-red-700"
                    : "font-medium text-amber-700"
                }
              >
                {issue.severity}
              </span>
              <span className="font-mono text-slate-500">
                {issue.targetObject} {issue.sourceRecordId}
              </span>
              <span className="text-slate-600">{issue.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
