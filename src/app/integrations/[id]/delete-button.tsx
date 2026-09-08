"use client";

/**
 * Delete an integration.
 *
 * Two-step rather than a one-click destructive action, and the confirmation
 * spells out what goes with it — deletion cascades to synced customers and
 * contacts, which is not obvious from a button labelled "Delete integration".
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteButton({
  integrationId,
  label,
  recordCount,
}: {
  integrationId: string;
  label: string;
  recordCount: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/integrations/${integrationId}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as {
        error?: string;
        revoked?: boolean;
      };

      if (!response.ok) {
        setError(body.error ?? "Could not delete the integration");
        setDeleting(false);
        return;
      }

      // Deletion succeeds even when the provider did not confirm revocation;
      // saying so beats implying the token is definitely gone.
      const suffix = body.revoked === false ? "?revocation=unconfirmed" : "";
      router.push(`/integrations${suffix}`);
      router.refresh();
    } catch {
      setError("Could not reach the server");
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
      >
        Delete integration
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-900">
        Delete “{label}”?
      </p>
      <p className="mt-1 text-sm text-red-800">
        This revokes the access token at the provider and removes the stored
        credentials, field mappings, and {recordCount} synced record
        {recordCount === 1 ? "" : "s"}. It cannot be undone.
      </p>

      {error !== null && (
        <p className="mt-2 text-sm font-medium text-red-900">{error}</p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Yes, delete"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
          }}
          disabled={deleting}
          className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
