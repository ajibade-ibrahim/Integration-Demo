import Link from "next/link";
import { bootstrap } from "@/core/bootstrap";
import { unsupportedFunctionsFor } from "@/core/capabilities";
import { findIdentityWithdrawalForUser } from "@/core/repositories/identity-withdrawal-repository";
import { listIntegrations } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { functionRegistry } from "@/core/registries/function-registry";
import { providerRegistry } from "@/core/registries/provider-registry";
import {
  StatusBadge,
  SyncabilityBadge,
} from "@/app/integrations/status-badge";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    revocation?: string;
    error?: string;
    deleted?: string;
  }>;
}) {
  bootstrap();
  const { revocation, error, deleted } = await searchParams;
  const userId = await currentUserId();
  const [integrations, withdrawal] = await Promise.all([
    listIntegrations(userId),
    deleted === undefined || deleted === ""
      ? Promise.resolve(undefined)
      : findIdentityWithdrawalForUser(userId, deleted, "integration_deleted"),
  ]);

  return (
    <div className="space-y-6">
      {/*
        Where a failed first-time connect lands. There is no integration page to
        show it on, because no integration was created — so the message has to
        say what happened here, or the user is returned to an unchanged list
        with no explanation of why.
      */}
      {error !== undefined && error !== "" && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error} Nothing was created, so there is nothing to remove — set the
          integration up again to retry.
        </p>
      )}
      {/*
        The integration is gone either way. Saying the provider did not confirm
        revocation is more honest than implying the token was definitely
        withdrawn — the user may want to revoke it from the provider's side.
      */}
      {revocation === "unconfirmed" && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Integration deleted, but the provider did not confirm the token was
          revoked. Consider removing this app&apos;s access from the provider
          directly.
        </p>
      )}
      {withdrawal !== undefined && (
        <section
          className={`rounded-xl border p-4 text-sm ${
            withdrawal.status === "reassessed"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          <p className="font-medium">
            Deleted “{withdrawal.instanceLabel ?? "integration"}” from{" "}
            {providerRegistry.get(withdrawal.providerName)?.label ??
              withdrawal.providerName}{" "}
            on {withdrawal.createdAt.toLocaleString()}.
          </p>
          <p className="mt-1">
            Removed {withdrawal.removedRecords} synced record
            {withdrawal.removedRecords === 1 ? "" : "s"} and{" "}
            {withdrawal.retiredKeys} identity key
            {withdrawal.retiredKeys === 1 ? "" : "s"}.{" "}
            {withdrawal.status === "reassessed"
              ? `${withdrawal.accountsReassessed} affected account${
                  withdrawal.accountsReassessed === 1 ? "" : "s"
                } rebuilt from surviving members; ${withdrawal.accountsReaped} empty account${
                  withdrawal.accountsReaped === 1 ? "" : "s"
                } removed.`
              : "The removal is complete, but account cleanup did not finish. The next sync or account refresh will retry."}
          </p>
          <p className="mt-1">
            Records from your other connections remain. This audit keeps the
            provider, label, time, and counts only — no customer data.
          </p>
        </section>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <Link
          href="/integrations/new"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          New integration
        </Link>
      </div>

      {integrations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-600">No integrations yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Connect a system to start syncing data.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {integrations.map((integration) => {
            const provider = providerRegistry.get(integration.providerName);
            const syncable =
              unsupportedFunctionsFor(
                integration.functionNames,
                integration.providerName
              ).length === 0;
            return (
              <li key={integration.id}>
                <Link
                  href={`/integrations/${integration.id}`}
                  className="block rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {integration.instanceLabel}
                        </span>
                        <span className="text-sm text-slate-400">
                          {provider?.label ?? integration.providerName}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {integration.functionNames.map((name) => (
                          <span
                            key={name}
                            className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                          >
                            {functionRegistry.get(name)?.label ?? name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-slate-400">
                        {integration.lastSyncTimestamp === null
                          ? "Never synced"
                          : `Last sync ${integration.lastSyncTimestamp.toLocaleDateString()}`}
                      </span>
                      <SyncabilityBadge syncable={syncable} />
                      <StatusBadge status={integration.status} />
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
