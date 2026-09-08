/**
 * HubSpot provider definition.
 *
 * Docs: https://developers.hubspot.com/docs/api/working-with-oauth
 */

import type {
  ParsedTokenResponse,
  ProviderDefinition,
} from "../../types/registry";

export const HUBSPOT_PROVIDER_NAME = "hubspot";

/**
 * Scopes for the identity function.
 *
 * The two `crm.schemas.*` scopes are not incidental: they are what make
 * `/crm/v3/properties/{object}` readable, and that endpoint is how the mapping
 * editor discovers which fields a user can map from. Without them the mapping
 * UI has an empty source dropdown.
 */
export const HUBSPOT_IDENTITY_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.schemas.companies.read",
  "crm.schemas.contacts.read",
] as const;

/**
 * Scopes for the support function. Granular and disjoint from the identity set
 * — an integration serving both asks for the union, one serving only identity
 * must never request ticket access.
 */
export const HUBSPOT_SUPPORT_SCOPES = [
  "tickets",
  "crm.objects.tickets.read",
  "crm.schemas.tickets.read",
] as const;

export const hubspotProvider: ProviderDefinition = {
  name: HUBSPOT_PROVIDER_NAME,
  label: "HubSpot",
  description: "Sync companies and contacts from a HubSpot CRM account.",

  auth: {
    kind: "oauth",

    authorizeEndpoint: "https://app.hubspot.com/oauth/authorize",
    tokenEndpoint: "https://api.hubapi.com/oauth/v1/token",
    // HubSpot revokes by refresh token in the path, so the id is appended at call time.
    revokeEndpoint: "https://api.hubapi.com/oauth/v1/refresh-tokens",

    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",

    buildAuthorizeParams({ clientId, redirectUri, scopes, state }) {
      return new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        response_type: "code",
      });
    },

    parseTokenResponse(json: unknown): ParsedTokenResponse {
      const body = json as Record<string, unknown>;
      const accessToken = body["access_token"];
      if (typeof accessToken !== "string") {
        throw new Error("HubSpot token response has no access_token");
      }
      const refreshToken = body["refresh_token"];
      const expiresIn = body["expires_in"];

      return {
        accessToken,
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
        // HubSpot access tokens are 30 minutes; fall back to that if absent.
        expiresInSeconds: typeof expiresIn === "number" ? expiresIn : 1800,
        metadata: {},
      };
    },
  },
};
