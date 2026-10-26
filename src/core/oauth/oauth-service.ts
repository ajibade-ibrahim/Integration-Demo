/**
 * OAuth 2.0 authorization-code flow: initiate, callback, refresh, revoke.
 *
 * Provider differences live in `ProviderDefinition` (endpoints, authorize
 * params, token parsing). This module owns the parts that are the same
 * everywhere: scope resolution across the integration's function set, state
 * validation, token persistence, and proactive refresh.
 */

import { unsupportedFunctionsFor } from "../capabilities";
import {
  functionRegistry,
  missingScopes,
  resolveScopes,
  scopesAreCovered,
} from "../registries/function-registry";
import {
  providerCredentials,
  providerRegistry,
  requireOAuth,
} from "../registries/provider-registry";
import type { OAuthProviderAuth, ProviderDefinition } from "../types/registry";
import {
  findToken,
  isNonExpiring,
  saveToken,
  type StoredToken,
} from "../repositories/token-repository";
import {
  findIntegration,
  updateStatus,
  type IntegrationRecord,
} from "../repositories/integration-repository";
import {
  consumeState,
  discardStateForDraft,
  issueState,
  type StateSubject,
} from "./state-store";
import { findDraft } from "../integrations/draft-store";
import {
  createIntegrationFromDraft,
  finalizeConnection,
} from "../integrations/connection";

/** Refresh this far ahead of expiry so a sync never starts on a dying token. */
export const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/** Cap on the token exchange, so a hung provider cannot wedge a request. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

export function redirectUriFor(providerName: string): string {
  const base = process.env["APP_BASE_URL"] ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/oauth/${providerName}/callback`;
}

// ---------------------------------------------------------------------------
// Initiate
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  url: string;
  state: string;
  /** Exactly the scopes being requested — shown on the consent screen. */
  scopes: string[];
}

/**
 * Build the provider authorization URL for a draft or an existing integration.
 *
 * The scopes are the union across every function being connected, which is the
 * whole point of choosing functions before connecting: consent asks for what
 * those functions need and nothing else.
 *
 * Takes the subject rather than an `IntegrationRecord` because a first-time
 * connect has no record yet — only a draft. Both carry a provider and a
 * function set, which is all this needs.
 */
