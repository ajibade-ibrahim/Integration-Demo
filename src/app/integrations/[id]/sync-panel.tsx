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

interface CoverageObject {
  object: string;
  mapped: boolean;
  yielded: boolean;
  pages: number;
  recordsRead: number;
  recordsWritten: number;
  complete: boolean | null;
  warnings: number;
  rejected: number;
  atPageLimit: boolean;
}

interface CoverageFunction {
  functionName: string;
  objects: CoverageObject[];
  omittedObjects: string[];
  unmappedObjects: string[];
  pages: number;
  recordsRead: number;
  recordsWritten: number;
  warnings: number;
  rejected: number;
  error?: string;
}

interface Coverage {
  functions: CoverageFunction[];
  error?: string;
}

interface Run {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  completedAt: string | null;
  /** Rows written per target object; absent keys were not synced at all. */
  recordCounts: Record<string, number>;
  /** Mapping content version per function; empty on runs recorded before it. */
  mappingVersions: Record<string, string>;
  /** What was acquired, separately from what was written. */
  coverage: Coverage;
  attempt: number;
  issues: Issue[];
}

/** Plural form for the object names a run can report. */
const OBJECT_LABELS: Record<string, [singular: string, plural: string]> = {
  customer: ["customer", "customers"],
  contact: ["contact", "contacts"],
  product: ["product", "products"],
  offering: ["offering", "offerings"],
  price: ["price", "prices"],
  feature: ["feature", "features"],
  entitlement: ["entitlement", "entitlements"],
  agreement: ["agreement", "agreements"],
  subscription: ["subscription", "subscriptions"],
  // Spelled out because the fallback below would pluralize the union member
  // itself and lose the space, reporting "8 agreementItems" — visibly wrong on
  // the screen a user reads to check the sync.
  agreementItem: ["line item", "line items"],
  agreementEntitlement: ["agreement entitlement", "agreement entitlements"],
  agreementDiscount: ["agreement discount", "agreement discounts"],
  invoice: ["invoice", "invoices"],
  invoiceLine: ["invoice line", "invoice lines"],
  payment: ["payment", "payments"],
};

const FUNCTION_LABELS: Record<string, string> = {
  identity: "Identity",
  catalog: "Catalog",
  agreement: "Agreement",
  support: "Support",
  billing: "Billing",
  usage: "Usage",
  communication: "Communication",
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
  abandoned: "bg-orange-100 text-orange-800",
};

type CoverageTone = "ok" | "warn" | "muted";

const COVERAGE_TONE: Record<CoverageTone, string> = {
  ok: "text-emerald-700",
  warn: "text-amber-700",
  muted: "text-slate-500",
};

/**
 * One line that prevents a green write status from implying complete coverage.
 *
 * The counts answer "did rows land?"; this answers "did we see the whole list?"
 * Those are different questions, and a page-capped or undeclared acquisition
 * must not look like a complete sync merely because the writes succeeded.
 */
function summarizeCoverage(
  coverage: Coverage
): { text: string; tone: CoverageTone } | null {
  if (coverage.functions.length === 0) return null;

  const entries = coverage.functions.flatMap((fn) =>
    fn.objects.filter((object) => object.mapped)
  );
  const complete = entries.filter((object) => object.complete === true).length;
  const incomplete = entries.filter((object) => object.complete === false).length;
  const unverified = entries.filter(
    (object) => object.yielded && object.complete === null
  ).length;
  const atPageLimit = entries.filter((object) => object.atPageLimit).length;
  const omitted = coverage.functions.reduce(
    (total, fn) => total + fn.omittedObjects.length,
    0
  );
  const unmapped = coverage.functions.reduce(
    (total, fn) => total + fn.unmappedObjects.length,
    0
  );
  const failed = coverage.functions.filter((fn) => fn.error !== undefined).length;
  const warnings = coverage.functions.reduce(
    (total, fn) => total + fn.warnings,
    0
  );
  const rejected = coverage.functions.reduce(
    (total, fn) => total + fn.rejected,
    0
  );

  const parts = [
    `${entries.length} object${entries.length === 1 ? "" : "s"}`,
  ];
  if (complete > 0) parts.push(`${complete} complete`);
  if (incomplete > 0) parts.push(`${incomplete} incomplete`);
  if (unverified > 0) parts.push(`${unverified} unverified`);
  if (atPageLimit > 0) parts.push(`${atPageLimit} at page limit`);
  if (omitted > 0) parts.push(`${omitted} not yielded`);
  if (unmapped > 0) parts.push(`${unmapped} unmapped`);
  if (warnings > 0) {
    parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  }
  if (rejected > 0) {
    parts.push(`${rejected} rejected`);
  }
  if (failed > 0) parts.push(`${failed} failed`);

  const tone: CoverageTone =
    incomplete > 0 ||
    atPageLimit > 0 ||
    failed > 0 ||
    warnings > 0 ||
    rejected > 0
      ? "warn"
      : unverified > 0 || omitted > 0 || unmapped > 0
        ? "muted"
        : "ok";

  return { text: `Coverage: ${parts.join(" · ")}`, tone };
}

