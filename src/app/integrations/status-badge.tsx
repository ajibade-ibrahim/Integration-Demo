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
