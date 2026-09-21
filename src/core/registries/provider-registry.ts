/**
 * Provider registry and per-provider credential resolution.
 */

import {
  isExternalIdScope,
  type OAuthProviderAuth,
  type ProviderAuth,
  type ProviderDefinition,
  type ProviderMetadata,
} from "../types/registry";
import { Registry } from "./registry";

export const providerRegistry = new Registry<ProviderDefinition>(
  "ProviderRegistry"
);

export function registerProvider(definition: ProviderDefinition): void {
  providerRegistry.register(definition, (d) => {
    const auth: ProviderAuth | undefined = d.auth;
    if (auth === undefined) {
      throw new Error(`ProviderRegistry: '${d.name}' is missing auth`);
    }

    // Checked here rather than trusted from the type, for the same reason the
    // auth hooks are: a definition can arrive from JavaScript, and getting this
    // wrong merges two accounts' companies rather than failing visibly.
    if (!isExternalIdScope(d.externalIdScope)) {
      throw new Error(
        `ProviderRegistry: '${d.name}' is missing externalIdScope ` +
          `('global' or 'tenant')`
      );
    }
    if (d.externalIdScope === "tenant" && typeof d.tenantScopeValue !== "function") {
      throw new Error(
        `ProviderRegistry: '${d.name}' has tenant-scoped ids but no ` +
          `tenantScopeValue hook`
      );
    }

    switch (auth.kind) {
      case "oauth": {
        for (const field of ["authorizeEndpoint", "tokenEndpoint"] as const) {
          const value = auth[field];
          if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`ProviderRegistry: '${d.name}' is missing ${field}`);
          }
        }
        if (typeof auth.buildAuthorizeParams !== "function") {
          throw new Error(
            `ProviderRegistry: '${d.name}' is missing buildAuthorizeParams`
          );
        }
        if (typeof auth.parseTokenResponse !== "function") {
          throw new Error(
            `ProviderRegistry: '${d.name}' is missing parseTokenResponse`
          );
        }
        return;
      }
      case "apiKey": {
        if (typeof auth.header !== "string" || auth.header.trim() === "") {
          throw new Error(`ProviderRegistry: '${d.name}' is missing auth.header`);
        }
        if (typeof auth.validateKeyShape !== "function") {
          throw new Error(
            `ProviderRegistry: '${d.name}' is missing validateKeyShape`
          );
        }
        if (typeof auth.probeCredential !== "function") {
          throw new Error(
            `ProviderRegistry: '${d.name}' is missing probeCredential`
          );
        }
        return;
      }
      default: {
        // Exhaustiveness: a new credential kind must state its own validation
        // rather than registering unchecked.
        const unreachable: never = auth;
        throw new Error(
          `ProviderRegistry: '${d.name}' has an unknown auth kind ` +
            `'${(unreachable as ProviderAuth).kind}'`
        );
      }
    }
  });
}

/** Narrow a definition to its OAuth credential, or throw naming the mismatch. */
export function requireOAuth(definition: ProviderDefinition): OAuthProviderAuth {
  if (definition.auth.kind !== "oauth") {
    throw new Error(
      `Provider '${definition.name}' connects with an API key, not OAuth`
    );
  }
  return definition.auth;
}

/**
 * Whether a stored credential can be exchanged for a fresh one.
 *
 * Read by the sync engine and discovery service to decide whether to hand
 * handlers a `refreshAccessToken` callback at all. An API key has nothing to
 * refresh with, and `HandlerContext` documents an absent callback as "a 401 is
 * terminal" — which is exactly the right answer for a revoked key.
 */
export function canRefresh(providerName: string): boolean {
  return providerRegistry.get(providerName)?.auth.kind === "oauth";
}

/**
 * The scope segment for this provider's record ids, given one credential.
 *
 * `""` for a globally-unique-id provider — there is nothing to qualify, and an
 * empty segment keeps the composed key shape (`provider:scope:id`) uniform
 * rather than making callers branch.
 *
 * `undefined` means **do not build a key at all**. A tenant-scoped provider
 * whose credential does not reveal its account is the fail-closed case: HubSpot
 * is exactly this today, because its token response carries no `hub_id` and
 * nothing else identifies the portal. HubSpot therefore contributes no
 * `external_ref` evidence, which is correct rather than broken — it can still
 * join on email and domain.
 *
 * @returns The scope segment, or undefined when no safe one exists.
 */
export function externalIdScopeValue(
  definition: ProviderDefinition,
  metadata: ProviderMetadata
): string | undefined {
  if (definition.externalIdScope === "global") return "";

  const value = definition.tenantScopeValue?.(metadata);
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Read a provider's OAuth credentials from the environment.
 *
 * @throws With a message naming the missing env var, so a half-configured
 *   provider fails at connect time with an actionable error rather than a
 *   confusing 400 from the provider.
 */
export function providerCredentials(
  definition: ProviderDefinition
): ProviderCredentials {
  const auth = requireOAuth(definition);
  const clientId = process.env[auth.clientIdEnv];
  const clientSecret = process.env[auth.clientSecretEnv];

  if (clientId === undefined || clientId === "") {
    throw new Error(
      `Provider '${definition.name}' is not configured: set ${auth.clientIdEnv}`
    );
  }
  if (clientSecret === undefined || clientSecret === "") {
    throw new Error(
      `Provider '${definition.name}' is not configured: set ${auth.clientSecretEnv}`
    );
  }
  return { clientId, clientSecret };
}

/**
 * Whether a provider can be connected right now.
 *
 * An OAuth provider needs deployment-level client credentials, so an unset env
 * var greys it out. An API-key provider's credential is supplied per
 * integration at connect time, so there is nothing that could be missing here —
 * it is always offerable.
 */
export function isProviderConfigured(definition: ProviderDefinition): boolean {
  if (definition.auth.kind === "apiKey") return true;
  try {
    providerCredentials(definition);
    return true;
  } catch {
    return false;
  }
}

/** What the picker tells a user to do before this provider will work. */
export function credentialHint(definition: ProviderDefinition): string {
  return definition.auth.kind === "apiKey"
    ? "You will paste an API key after creating this integration"
    : `Set ${definition.auth.clientIdEnv} in .env`;
}
