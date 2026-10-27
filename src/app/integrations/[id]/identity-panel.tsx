"use client";

/**
 * Identity settings for one integration: its survivorship rank, and a crosswalk.
 *
 * Both belong on the integration rather than on the Accounts tab, because both
 * are statements about *this connection* — how much its values are trusted, and
 * what its records are called elsewhere. The Accounts tab is where the
 * consequences show up, which is a different question from where they are set.
 *
 * ## The rank changes values, never grouping
 *
 * That separation is the safety property the whole design rests on, and the
 * copy says so plainly. Priority resolves "what is this company called"; it has
 * no part in "is this the same company". A control that quietly regrouped
 * someone's customer list when they nudged a number would be the worst kind of
 * surprise, so the guarantee is stated where the number is typed.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function IdentityPanel({
  integrationId,
  providerName,
  initialPriority,
  foreignProviders,
}: {
  integrationId: string;
  providerName: string;
  initialPriority: number;
  /** Every registered provider except this one, as `[name, label]`. */
  foreignProviders: Array<{ name: string; label: string }>;
}) {
  const router = useRouter();

  const [priority, setPriority] = useState(String(initialPriority));
  const [savingPriority, setSavingPriority] = useState(false);
  const [priorityNote, setPriorityNote] = useState<string | null>(null);

  const [foreignProvider, setForeignProvider] = useState(
    foreignProviders[0]?.name ?? ""
  );
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [withdrawNote, setWithdrawNote] = useState<string | null>(null);

  async function savePriority(): Promise<void> {
    setSavingPriority(true);
    setPriorityNote(null);
    try {
      const response = await fetch(`/api/integrations/${integrationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityPriority: Number(priority) }),
      });
      const body = (await response.json()) as {
        identityPriority?: number;
        error?: string;
      };
      if (!response.ok || body.identityPriority === undefined) {
        setPriorityNote(body.error ?? "Could not save");
        return;
      }

      // The server clamps to 1..1000, so echo back what it stored rather than
      // what was typed — otherwise the field shows a number the database does
      // not hold.
      setPriority(String(body.identityPriority));

      // Resolution has to re-run before the change is visible: every account's
      // fields are recomputed from its members, and nothing here touched an
      // account.
      await fetch("/api/identity/resolve", { method: "POST" });
      setPriorityNote("Saved, and accounts re-resolved.");
      router.refresh();
    } catch {
      setPriorityNote("Could not reach the server");
    } finally {
      setSavingPriority(false);
    }
  }

  async function importCrosswalk(): Promise<void> {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setWithdrawNote(null);
    try {
      const response = await fetch("/api/identity/crosswalk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId, foreignProvider, text }),
      });
      const body = (await response.json()) as ImportSummary & { error?: string };
      if (!response.ok) {
        setImportError(body.error ?? "Could not import that file");
        return;
      }
      setImportResult(body);
      await fetch("/api/identity/resolve", { method: "POST" });
      router.refresh();
    } catch {
      setImportError("Could not reach the server");
    } finally {
      setImporting(false);
    }
  }

  async function withdrawCrosswalk(): Promise<void> {
    setWithdrawing(true);
    setImportError(null);
    setWithdrawNote(null);
    try {
      const response = await fetch(
        `/api/identity/crosswalk?integrationId=${integrationId}&foreignProvider=${foreignProvider}`,
        { method: "DELETE" }
      );
      const body = (await response.json()) as {
        cleared?: number;
        retiredKeys?: number;
        reassessed?: boolean;
        error?: string;
      };
      if (!response.ok) {
        setImportError(body.error ?? "Could not withdraw those pairs");
        return;
      }

      setImportResult(null);
      const cleared = body.cleared ?? 0;
      const retired = body.retiredKeys ?? 0;
      const cleanup =
        body.reassessed === false
          ? "Account cleanup did not finish; the next sync or account refresh will retry."
          : "Accounts were re-resolved.";
      setWithdrawNote(
        cleared === 0 && retired === 0
          ? "There were no imported pairs left to forget."
          : cleared === 0
            ? `Retired ${retired} key${retired === 1 ? "" : "s"} left by those pairs. ${cleanup}`
            : `Forgot ${cleared} pair${cleared === 1 ? "" : "s"} and retired ${retired} key${retired === 1 ? "" : "s"}. ${cleanup}`
      );
      router.refresh();
    } catch {
      setImportError("Could not reach the server");
    } finally {
      setWithdrawing(false);
    }
  }

  async function readFile(file: File): Promise<void> {
    setText(await file.text());
  }

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Identity
      </h2>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label
          htmlFor="identity-priority"
          className="text-sm font-medium text-slate-900"
        >
          Source priority
        </label>
        <p className="mt-1 text-sm text-slate-600">
          When several connections describe the same company, the{" "}
          <strong>lowest</strong> number wins each field — but only for fields it
          actually supplies. A source that carries no industry never blanks
          someone else&apos;s.
        </p>
        <p className="mt-1 text-sm text-slate-600">
          This changes what an account <em>says</em>, never which records are in
          it. Grouping does not read this number at all.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            id="identity-priority"
            type="number"
            min={1}
            max={1000}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value);
            }}
            className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={savingPriority}
            onClick={() => void savePriority()}
            className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {savingPriority ? "Saving…" : "Save"}
          </button>
          <span className="text-xs text-slate-400">
            1–1000, default 100. Values outside the range are clamped.
          </span>
        </div>

        {priorityNote !== null && (
          <p className="mt-2 text-sm text-slate-600">{priorityNote}</p>
        )}
      </div>

      {foreignProviders.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-medium text-slate-900">Import a crosswalk</p>
          <p className="mt-1 text-sm text-slate-600">
            A list of <code className="text-xs">this system&apos;s id</code>,{" "}
            <code className="text-xs">the other system&apos;s id</code> — one
            pair per line. This is the strongest kind of match there is: it joins
            two records with no shared email or domain at all.
          </p>
          {/*
            Both ends are asked for rather than guessed. A bare `cus_...` looks
            like Stripe, but a wrong guess joins two unrelated companies using
            the strongest evidence the matcher has, which is the failure the
            whole design is built to avoid.
          */}
          <p className="mt-1 text-sm text-slate-600">
            Left column: ids from <strong>{providerName}</strong>, as this
            integration syncs them.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="foreign-provider" className="text-sm text-slate-700">
              Right column is
            </label>
            <select
              id="foreign-provider"
              value={foreignProvider}
              onChange={(event) => {
                setForeignProvider(event.target.value);
              }}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            >
              {foreignProviders.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            rows={5}
            spellCheck={false}
            placeholder={"ACME-001,cus_QxSample\nNORTHWIND-002,cus_QxOther"}
            className="mt-3 w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-xs"
          />

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/plain,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void readFile(file);
              }}
              className="text-xs text-slate-600"
            />
            <button
              type="button"
              disabled={
                importing ||
                withdrawing ||
                text.trim() === "" ||
                foreignProvider === ""
              }
              onClick={() => void importCrosswalk()}
              className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {importing ? "Importing…" : "Import"}
            </button>
            {/*
              The withdrawal is beside the import, not hidden. Nothing the
              resolver does will ever revise an imported pair, so a file pasted
              against the wrong connection keeps supplying the same wrong id on
              every pass until a human takes it back.

              What it does not do is split accounts the pairs already merged —
              the resolver joins on evidence and never separates on the absence
              of it, because a withdrawn file is not the same statement as
              "these are two companies". The title says so, and the Accounts tab
              carries the action that finishes the job.
            */}
            <button
              type="button"
              title="Stops these pairs being supplied. Accounts they already merged stay merged — use “Not this company” on the Accounts tab to separate them."
              disabled={importing || withdrawing || foreignProvider === ""}
              onClick={() => void withdrawCrosswalk()}
              className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800 disabled:opacity-50"
            >
              {withdrawing ? "Forgetting…" : "Forget imported pairs"}
            </button>
          </div>

          {importError !== null && (
            <p className="mt-2 text-sm text-red-700">{importError}</p>
          )}
          {withdrawNote !== null && (
            <p className="mt-2 text-sm text-slate-600">{withdrawNote}</p>
          )}
          {importResult !== null && <ImportReport result={importResult} />}
        </div>
      )}
    </section>
  );
}

interface ImportSummary {
  applied: number;
  unmatched: string[];
  rejectedLines: Array<{ line: number; text: string }>;
}

/**
 * What the import could not use, not just what it could.
 *
 * "2 applied" out of four hundred is the ordinary first attempt — wrong
 * integration, or the columns the other way round — and a user told only the
 * success count has nothing to correct from.
 */
function ImportReport({ result }: { result: ImportSummary }) {
  return (
    <div className="mt-2 space-y-1 text-sm">
      <p className="text-slate-700">
        {result.applied} pair{result.applied === 1 ? "" : "s"} applied.
      </p>
      {result.unmatched.length > 0 && (
        <p className="text-amber-800">
          {result.unmatched.length} id
          {result.unmatched.length === 1 ? "" : "s"} matched no record here:{" "}
          <span className="font-mono text-xs">
            {result.unmatched.slice(0, 8).join(", ")}
            {result.unmatched.length > 8 ? "…" : ""}
          </span>
        </p>
      )}
      {result.rejectedLines.length > 0 && (
        <p className="text-amber-800">
          {result.rejectedLines.length} line
          {result.rejectedLines.length === 1 ? "" : "s"} were not a pair (first
          at line {result.rejectedLines[0]?.line}).
        </p>
      )}
    </div>
  );
}
