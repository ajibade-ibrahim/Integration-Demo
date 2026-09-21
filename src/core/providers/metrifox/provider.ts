/**
 * Metrifox provider definition.
 *
 * The first API-key provider here: a single static `x-api-key` header, no
 * consent screen, no refresh, no revocation. Everything downstream of the
 * credential — pagination, field mapping, the sync engine, the failure policy —
 * is identical to the OAuth providers. That is the point of holding the
 * credential kind in the definition rather than branching on provider name.
 *
 * Docs: https://docs.metrifox.com/api-reference/authentication
 */

import { InvalidApiKeyError } from "../../credentials/errors";
import type {
  ApiKeyProviderAuth,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";
import { asRecord } from "../http";
import { customersUrl } from "./api";

export const METRIFOX_PROVIDER_NAME = "metrifox";

/**
 * Scope strings for a provider that has no scopes.
 *
 * Metrifox authenticates with one static key and has no consent screen, so
 * nothing here is ever transmitted. They are declared anyway because the
 * function registry is how this platform states *what a function reads from a
 * provider*, and showing a user "customers:read, contacts:read" before they
 * connect is the same promise the OAuth providers make — kept by a different
 * mechanism. Naming them after the API paths keeps it checkable.
 *
 * Non-empty is also load-bearing: `resolveScopes` throws on an empty list and
 * `providerNamesForFunction` filters them out, so a scopeless provider would be
 * invisible in the picker.
 */
export const METRIFOX_IDENTITY_SCOPES = [
  "customers:read",
  "contacts:read",
] as const;

/**
 * Scopes for the agreement function, named after the API paths the way the
 * identity set is.
 *
 * Metrifox is the provider that carries both shapes — `orders` for the
 * committed, order-form side and `subscriptions` for the recurring one —
 * which is the case the single agreement model has to absorb without forking.
 */
export const METRIFOX_AGREEMENT_SCOPES = [
  "orders:read",
  "subscriptions:read",
] as const;

/** Cap on the connect-time probe, so a hung provider cannot wedge the request. */
const PROBE_TIMEOUT_MS = 15_000;

const metrifoxAuth: ApiKeyProviderAuth = {
  kind: "apiKey",
  header: "x-api-key",

  instructions:
    "In Metrifox, open Developers → API Keys and create a key with read access to customers. Paste it below: it is encrypted before it is stored, and never shown again.",
  placeholder: "sk_test_…",

  /**
   * Deliberately not checking the key's format.
   *
   * The docs advertise `sk_test_…`/`sk_live_…`, but real dashboard keys do not
   * all look like that, and a prefix check rejected a valid key before it could
   * reach the network. Since `probeCredential` below settles the question
   * authoritatively against the live API, a local format guess can only produce
   * false negatives — so the only checks left are the ones that are true of any
   * credential regardless of issuer.
   *
   * The cost is real and worth stating: nothing here can now tell a test key
   * from a production one, so the environment a key reaches is not something
   * this platform can determine or enforce.
   */
  validateKeyShape(key: string): string | undefined {
    if (key === "") return "Paste your Metrifox API key.";
    if (/\s/.test(key)) {
      // By far the commonest paste mistake is a whole curl command.
      return "That looks like more than a key — paste just the key value.";
    }
    return undefined;
  },

  async probeCredential(key: string): Promise<ProviderMetadata> {
    // Deliberately not through `createProviderSession`: that client's job is
    // the in-run failure policy — refresh, rate-limit waits, run-level retries
    // — none of which applies to a one-shot check. A rejected key has to come
    // back as a rejection, not as a retryable sync error.
    const response = await fetch(customersUrl(1, 1), {
      method: "GET",
      headers: { "x-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError("Metrifox rejected the key");
    }
    if (!response.ok) {
      // Status only, never the body — it may echo the request.
      throw new Error(`Metrifox probe returned ${response.status}`);
    }

    const meta = asRecord(asRecord(await response.json())?.["meta"]);
    const total = meta?.["total_records"];

    // Non-secret, and worth having: "connected, 0 customers visible" is a very
    // different diagnosis from "connected".
    return typeof total === "number" ? { customersVisible: String(total) } : {};
  },
};

export const metrifoxProvider: ProviderDefinition = {
  name: METRIFOX_PROVIDER_NAME,
  label: "Metrifox",
  description:
    "Sync customers and their contact people from Metrifox. Authenticates with an API key — there is no OAuth app to register.",

  auth: metrifoxAuth,

  // Ids like `MF-ACME` are chosen inside one Metrifox account, so two accounts
  // can each have their own `MF-ACME`.
  externalIdScope: "tenant",

  /**
   * Always undefined today, deliberately.
   *
   * The Metrifox API exposes no endpoint naming the account a key belongs to —
   * `probeCredential` can only report how many customers are visible. So no
   * Metrifox customer contributes its own id as an identity key, and Metrifox
   * joins on email and domain alone.
   *
   * Not scoped by `integrationId` instead, which would be available: a
   * `Customer` row already belongs to exactly one integration, so a key scoped
   * that way could only ever match the single record that emitted it. It would
   * add rows and no joins.
   *
   * The key it *supplies* is unaffected — a Metrifox record mapping
   * `crossRef.stripe` names a globally unique Stripe id, and that is the join
   * the spec actually asks for.
   */
  tenantScopeValue(metadata) {
    return metadata["accountId"];
  },
};
