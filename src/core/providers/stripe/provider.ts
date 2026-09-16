/**
 * Stripe provider definition.
 *
 * The second API-key provider, and the one that tests whether the credential
 * kind really is an abstraction: Stripe puts its key in `Authorization: Bearer`
 * rather than a custom header, and pins an API version alongside it. Both are
 * absorbed by `authHeaders` on the session options — no branching on provider
 * name anywhere downstream.
 *
 * Docs: https://docs.stripe.com/api/authentication
 */

import { InvalidApiKeyError } from "../../credentials/errors";
import type {
  ApiKeyProviderAuth,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";
import { asArray, asRecord } from "../http";
import { customersUrl, stripeAuthHeaders } from "./api";

export const STRIPE_PROVIDER_NAME = "stripe";

/**
 * Scope strings for a provider that has no scopes.
 *
 * Stripe authenticates with one key and has no consent screen, so nothing here
 * is ever transmitted. It is declared anyway because the function registry is
 * how this platform states *what a function reads from a provider*, and it is
 * shown to the user verbatim before they connect. Naming it after the API path
 * keeps it checkable; it corresponds to the "Customers — read" permission on a
 * Stripe restricted key.
 *
 * `contacts:read` is deliberately absent, and the contrast with Metrifox is the
 * reason: Metrifox declares it because contact people arrive inside the customer
 * payload, so contact data really is read. Stripe has no contact resource at
 * all — ours are fabricated from fields of the customer — so claiming to read
 * contacts would be claiming to read something that does not exist.
 *
 * Non-empty is also load-bearing: `resolveScopes` throws on an empty list and
 * `providerNamesForFunction` filters them out, so a scopeless provider would be
 * invisible in the picker.
 */
export const STRIPE_IDENTITY_SCOPES = ["customers:read"] as const;

/**
 * Scopes for the agreement function.
 *
 * Subscriptions only. Stripe also exposes `quotes`, but a quote is a
 * pre-agreement offer — the canonical model has it converting *to* an
 * agreement rather than being one — so reading it is a claim to make when
 * proposal/quote is modelled, not now.
 */
export const STRIPE_AGREEMENT_SCOPES = ["subscriptions:read"] as const;

/**
 * Scopes for the catalog function.
 *
 * Two, because Stripe splits what we model as one catalog across two resources:
 * a `product` is the thing, a `price` is what it costs. Reading one without the
 * other is not useful — a product with no price is not sellable and a price
 * with no product has nothing to name it — so they are always requested
 * together rather than as separate functions.
 *
 * Disjoint from the identity set, which is what makes scope isolation visible
 * here: authorizing for catalog alone must never ask for `customers:read`.
 */
export const STRIPE_CATALOG_SCOPES = ["products:read", "prices:read"] as const;

/** Cap on the connect-time probe, so a hung provider cannot wedge the request. */
const PROBE_TIMEOUT_MS = 15_000;

const stripeAuth: ApiKeyProviderAuth = {
  kind: "apiKey",
  // Documentation only — the credential itself is applied by
  // `stripeAuthHeaders`, which prefixes it with "Bearer ". The two must not
  // drift, which is why this file imports that function rather than
  // constructing headers of its own.
  header: "Authorization",

  instructions:
    "Use a Stripe secret or restricted key with read access to customers. From the dashboard: Developers → API keys. Or, with no Stripe account at all, run `stripe sandbox create --from-git` and paste the `secret_key` it prints. It is encrypted before it is stored, and never shown again.",
  placeholder: "sk_test_…",

  /**
   * Deliberately not checking that the key starts with anything in particular.
   *
   * Stripe hands out at least four shapes for the same job: `sk_test_…` and
   * `sk_live_…` from the dashboard, `rk_…` for restricted keys, and `rkcs_test_…`
   * from `stripe sandbox create`. An allow-list of prefixes would reject a
   * perfectly good key before it could reach the network, and since
   * `probeCredential` settles the question authoritatively against the live API,
   * a local format guess can only produce false negatives.
   *
   * `pk_` is the exception, and it is a different kind of check. A publishable
   * key cannot authenticate an API request under any circumstances, so this is
   * a true negative rather than a guess — and it is the single commonest
   * mix-up, because both keys sit side by side in the dashboard.
   *
   * The cost is the same one Metrifox accepts: nothing here can tell a test key
   * from a live one, so the environment a key reaches is not something this
   * platform can determine or enforce.
   */
  validateKeyShape(key: string): string | undefined {
    if (key === "") return "Paste your Stripe API key.";
    if (/\s/.test(key)) {
      // By far the commonest paste mistake is a whole curl command.
      return "That looks like more than a key — paste just the key value.";
    }
    if (key.startsWith("pk_")) {
      return "That is a publishable key. Paste a secret key (sk_…) or a restricted key (rk_…) instead.";
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
      headers: { ...stripeAuthHeaders(key), Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    // 403 as well as 401, because a restricted key with the wrong permissions
    // is a key problem the user can fix, not a transient one. Telling them to
    // try again would be advice that can never work.
    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError("Stripe rejected the key");
    }
    if (!response.ok) {
      // Status only, never the body — it may echo the request.
      throw new Error(`Stripe probe returned ${response.status}`);
    }

    // Stripe's list endpoints carry no total count, so there is no analogue of
    // Metrifox's `customersVisible`. Whether *any* customer is visible is still
    // worth recording: "connected, no customers" is a very different diagnosis
    // from "connected".
    //
    // None of these keys may be `authKind`, `keyPrefix` or `keyLast4` — the
    // credential service spreads this map over those, and `authKind` is what
    // keeps an API key off the token-refresh path.
    const data = asArray(asRecord(await response.json())?.["data"]);
    return { hasCustomers: String(data.length > 0) };
  },
};

export const stripeProvider: ProviderDefinition = {
  name: STRIPE_PROVIDER_NAME,
  label: "Stripe",
  description:
    "Sync customers from Stripe, with a billing contact derived from each customer's own name and email. Authenticates with an API key — there is no OAuth app to register.",

  auth: stripeAuth,

  // `cus_…` ids are unique across all of Stripe, so one names the same customer
  // no matter which account holds the key that reads it. That is what makes the
  // Metrifox → Stripe crosswalk work: a Metrifox record can name a Stripe
  // customer id and the reference resolves without either side agreeing on a
  // tenant.
  externalIdScope: "global",
};
