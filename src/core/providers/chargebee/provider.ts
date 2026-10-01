/**
 * Chargebee provider definition.
 *
 * Chargebee authenticates via an API key passed in HTTP Basic Auth username
 * against site-specific API endpoints (`https://{site}.chargebee.com`).
 * Credentials are input as `site:api_key`.
 *
 * Docs: https://apidocs.chargebee.com/v2/#authentication
 */

import { InvalidApiKeyError } from "../../credentials/errors";
import type {
  ApiKeyProviderAuth,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";
import { asArray, asRecord } from "../http";
import {
  chargebeeAuthHeaders,
  customersUrl,
  parseChargebeeCredential,
} from "./api";

export const CHARGEBEE_PROVIDER_NAME = "chargebee";

/**
 * Scope strings for Chargebee identity function.
 */
export const CHARGEBEE_IDENTITY_SCOPES = [
  "customers:read",
  "contacts:read",
] as const;

/**
 * Scope strings for the Chargebee catalog function.
 *
 * These are *symbolic*, not OAuth scopes: Chargebee authenticates with an API
 * key (HTTP Basic), so there is nothing to grant and nothing enforced. The list
 * feeds the provider picker and the "what this sync reads" copy, which is why
 * it has to name the endpoints the handler actually calls — the last two were
 * missing while the catalog handler already called `/features` and
 * `/item_entitlements`, which made the list quietly false.
 */
export const CHARGEBEE_CATALOG_SCOPES = [
  "item_families:read",
  "items:read",
  "item_prices:read",
  "features:read",
  "item_entitlements:read",
] as const;

/**
 * Scope strings for the Chargebee agreement function.
 *
 * Symbolic, like the catalog list above — see its comment. The first two are
 * what the handler actually reads; the second two are listed because
 * subscription entitlements are meaningless without the feature definitions
 * they reference, which belong to the catalog function.
 */
export const CHARGEBEE_AGREEMENT_SCOPES = [
  "subscriptions:read",
  "subscription_entitlements:read",
  "features:read",
  "item_entitlements:read",
] as const;

/**
 * Scope strings for the Chargebee billing function.
 *
 * Symbolic like the others — Chargebee uses an API key, so nothing is granted
 * or enforced — but they name the two resources the handler actually reads:
 * `/invoices` (which inlines its lines) and `/transactions`.
 */
export const CHARGEBEE_BILLING_SCOPES = [
  "invoices:read",
  "transactions:read",
] as const;

/** Cap on connect-time probe timeout. */
const PROBE_TIMEOUT_MS = 15_000;

const chargebeeAuth: ApiKeyProviderAuth = {
  kind: "apiKey",
  header: "Authorization",

  instructions:
    "In Chargebee, open Settings → Configure Chargebee → API Keys to create a Read-Only API Key. Enter your credential in the format 'site:api_key' (e.g. 'my-site-test:chb_123456789').",
  placeholder: "site:chb_...",

  validateKeyShape(credential: string): string | undefined {
    if (credential.trim() === "") {
      return "Paste your Chargebee credential as site:api_key.";
    }
    if (/\s/.test(credential.trim())) {
      return "That looks like more than a key — paste just the site:api_key value.";
    }
    const { site, apiKey } = parseChargebeeCredential(credential);
    if (site === undefined || site === "" || apiKey === "") {
      return "Enter your Chargebee credential in the format site:api_key (e.g. my-site-test:chb_12345).";
    }
    return undefined;
  },

  async probeCredential(credential: string): Promise<ProviderMetadata> {
    const { site, apiKey } = parseChargebeeCredential(credential);
    if (site === undefined || site === "" || apiKey === "") {
      throw new InvalidApiKeyError(
        "Invalid Chargebee credential format. Expected 'site:api_key'."
      );
    }

    const response = await fetch(customersUrl(site, 1), {
      method: "GET",
      headers: {
        ...chargebeeAuthHeaders(credential),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      throw new InvalidApiKeyError("Chargebee rejected the key");
    }
    if (!response.ok) {
      throw new Error(`Chargebee probe returned ${response.status}`);
    }

    const json = await response.json();
    const data = asArray(asRecord(json)?.["list"]);

    return {
      site,
      hasCustomers: String(data.length > 0),
    };
  },
};

export const chargebeeProvider: ProviderDefinition = {
  name: CHARGEBEE_PROVIDER_NAME,
  label: "Chargebee",
  description:
    "Sync customers and billing contacts from Chargebee. Authenticates with a Site Name and API Key.",

  auth: chargebeeAuth,

  // Customer IDs are scoped to a Chargebee site instance.
  externalIdScope: "tenant",

  tenantScopeValue(metadata: ProviderMetadata): string | undefined {
    const site = metadata["site"]?.trim();
    return site === "" ? undefined : site;
  },
};