function objectLabel(object: string): string {
  return OBJECT_LABELS[object]?.[0] ?? object;
}

function completenessLabel(complete: boolean | null): string {
  return complete === true
    ? "complete"
    : complete === false
      ? "incomplete"
      : "not declared";
}

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

      <p className="text-xs text-slate-500">
        A successful run means rows were written. Coverage below records what
        was acquired and whether the handler declared the list complete.
      </p>

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
  const coverageSummary = summarizeCoverage(run.coverage);
  const hasDetails =
    run.issues.length > 0 || run.coverage.functions.length > 0;

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
          {hasDetails && (
            <button
              type="button"
              onClick={() => {
                setExpanded((value) => !value);
              }}
              className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              {expanded ? "Hide details" : "Details"}
            </button>
          )}
        </div>
      </div>

      {/* Writes succeeding is not the same claim as acquisition being whole. */}
      {coverageSummary !== null && (
        <p className={`mt-1 text-xs ${COVERAGE_TONE[coverageSummary.tone]}`}>
          {coverageSummary.text}
        </p>
      )}
      {run.coverage.error !== undefined && (
        <p className="mt-1 text-xs font-medium text-red-700">
          {run.status === "abandoned" ? "Run abandoned" : "Run failed"}:{" "}
          {run.coverage.error}
        </p>
      )}

      {/*
        Per-record issues and per-object coverage are surfaced rather than only
        logged. A run that wrote 19 of 20 records is a success with a caveat,
        and the caveat is the part the user needs in order to fix their data.
      */}
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          {run.issues.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Issues
              </p>
              <ul className="mt-1 space-y-1">
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
            </div>
          )}

          {run.coverage.functions.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Coverage
                {run.completedAt !== null && (
                  <span className="ml-2 font-normal normal-case text-slate-400">
                    as of {new Date(run.completedAt).toLocaleString()}
                  </span>
                )}
              </p>
              <div className="mt-2 space-y-3">
                {run.coverage.functions.map((fn) => (
                  <div key={fn.functionName}>
                    <p className="text-xs font-medium text-slate-700">
                      {FUNCTION_LABELS[fn.functionName] ?? fn.functionName}
                    </p>
                    {run.mappingVersions[fn.functionName] !== undefined && (
                      <p className="mt-0.5 text-xs text-slate-400">
                        Mapping{" "}
                        <code
                          className="font-mono"
                          title={run.mappingVersions[fn.functionName]}
                        >
                          {run.mappingVersions[fn.functionName]?.slice(0, 15)}…
                        </code>
                      </p>
                    )}
                    {fn.error !== undefined && (
                      <p className="mt-1 text-xs text-red-700">{fn.error}</p>
                    )}
                    <ul className="mt-1 space-y-1">
                      {fn.objects
                        .filter((object) => object.mapped || object.yielded)
                        .map((object) => (
                          <li
                            key={object.object}
                            className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500"
                          >
                            <span className="font-mono text-slate-700">
                              {objectLabel(object.object)}
                            </span>
                            <span>
                              {object.pages} page{object.pages === 1 ? "" : "s"} ·{" "}
                              {object.recordsRead} read ·{" "}
                              {object.recordsWritten} written
                            </span>
                            <span
                              className={
                                object.complete === false
                                  ? "font-medium text-amber-700"
                                  : object.complete === true
                                    ? "font-medium text-emerald-700"
                                    : "text-slate-400"
                              }
                            >
                              {completenessLabel(object.complete)}
                            </span>
                            {object.atPageLimit && (
                              <span className="font-medium text-amber-700">
                                page limit
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>
                    {fn.omittedObjects.length > 0 && (
                      <p className="mt-1 text-xs text-slate-400">
                        Not yielded:{" "}
                        {fn.omittedObjects.map(objectLabel).join(", ")}
                      </p>
                    )}
                    {fn.unmappedObjects.length > 0 && (
                      <p className="mt-1 text-xs text-slate-400">
                        Not mapped:{" "}
                        {fn.unmappedObjects.map(objectLabel).join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
