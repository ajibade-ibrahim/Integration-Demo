import type { IntegrationStatus } from "@/core/types/common";

const PRESENTATION: Record<IntegrationStatus, { label: string; className: string }> = {
  pending_authorization: {
    label: "Awaiting authorization",
    className: "bg-amber-100 text-amber-800",
  },
  active: { label: "Active", className: "bg-emerald-100 text-emerald-800" },
  expired: { label: "Expired", className: "bg-slate-100 text-slate-600" },
  requires_reauthorization: {
    label: "Reconnect required",
    className: "bg-orange-100 text-orange-800",
  },
  error: { label: "Error", className: "bg-red-100 text-red-800" },
};

export function StatusBadge({ status }: { status: IntegrationStatus }) {
  const { label, className } =
    PRESENTATION[status] ?? PRESENTATION.error;
  return (
    <span className={`rounded px-2 py-1 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

/**
 * The capability question, separate from the authorization question.
 *
 * `StatusBadge` says whether the credential is usable; this says whether a
 * handler exists to use it. An integration can be active and still unable to
 * sync, which is exactly the legacy state this badge exists to make visible.
 */
export function SyncabilityBadge({ syncable }: { syncable: boolean }) {
  return (
    <span
      className={`rounded px-2 py-1 text-xs font-medium ${
        syncable
          ? "bg-emerald-100 text-emerald-800"
          : "bg-amber-100 text-amber-800"
      }`}
    >
      {syncable ? "Sync capable" : "Cannot sync"}
    </span>
  );
}
