import Link from "next/link";
import { notFound } from "next/navigation";
import { bootstrap } from "@/core/bootstrap";
import {
  supportedObjectsFor,
  unsupportedFunctionsFor,
} from "@/core/capabilities";
import {
  findIntegrationForUser,
  loadIntegrationDeletionPreview,
} from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { functionRegistry, resolveScopes } from "@/core/registries/function-registry";
import { providerRegistry } from "@/core/registries/provider-registry";
import { checkReauthorization } from "@/core/oauth/oauth-service";
import { connectHrefFor } from "@/core/providers/connect-url";
import {
  StatusBadge,
  SyncabilityBadge,
} from "@/app/integrations/status-badge";
import { listRecentRuns } from "@/core/repositories/sync-run-repository";
import { countMappings } from "@/core/repositories/mapping-repository";
import { SyncPanel } from "./sync-panel";
import { IdentityPanel } from "./identity-panel";
import { DeleteButton } from "./delete-button";

export const dynamic = "force-dynamic";

export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const { connected, error } = await searchParams;

  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) notFound();

  const provider = providerRegistry.get(integration.providerName);
  const isApiKey = provider?.auth.kind === "apiKey";
  const unsupportedFunctions = unsupportedFunctionsFor(
    integration.functionNames,
    integration.providerName
  );
  const syncable = unsupportedFunctions.length === 0;
  const reauth = await checkReauthorization(integration);
  const runs = await listRecentRuns(integration.id);

  // A sync with no rules writes nothing, so the page says that up front rather
  // than letting the user discover it from an empty data browser.
  const ruleCounts = await Promise.all(
    integration.functionNames.map(async (name) => ({
      name,
      count: await countMappings(integration.id, name),
    }))
  );
  const unmapped = ruleCounts.filter(
    (entry) =>
      entry.count === 0 && !unsupportedFunctions.includes(entry.name)
  );

  // Counted so the delete confirmation can say what is actually at stake
  // rather than a vague "and all its data". The repository owns the list of
  // cascading relations so this panel, the delete audit, and the actual removal
  // cannot drift apart. Account counts distinguish profiles that survive on
  // another connection's members from shells that will be reaped.
  const deletionPreview = await loadIntegrationDeletionPreview(integration.id);
  if (deletionPreview === undefined) notFound();

  let scopes: string[] = [];
  try {
    scopes = resolveScopes(integration.functionNames, integration.providerName);
  } catch {
    // A function/provider pair can stop being valid if the registry changes
    // under a stored integration; the page should still render.
  }

  return (
    <div className="space-y-8">
      {error !== undefined && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}
      {connected === "1" && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Connected. Next: map the fields you want to import.
        </p>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/integrations"
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ← Integrations
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {integration.instanceLabel}
          </h1>
          <p className="mt-1 text-slate-600">
            {provider?.label ?? integration.providerName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SyncabilityBadge syncable={syncable} />
          <StatusBadge status={integration.status} />
        </div>
      </div>

      {unsupportedFunctions.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            This integration cannot sync
          </p>
          <p className="mt-1 text-sm text-amber-800">
            No sync handler is available for{" "}
            {unsupportedFunctions.join(", ")} on{" "}
            {provider?.label ?? integration.providerName}. This connection
            cannot pull records while{" "}
            {unsupportedFunctions.length === 1 ? "that function is" : "those functions are"}{" "}
            included. Delete it and create a new integration without{" "}
            {unsupportedFunctions.length === 1 ? "it" : "them"}.
          </p>
        </div>
      )}

      {/* Re-consent prompt: the stored grant no longer covers the function set. */}
      {reauth.needed && integration.status === "active" && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
          <p className="text-sm font-medium text-orange-900">
            Additional access needed
          </p>
          <p className="mt-1 text-sm text-orange-800">
            {reauth.uncoveredFunctions.length > 0
              ? `This integration now serves ${reauth.uncoveredFunctions.join(", ")}, which needs permissions beyond what was granted.`
              : "The stored authorization does not cover everything this integration needs."}
          </p>
          <a
            href={connectHrefFor(integration.providerName, integration.id)}
            className="mt-3 inline-block rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-500"
          >
            {isApiKey ? "Replace API key" : "Reconnect"}
          </a>
        </div>
      )}

      {integration.status === "pending_authorization" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            {isApiKey
              ? "This integration needs an API key before it can sync."
              : "This integration has not been authorized yet."}
          </p>
          <a
            href={connectHrefFor(integration.providerName, integration.id)}
            className="mt-3 inline-block rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            {isApiKey ? "Enter API key" : "Authorize"}
          </a>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Functions
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {integration.functionNames.map((name) => {
            const definition = functionRegistry.get(name);
            const objects = supportedObjectsFor(name, integration.providerName);
            const unserved =
              definition?.dataModels.filter(
                (declared) => !objects.some((object) => object === declared)
              ) ?? [];
            return (
              <div
                key={name}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <p className="font-medium">{definition?.label ?? name}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {definition?.description ?? ""}
                </p>
                <p
                  className={`mt-2 text-xs ${
                    objects.length === 0 ? "text-amber-700" : "text-slate-400"
                  }`}
                >
                  Writes:{" "}
                  {objects.length > 0
                    ? objects.join(", ")
                    : "nothing — no sync handler"}
                </p>
                {unserved.length > 0 && (
                  <p className="mt-1 text-xs text-slate-400">
                    Not served by this provider: {unserved.join(", ")}
                  </p>
                )}
                <p className="mt-3 text-sm">
                  {objects.length > 0 ? (
                    <>
                      <Link
                        href={`/integrations/${integration.id}/mapping?function=${name}`}
                        className="text-slate-700 underline underline-offset-2 hover:text-slate-900"
                      >
                        Edit field mapping
                      </Link>
                      <span className="ml-2 text-xs text-slate-400">
                        {ruleCounts.find((entry) => entry.name === name)?.count ?? 0}{" "}
                        rules
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-amber-700">
                      No mapping until a handler exists
                    </span>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {unmapped.length > 0 && integration.status === "active" && syncable && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No field mapping is configured for{" "}
          {unmapped.map((entry) => entry.name).join(", ")}. A sync would have
          nothing to write, so it will stop with an error until you map at least
          one field.
        </p>
      )}

      <SyncPanel
        integrationId={integration.id}
        canSync={integration.status === "active" && syncable}
        initialRuns={runs.map((run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
        }))}
      />

      <IdentityPanel
        integrationId={integration.id}
        providerName={provider?.label ?? integration.providerName}
        initialPriority={integration.identityPriority}
        // Every provider but this one. A crosswalk naming this integration's
        // own provider would pair its ids with its own ids, which is the
        // self-key the resolver already emits for free.
        foreignProviders={providerRegistry
          .getAll()
          .filter((candidate) => candidate.name !== integration.providerName)
          .map((candidate) => ({ name: candidate.name, label: candidate.label }))
          .sort((a, b) => a.label.localeCompare(b.label))}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Permissions requested
        </h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <ul className="space-y-1.5">
            {scopes.map((scope) => (
              <li key={scope} className="font-mono text-[13px] text-slate-700">
                {scope}
                {reauth.missing.includes(scope) && (
                  <span className="ml-2 rounded bg-orange-100 px-1.5 py-0.5 font-sans text-[11px] text-orange-800">
                    not yet granted
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="space-y-3 border-t border-slate-200 pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Danger zone
        </h2>
        <DeleteButton
          integrationId={integration.id}
          label={integration.instanceLabel}
          isApiKey={isApiKey}
          recordCount={deletionPreview.recordCount}
          keyCount={deletionPreview.keyCount}
          accountsRebuilt={deletionPreview.accountsRebuilt}
          accountsRemoved={deletionPreview.accountsRemoved}
        />
      </section>
    </div>
  );
}
