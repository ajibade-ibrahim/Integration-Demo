/**
 * Stigg provider definition.
 *
 * The fourth API-key provider, and the one that exercises the credential kind
 * with a custom header name again (`X-API-KEY`, like Metrifox's `x-api-key`)
 * rather than Stripe's `Authorization: Bearer`. Nothing downstream of the
 * credential changes: pagination, field mapping, the sync engine and the
 * failure policy are the same code every other provider runs.
 *
 * Docs: https://docs.stigg.io/api (Integrations → API keys issues the server
 * key this provider authenticates with).
 */

import { InvalidApiKeyError } from "../../credentials/errors";
import type {
  ApiKeyProviderAuth,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";
import { customersUrl } from "./api";

export const STIGG_PROVIDER_NAME = "stigg";

/**
 * Scope strings for a provider that has no consent screen.
 *
 * Stigg authenticates with one static server key and exposes no OAuth scopes,
 * so nothing here is ever transmitted. It is declared anyway because the
 * function registry is how this platform states *what a function reads from a
 * provider*, and the picker shows it before a user connects. Naming it after
 * the API path keeps it checkable.
 *
 * `contacts:read` is deliberately absent: Stigg has no contact resource at all,
 * and ours are fabricated from fields on the customer — the same distinction
 * Stripe's scope list draws. Only `customers:read` is true.
 *
 * Non-empty is also load-bearing: `resolveScopes` throws on an empty list and
 * `providerNamesForFunction` filters empty lists out, so a scopeless provider
 * would be invisible in the picker.
 */
export const STIGG_IDENTITY_SCOPES = ["customers:read"] as const;

/**
 * Scope strings for the catalog function.
 *
 * Named after the resources the catalog handler actually reads, one per
 * endpoint family, and deliberately disjoint from `customers:read`: that is
 * what keeps the scope-isolation property ("authorizing catalog must never
 * request customers:read") observable rather than a formality.
 *
 * Like the identity set, none of these is transmitted — Stigg has no consent
 * screen — but they are what the picker shows before a user connects, and they
 * record what the function reads.
 */
export const STIGG_CATALOG_SCOPES = [
  "products:read",
  "plans:read",
  "addons:read",
  "features:read",
  "charges:read",
  "entitlements:read",
] as const;

/**
 * Scope strings for the agreement function.
 *
 * One, because the whole function is one endpoint: the subscription list
 * carries the plan, the addons, the price overrides, the coupons and the dates
 * inline. Deliberately disjoint from the identity and catalog sets, so the same
 * scope-isolation property holds for a third function.
 *
 * `entitlements:read` is absent even though `STIGG_CATALOG_SCOPES` carries it:
 * the agreement handler writes no entitlement rows at all (Stigg's REST API
 * exposes no per-subscription effective entitlement values — see
 * `agreement-handler.ts`), so claiming it here would be a scope for a read this
 * function never makes.
 */
export const STIGG_AGREEMENT_SCOPES = ["subscriptions:read"] as const;

/** Cap on the connect-time probe, so a hung provider cannot wedge the request. */
const PROBE_TIMEOUT_MS = 15_000;

const stiggAuth: ApiKeyProviderAuth = {
  kind: "apiKey",
  // Documentation only — the credential itself is applied by the session's
  // `authHeaders`. The two must not drift, which is why this is the same
  // spelling `STIGG_SESSION_OPTIONS` uses.
  header: "X-API-KEY",

  instructions:
    "In Stigg, open Integrations → API keys for the right environment and copy a server key (Full access, or a scoped read-only key). Paste it below — it is encrypted before it is stored.",
  placeholder: "server-…",

  /**
   * Rejects only the one documented true negative, plus the universal paste
   * mistakes.
   *
   * Stigg issues two key kinds: server keys (`server-…`), which authenticate
   * API requests, and publishable keys (`client-…`), which are frontend-only
   * and cannot authenticate anything. Rejecting `client-…` is therefore a fact
   * rather than a format guess — the same role `pk_` plays for Stripe.
   *
   * Nothing else is checked. Stigg does not document any other shape, and
   * `probeCredential` settles the question authoritatively against the live
   * API, so a local guess about a key's middle could only produce false
   * negatives. The cost is the one every API-key provider here accepts:
   * nothing local can tell a test key from a production one.
   */
  validateKeyShape(key: string): string | undefined {
    if (key === "") return "Paste your Stigg API key.";
    if (/\s/.test(key)) {
      // By far the commonest paste mistake is a whole curl command.
      return "That looks like more than a key — paste just the key value.";
    }
    if (key.startsWith("client-")) {
      return "That is a publishable key. Paste a server key (server-…) instead.";
    }
    return undefined;
  },

  async probeCredential(key: string): Promise<ProviderMetadata> {
    // Deliberately not through `createProviderSession`: that client's job is
    // the in-run failure policy — refresh, rate-limit waits, run-level retries
    // — none of which applies to a one-shot check. A rejected key has to come
    // back as a rejection, not as a retryable sync error.
    const response = await fetch(customersUrl(1), {
      method: "GET",
      headers: { "X-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    // 403 as well as 401: a server key scoped without customer read is a key
    // problem the user can fix, not a transient one.
    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError("Stigg rejected the key");
    }
    if (!response.ok) {
      // Status only, never the body — it may echo the request.
      throw new Error(`Stigg probe returned ${response.status}`);
    }

    // The customers list carries no total count worth keeping, and the
    // response body is not read at all.
    return {};
  },
};

export const stiggProvider: ProviderDefinition = {
  name: STIGG_PROVIDER_NAME,
  label: "Stigg",
  description:
    "Sync customers from Stigg, with a billing contact derived from each customer's own name and email. Authenticates with an API key — there is no OAuth app to register.",

  auth: stiggAuth,

  // Stigg customer ids are chosen slugs inside one Stigg environment, so two
  // environments can each own `customer-6e24b4`.
  externalIdScope: "tenant",

  /**
   * Always undefined today, deliberately.
   *
   * The Stigg list API never reveals which environment a key belongs to, so no
   * Stigg customer contributes its own id as an identity key and Stigg joins on
   * email and cross-references alone. This is Metrifox's honest state, arrived
   * at the same way.
   *
   * Not scoped by `integrationId` instead, which would be available: a
   * `Customer` row already belongs to exactly one integration, so a key scoped
   * that way could only ever match the single record that emitted it. It would
   * add rows and no joins.
   *
   * The key it *supplies* is unaffected — a Stigg record mapping
   * `crossRef.stripe` names a globally unique Stripe id, and that is the join
   * the spec actually asks for.
   */
  tenantScopeValue(metadata) {
    return metadata["environmentId"];
  },
};
