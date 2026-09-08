"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * What this form is attaching a key to.
 *
 * A draft has no integration row yet — one is created only if the key is
 * accepted — so the two cases post to different endpoints and learn the
 * integration id at different times. Modelling that as a union keeps the
 * difference explicit instead of hiding it behind an id that means one of two
 * things.
 */
export type ConnectTarget =
  | { kind: "integration"; integrationId: string }
  | { kind: "draft"; draftId: string };

export function ApiKeyForm({
  target,
  placeholder,
}: {
  target: ConnectTarget;
  placeholder: string;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setRetryable(false);

    const request =
      target.kind === "draft"
        ? {
            url: "/api/integrations/connect",
            body: { draftId: target.draftId, apiKey: key },
          }
        : {
            url: `/api/integrations/${target.integrationId}/credentials`,
            body: { apiKey: key },
          };

    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        retryable?: boolean;
        integrationId?: string;
      };

      if (!response.ok || body.ok !== true) {
        // The draft survives a rejected key, so staying on this form with the
        // error is a real retry — the user re-pastes rather than re-choosing a
        // provider and functions.
        setError(body.error ?? "Could not connect");
        setRetryable(body.retryable === true);
        setSubmitting(false);
        return;
      }

      // Clear it from component state the moment it is no longer needed.
      setKey("");

      const integrationId =
        target.kind === "draft" ? body.integrationId : target.integrationId;

      if (integrationId === undefined) {
        // Connected, but we were not told what to. Better to land the user on
        // the list, where the new integration will be visible, than to navigate
        // to `/integrations/undefined`.
        router.push("/integrations");
        return;
      }

      router.push(`/integrations/${integrationId}?connected=1`);
    } catch {
      setError("Could not reach the server");
      setRetryable(true);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-sm text-slate-600">API key</span>
        <input
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          // A credential, so: masked, never autofilled from a password manager
          // entry for this site, and no spellcheck sending it anywhere.
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm"
        />
      </label>

      {error !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
          {retryable && " The key itself may be fine."}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || key.trim() === ""}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
      >
        {submitting ? "Checking…" : retryable ? "Try again" : "Connect"}
      </button>
    </form>
  );
}
