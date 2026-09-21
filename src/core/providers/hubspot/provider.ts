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

/**
 * Scopes for the agreement function. HubSpot models a commercial agreement as
 * a deal, so this is the deals object plus its schema — the same pairing
 * identity needs, and for the same reason: without the schema scope the
 * mapping editor has nothing to offer as a source field.
 *
 * Granular like support, so adding agreement to a live HubSpot integration
 * genuinely widens the request and triggers re-consent.
 */
export const HUBSPOT_AGREEMENT_SCOPES = [
  "crm.objects.deals.read",
  "crm.schemas.deals.read",
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

  // Object ids are per-portal integers. Company `12345` exists in most portals
  // and they are unrelated businesses, so an unscoped `hubspot:12345` key would
  // merge them.
  externalIdScope: "tenant",

  /**
   * Undefined until the portal id is captured, and that is the safe state.
   *
   * HubSpot's token response carries no `hub_id`; it is only available by
   * calling `/oauth/v1/access-tokens/{token}` after the exchange, which
   * `parseTokenResponse` cannot do — it is handed a parsed body, not a client.
   * Adding that call belongs with the change that needs it.
   *
   * Until then no HubSpot company contributes its own id as an identity key.
   * HubSpot still joins on domain, which it supplies for nearly every company,
   * and on its contacts' emails.
   */
  tenantScopeValue(metadata) {
    return metadata["hubId"];
  },
};
