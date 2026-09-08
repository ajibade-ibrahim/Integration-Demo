/**
 * Connecting a provider that authenticates with a static API key.
 *
 * The twin of `handleCallback` in `oauth/oauth-service.ts`, and deliberately
 * shaped like it: prove the credential, persist it, then hand off to the shared
 * `finalizeConnection`. What it does not have is a redirect, a state parameter,
 * a code exchange, or an expiry — none of which an API key involves.
 *
 * Nothing here logs the key, and the route above it returns only a verdict.
 */

import {
  functionNamesForProvider,
  resolveScopes,
} from "../registries/function-registry";
import { providerRegistry } from "../registries/provider-registry";
import {
  findIntegration,
  updateStatus,
} from "../repositories/integration-repository";
import {
  NON_EXPIRING_AT,
  saveToken,
} from "../repositories/token-repository";
import {
  createIntegrationFromDraft,
  finalizeConnection,
} from "../integrations/connection";
import { findDraft } from "../integrations/draft-store";
import type { ProviderMetadata } from "../types/registry";
import { InvalidApiKeyError } from "./errors";

export { InvalidApiKeyError };

export interface ApiKeyConnectResult {
  ok: boolean;
  error?: string;
  /** True when the failure was transient, so the UI can offer "try again". */
  retryable?: boolean;
  /**
   * The connected integration, on success. Present for both entry points, but
   * only the draft flow genuinely needs it — that is the caller which does not
   * already know the id, because the row did not exist when it started.
   */
  integrationId?: string;
}

/**
 * What a static API key actually grants.
 *
 * An OAuth grant is narrowed to the functions consented to, so widening the
 * function set genuinely requires re-consent. A key carries no such narrowing:
 * whatever it can reach, it could always reach. Recording the full declared set
 * states that truthfully, and stops `checkReauthorization` raising a "reconnect
 * for more access" prompt that no reconnection could satisfy — the honest
 * remedy for an under-powered key is to widen it in the provider's own console.
 */
export function grantedScopesForApiKey(providerName: string): string[] {
  const scopes = new Set<string>();
  for (const functionName of functionNamesForProvider(providerName)) {
    for (const scope of resolveScopes([functionName], providerName)) {
      scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

/** A validated, provider-accepted key, ready to persist. */
interface ProvenKey {
  key: string;
  probed: ProviderMetadata;
}

/**
 * Check the key's shape, then prove it against the provider.
 *
 * Shared by both entry points below, and deliberately free of database writes:
 * it is called before anything is persisted in the draft flow, and before the
 * existing token is replaced in the reconnect flow. Either way, an unproven key
 * never reaches storage.
 */
async function proveKey(
  provider: { label: string; name: string; auth: { kind: string } },
  auth: {
    validateKeyShape: (key: string) => string | undefined;
    probeCredential: (key: string) => Promise<ProviderMetadata>;
  },
  rawKey: string,
  context: string
): Promise<{ proven?: ProvenKey; failure?: ApiKeyConnectResult }> {
  const key = rawKey.trim();

  // Free check first, so an obviously wrong paste costs no round trip.
  const shapeProblem = auth.validateKeyShape(key);
  if (shapeProblem !== undefined) {
    return { failure: { ok: false, error: shapeProblem } };
  }

  try {
    return { proven: { key, probed: await auth.probeCredential(key) } };
  } catch (error) {
    if (error instanceof InvalidApiKeyError) {
      return {
        failure: { ok: false, error: `${provider.label} rejected that key.` },
      };
    }
    // Log a bare sentence, never the error object: a fetch failure can carry
    // the request headers, and the key is one of them.
    console.error(`[api-key] Probe failed for ${context} at ${provider.name}`);
    return {
      failure: {
        ok: false,
        retryable: true,
        error: `Could not reach ${provider.label} to check the key. Try again.`,
      },
    };
  }
}

/** The token row for a proven key. Identical for a new and a reconnected one. */
function tokenFor(
  integrationId: string,
  providerName: string,
  proven: ProvenKey
): Parameters<typeof saveToken>[0] {
  return {
    integrationId,
    // Same encrypted column as a bearer token — one secret-handling path.
    accessToken: proven.key,
    refreshToken: undefined,
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: grantedScopesForApiKey(providerName),
    metadata: {
      // Load-bearing: `isNonExpiring` reads this to keep the key off the
      // refresh path without needing to load the integration.
      authKind: "apiKey",
      // Not secret, and how a user notices they pasted a test key into a
      // production integration.
      keyPrefix: proven.key.slice(0, 8),
      keyLast4: proven.key.slice(-4),
      ...proven.probed,
    },
  };
}

/**
 * Connect a draft — the first-time path.
 *
 * No integration exists yet, and none is created unless the key is accepted, so
 * a rejected or mistyped key leaves nothing behind. The draft is left intact on
 * failure so the user can re-paste without re-choosing provider and functions.
 */
export async function connectDraftWithApiKey(args: {
  draftId: string;
  apiKey: string;
}): Promise<ApiKeyConnectResult> {
  const draft = await findDraft(args.draftId);
  if (draft === undefined) {
    return {
      ok: false,
      error: "This connection attempt expired. Start it again.",
    };
  }

  const provider = providerRegistry.require(draft.providerName);
  if (provider.auth.kind !== "apiKey") {
    return {
      ok: false,
      error: `${provider.label} connects with OAuth, not an API key.`,
    };
  }

  const { proven, failure } = await proveKey(
    provider,
    provider.auth,
    args.apiKey,
    `a new ${provider.name} integration`
  );
  if (proven === undefined) return failure ?? { ok: false, error: "Could not connect" };

  try {
    const integration = await createIntegrationFromDraft({
      draft,
      at: new Date(),
      storeCredential: (integrationId) =>
        saveToken(tokenFor(integrationId, provider.name, proven)),
    });
    return { ok: true, integrationId: integration.id };
  } catch (error) {
    console.error(
      `[api-key] Could not persist a new ${provider.name} integration:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return { ok: false, retryable: true, error: "Could not save the connection." };
  }
}

/**
 * Re-key an integration that already exists.
 *
 * Kept separate from the draft path because the failure policy is the opposite:
 * this row may carry edited mappings and synced records, so a rejected key sets
 * `error` and preserves everything rather than removing anything.
 */
export async function connectWithApiKey(args: {
  integrationId: string;
  apiKey: string;
}): Promise<ApiKeyConnectResult> {
  const integration = await findIntegration(args.integrationId);
  if (integration === undefined) {
    return { ok: false, error: "Integration no longer exists." };
  }

  const provider = providerRegistry.require(integration.providerName);
  if (provider.auth.kind !== "apiKey") {
    return {
      ok: false,
      error: `${provider.label} connects with OAuth, not an API key.`,
    };
  }

  const { proven, failure } = await proveKey(
    provider,
    provider.auth,
    args.apiKey,
    `integration ${args.integrationId}`
  );
  if (proven === undefined) {
    // A key the provider actively rejected leaves the integration unusable, and
    // saying so is more useful than leaving it looking connected. A transient
    // probe failure is not evidence about the key, so it changes nothing.
    if (failure?.retryable !== true) {
      await updateStatus(args.integrationId, "error");
    }
    return failure ?? { ok: false, error: "Could not connect" };
  }

  await saveToken(tokenFor(args.integrationId, provider.name, proven));
  await finalizeConnection(integration, new Date());
  return { ok: true, integrationId: integration.id };
}
