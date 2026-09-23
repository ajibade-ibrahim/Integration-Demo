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

export const CHARGEBEE_CATALOG_SCOPES = [
  "item_families:read",
  "items:read",
  "item_prices:read",
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