export async function buildAuthorizationRequest(args: {
  subject: StateSubject;
  providerName: string;
  functionNames: readonly string[];
}): Promise<AuthorizationRequest> {
  const provider = providerRegistry.require(args.providerName);
  const auth = requireOAuth(provider);
  const { clientId } = providerCredentials(provider);

  const scopes = resolveScopes(args.functionNames, provider.name);
  const state = await issueState(args.subject);

  const params = auth.buildAuthorizeParams({
    clientId,
    redirectUri: redirectUriFor(provider.name),
    scopes,
    state,
  });

  const url = new URL(auth.authorizeEndpoint);
  for (const [key, value] of params) url.searchParams.set(key, value);

  return { url: url.toString(), state, scopes };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface CallbackResult {
  ok: boolean;
  integrationId?: string;
  error?: string;
}

/**
 * Complete the flow: validate state, exchange the code, persist the token.
 *
 * State is validated before the code is used. A mismatched or replayed state
 * means the code is discarded unexchanged.
 */
export async function handleCallback(args: {
  providerName: string;
  code: string | null;
  state: string | null;
  providerError?: string | null;
}): Promise<CallbackResult> {
  const validation = await consumeState(args.state);
  if (!validation.ok || validation.subject === undefined) {
    return { ok: false, error: validation.reason ?? "Invalid state" };
  }
  const subject = validation.subject;

  return subject.kind === "draft"
    ? completeDraftCallback(subject.draftId, args)
    : completeReconnectCallback(subject.integrationId, args);
}

/**
 * A first-time connect: there is no integration row, and there must not be one
 * unless this succeeds.
 *
 * Every failure below therefore just reports — there is no status to set and
 * nothing to delete. The draft is deliberately left in place rather than
 * discarded, so the user can be sent back to try again within its TTL.
 */
async function completeDraftCallback(
  draftId: string,
  args: { providerName: string; code: string | null; providerError?: string | null }
): Promise<CallbackResult> {
  const draft = await findDraft(draftId);
  if (draft === undefined) {
    return {
      ok: false,
      error: "This connection attempt expired. Start it again.",
    };
  }

  if (args.providerError !== undefined && args.providerError !== null) {
    console.warn(
      `[oauth] Provider ${args.providerName} denied authorization for a new ${draft.providerName} integration`
    );
    return { ok: false, error: "The provider denied the authorization request." };
  }

  if (args.code === null || args.code === "") {
    return { ok: false, error: "No authorization code returned." };
  }

  const provider = providerRegistry.require(draft.providerName);
  if (provider.auth.kind !== "oauth") {
    // Only reachable by a hand-crafted callback; an API-key provider has no
    // authorization server to come back from.
    return {
      ok: false,
      error: `${provider.label} connects with an API key, not OAuth.`,
    };
  }

  const unsupported = unsupportedFunctionsFor(
    draft.functionNames,
    draft.providerName
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: `${provider.label} cannot sync ${unsupported.join(", ")}; no handler is available.`,
    };
  }

  const requestedScopes = resolveScopes(draft.functionNames, provider.name);

  let parsed: ExchangeResult;
  try {
    // Before anything is written: this is the step that proves the grant.
    parsed = await exchangeCode(provider, args.code);
  } catch (error) {
    console.error(
      `[oauth] Token exchange failed for a new ${draft.providerName} integration:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return {
      ok: false,
      error: "Could not complete authorization with the provider.",
    };
  }

  try {
    const integration = await createIntegrationFromDraft({
      draft,
      at: new Date(),
      storeCredential: (integrationId) =>
        saveToken({
          integrationId,
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: new Date(Date.now() + parsed.expiresInSeconds * 1000),
          grantedScopes:
            parsed.grantedScopes.length > 0
              ? parsed.grantedScopes
              : requestedScopes,
          metadata: parsed.metadata,
        }),
    });

    await discardStateForDraft(draftId);
    return { ok: true, integrationId: integration.id };
  } catch (error) {
    console.error(
      `[oauth] Could not persist a new ${draft.providerName} integration:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return { ok: false, error: "Could not save the connection." };
  }
}

/**
 * Reconnecting an integration that already exists.
 *
 * Unchanged from before drafts existed, and deliberately so: this row may carry
 * edited mappings and synced records, so a failed reauthorization sets `error`
 * and keeps everything. Deleting here would lose real user data.
 */
async function completeReconnectCallback(
  integrationId: string,
  args: { providerName: string; code: string | null; providerError?: string | null }
): Promise<CallbackResult> {
  // The provider declined before we got a code (user hit cancel, app
  // misconfigured). Surface a clean message, never the raw payload.
  if (args.providerError !== undefined && args.providerError !== null) {
    console.warn(
      `[oauth] Provider ${args.providerName} returned an error for integration ${integrationId}`
    );
    await updateStatus(integrationId, "error");
    return {
      ok: false,
      integrationId,
      error: "The provider denied the authorization request.",
    };
  }

  if (args.code === null || args.code === "") {
    await updateStatus(integrationId, "error");
    return { ok: false, integrationId, error: "No authorization code returned." };
  }

  const integration = await findIntegration(integrationId);
  if (integration === undefined) {
    return { ok: false, error: "Integration no longer exists." };
  }

  const provider = providerRegistry.require(integration.providerName);

  // Defence against a hand-crafted callback URL: an API-key provider has no
  // authorization server, so it can never legitimately reach this route.
  if (provider.auth.kind !== "oauth") {
    await updateStatus(integrationId, "error");
    return {
      ok: false,
      integrationId,
      error: `${provider.label} connects with an API key, not OAuth.`,
    };
  }

  const unsupported = unsupportedFunctionsFor(
    integration.functionNames,
    integration.providerName
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      integrationId,
      error: `${provider.label} cannot sync ${unsupported.join(", ")}; no handler is available.`,
    };
  }

  // What we asked for, needed as the fallback below.
  const requestedScopes = resolveScopes(
    integration.functionNames,
    provider.name
  );

  try {
    const parsed = await exchangeCode(provider, args.code);

    await saveToken({
      integrationId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: new Date(Date.now() + parsed.expiresInSeconds * 1000),
      // Prefer the provider's own account of what it granted, since it may
      // grant less than was asked. HubSpot returns no `scope` field at all, so
      // fall back to the request — recording an empty set there would make
      // every HubSpot integration look permanently under-scoped.
      grantedScopes:
        parsed.grantedScopes.length > 0 ? parsed.grantedScopes : requestedScopes,
      metadata: parsed.metadata,
    });

    await finalizeConnection(integration, new Date());

    return { ok: true, integrationId };
  } catch (error) {
    console.error(
      `[oauth] Token exchange failed for integration ${integrationId}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    await updateStatus(integrationId, "error");
    return {
      ok: false,
      integrationId,
      error: "Could not complete authorization with the provider.",
    };
  }
}

interface ExchangeResult {
  accessToken: string;
  refreshToken: string | undefined;
  expiresInSeconds: number;
  grantedScopes: string[];
  metadata: Record<string, string>;
}

async function exchangeCode(
  provider: ProviderDefinition,
  code: string
): Promise<ExchangeResult> {
  // Narrowed here rather than in the signature: the discriminant sits on
  // `provider.auth`, and TypeScript will not narrow the outer object from a
  // nested tag, so a pre-narrowed parameter type would force a cast at
  // every call site instead of one check here.
  const auth = requireOAuth(provider);
  const { clientId, clientSecret } = providerCredentials(provider);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUriFor(provider.name),
    code,
  });

  const json = await postForm(auth.tokenEndpoint, body);
  const parsed = auth.parseTokenResponse(json);

  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresInSeconds: parsed.expiresInSeconds,
    grantedScopes: scopesFromResponse(json),
    metadata: parsed.metadata,
  };
}

/**
 * The scopes a provider says it granted.
 *
 * Providers may grant less than was asked for. Recording their answer rather
 * than our request is what makes the later coverage check meaningful.
 */
function scopesFromResponse(json: unknown): string[] {
  const body = json as Record<string, unknown>;
  const scope = body["scope"];
  if (typeof scope === "string" && scope.trim() !== "") {
    return scope.split(/[\s,]+/).filter((s) => s !== "");
  }
  return [];
}

async function postForm(url: string, body: URLSearchParams): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Body may carry provider detail; log the status only, never the payload.
    throw new Error(`Token endpoint responded ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Return a usable access token, refreshing first if it is near expiry.
 *
 * @throws If no token is stored or the refresh fails, having marked the
 *   integration as needing re-authorization.
 */
export async function getValidToken(
  integrationId: string,
  now = Date.now()
): Promise<StoredToken> {
  const stored = await findToken(integrationId);
  if (stored === undefined) {
    throw new Error("No stored credentials; the integration needs connecting");
  }

  // An API key has no expiry to race, so skip the arithmetic entirely rather
  // than relying on a sentinel date staying far enough in the future.
  if (isNonExpiring(stored)) return stored;

  if (stored.expiresAt.getTime() - now > REFRESH_LEEWAY_MS) {
    return stored;
  }
  return refreshToken(integrationId, stored);
}

export async function refreshToken(
  integrationId: string,
  existing?: StoredToken
): Promise<StoredToken> {
  const stored = existing ?? (await findToken(integrationId));
  if (stored === undefined) {
    throw new Error("No stored credentials to refresh");
  }

  const integration = await findIntegration(integrationId);
  if (integration === undefined) {
    throw new Error("Integration no longer exists");
  }

  const provider = providerRegistry.require(integration.providerName);

  // Unreachable in a normal sync — the engine withholds the refresh callback
  // for providers that cannot refresh — but reachable via a direct call, and a
  // clear message beats "no refresh token available", which reads as a bug.
  if (provider.auth.kind !== "oauth") {
    await updateStatus(integrationId, "requires_reauthorization");
    throw new Error(
      `${provider.label} uses an API key, which cannot be refreshed; re-enter it to reconnect`
    );
  }

  if (stored.refreshToken === undefined) {
    await updateStatus(integrationId, "requires_reauthorization");
    throw new Error("No refresh token available; reconnection required");
  }

  const { clientId, clientSecret } = providerCredentials(provider);

  try {
    const json = await postForm(
      provider.auth.tokenEndpoint,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: stored.refreshToken,
      })
    );

    const parsed = provider.auth.parseTokenResponse(json);
    const granted = scopesFromResponse(json);

    await saveToken({
      integrationId,
      accessToken: parsed.accessToken,
      // Undefined here means "keep the existing one" — see saveToken.
      refreshToken: parsed.refreshToken,
      expiresAt: new Date(Date.now() + parsed.expiresInSeconds * 1000),
      grantedScopes: granted.length > 0 ? granted : stored.grantedScopes,
      metadata: { ...stored.metadata, ...parsed.metadata },
    });

    const refreshed = await findToken(integrationId);
    if (refreshed === undefined) throw new Error("Token vanished after refresh");
    return refreshed;
  } catch (error) {
    console.error(
      `[oauth] Refresh failed for integration ${integrationId}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    await updateStatus(integrationId, "requires_reauthorization");
    throw new Error("Token refresh failed; reconnection required");
  }
}

// ---------------------------------------------------------------------------
// Scope coverage
// ---------------------------------------------------------------------------

export interface ReauthorizationCheck {
  needed: boolean;
  missing: string[];
  /** Functions whose scopes are not covered by the stored grant. */
  uncoveredFunctions: string[];
}

/**
 * Whether the stored grant still covers what this integration now needs.
 *
 * Adding a function widens the requirement past what the user consented to.
 * Detecting it here turns a mid-sync 403 into an explicit reconnect prompt.
 */
export async function checkReauthorization(
  integration: Pick<IntegrationRecord, "id" | "providerName" | "functionNames">
): Promise<ReauthorizationCheck> {
  const stored = await findToken(integration.id);
  if (stored === undefined) {
    return {
      needed: true,
      missing: [],
      uncoveredFunctions: [...integration.functionNames],
    };
  }

  const required = resolveScopes(integration.functionNames, integration.providerName);
  if (scopesAreCovered(stored.grantedScopes, required)) {
    return { needed: false, missing: [], uncoveredFunctions: [] };
  }

  const missing = missingScopes(stored.grantedScopes, required);

  // Name the functions, not just the scopes — "reconnect to add Support" is
  // more use than a list of scope strings.
  const uncoveredFunctions = integration.functionNames.filter((name) => {
    const definition = functionRegistry.get(name);
    const scopes = definition?.scopesByProvider.get(integration.providerName) ?? [];
    return scopes.some((scope) => missing.includes(scope));
  });

  return { needed: true, missing, uncoveredFunctions };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Best-effort revocation at the provider, then local deletion.
 *
 * Returns whether the provider actually confirmed. Deletion must proceed
 * regardless: a provider outage cannot be allowed to strand an integration the
 * user asked to remove. An unconfirmed revocation is flagged on the record for
 * follow-up instead.
 */
export async function revokeTokens(integrationId: string): Promise<boolean> {
  const integration = await findIntegration(integrationId);
  const stored = await findToken(integrationId);

  if (integration === undefined || stored === undefined) return true;

  // Nothing to revoke for an API key: it belongs to the user's account at the
  // provider and is not ours to invalidate. The local copy still goes.
  const provider = providerRegistry.get(integration.providerName);
  if (provider === undefined || provider.auth.kind !== "oauth") return true;
  if (provider.auth.revokeEndpoint === undefined) return true;

  try {
    const token = stored.refreshToken ?? stored.accessToken;
    const response = await fetch(provider.auth.revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    return response.ok;
  } catch (error) {
    console.warn(
      `[oauth] Revocation call failed for integration ${integrationId}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return false;
  }
}
