import Link from "next/link";
import { notFound } from "next/navigation";
import { bootstrap, IDENTITY_FUNCTION } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { findMappings } from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { discoverFields } from "@/core/sync/discovery-service";
import { allObjectSchemas, mappableFields } from "@/core/identity-schema";
import { providerRegistry } from "@/core/registries/provider-registry";
import { HUBSPOT_PROVIDER_NAME } from "@/core/providers/hubspot/provider";
import type { TargetObject } from "@/core/types/common";
import { MappingEditor, type EditorObject } from "./editor";

export const dynamic = "force-dynamic";

export default async function MappingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ function?: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const { function: requested } = await searchParams;

  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) notFound();

  const functionName = requested ?? IDENTITY_FUNCTION;
  if (!integration.functionNames.includes(functionName)) notFound();

  const provider = providerRegistry.get(integration.providerName);
  const rules = await findMappings(id, functionName);
  const suggested = defaultMappingsFor(functionName, integration.providerName);

  // Discovery talks to the provider. A failure here must not block editing —
  // the editor falls back to free-text source paths.
  let discovered: Record<string, { path: string; label: string; type: string }[]> =
    {};
  let discoveryError: string | undefined;

  if (integration.status === "active") {
    try {
      const results = await discoverFields(id, functionName);
      discovered = Object.fromEntries(
        results.map((result) => [result.object, [...result.fields]])
      );
    } catch (error) {
      discoveryError =
        error instanceof Error ? error.message : "field discovery failed";
    }
  } else {
    discoveryError = `integration is ${integration.status}`;
  }

  /**
   * Providers a customer here can hold a cross-reference to.
   *
   * This integration's own provider is excluded: every customer already
   * contributes its own id automatically, so mapping it again would be a rule
   * that adds nothing. Contacts get none — a cross-reference is a claim about
   * two records being the same company.
   */
  const crossRefProviders = providerRegistry
    .getAll()
    .filter((candidate) => candidate.name !== integration.providerName)
    .map((candidate) => ({ name: candidate.name, label: candidate.label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const objects: EditorObject[] = allObjectSchemas().map((schema) => ({
    object: schema.object,
    label: schema.label,
    sources: discovered[schema.object] ?? [],
    crossRefProviders: schema.object === "customer" ? crossRefProviders : [],
    targets: mappableFields(schema.object).map((field) => ({
      name: field.name,
      label: field.label,
      kind: field.kind,
      ...(field.required === true ? { required: true } : {}),
      ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }),
    })),
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/integrations/${id}`}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← {integration.instanceLabel}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Field mapping
        </h1>
        <p className="mt-1 text-slate-600">
          Decide how {provider?.label ?? integration.providerName} fields land in
          your schema. Unmapped target fields are left empty; a mapped field the
          source does not have becomes null rather than failing the record.
        </p>
      </div>

      {/*
        HubSpot splits a person's name across two properties and our Contact
        holds one. Building a general multi-source concatenation for a single
        provider quirk is not worth the complexity, but leaving users to discover
        it by seeing surnames vanish is worse. So: say it plainly.
      */}
      {integration.providerName === HUBSPOT_PROVIDER_NAME && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <span className="font-medium">Note on contact names.</span> HubSpot has
          no single name property — the suggested mapping uses{" "}
          <code className="font-mono text-[13px]">properties.firstname</code>{" "}
          only. Each rule writes one source field, so surnames are not imported
          unless you map <code className="font-mono text-[13px]">lastname</code>{" "}
          to a custom field instead.
        </p>
      )}

      <MappingEditor
        integrationId={id}
        functionName={functionName}
        objects={objects}
        initialRules={rules.map((rule) => ({
          sourceFieldPath: rule.sourceFieldPath,
          targetObject: rule.targetObject as TargetObject,
          targetFieldPath: rule.targetFieldPath,
          transform: rule.transform,
        }))}
        suggested={suggested}
        {...(discoveryError === undefined ? {} : { discoveryError })}
      />
    </div>
  );
}
