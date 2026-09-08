/**
 * Mock CRM provider — a full OAuth + sync implementation backed by fixtures.
 *
 * It exists so the whole flow (pick function → consent → map fields → sync) is
 * demonstrable and CI-testable with no credentials and no network. It satisfies
 * the same `ProviderDefinition` and `SyncHandler` contracts as HubSpot and
 * Salesforce — there is no special-casing for it anywhere in core, which is
 * itself a useful check that the extension points are real.
 *
 * Its authorize and token endpoints are routes inside this app.
 */

import type {
  ParsedTokenResponse,
  ProviderDefinition,
} from "../../types/registry";

export const MOCK_PROVIDER_NAME = "mock";

/**
 * Scope names deliberately mirror HubSpot's shape so the consent screen shows
 * something recognisable when demonstrating function-scoped authorization.
 */
export const MOCK_IDENTITY_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.schemas.read",
] as const;

export const MOCK_SUPPORT_SCOPES = [
  "crm.objects.tickets.read",
  "crm.schemas.read",
] as const;

/** Scopes the mock declares for functions we have not built handlers for. */
export const MOCK_BILLING_SCOPES = ["billing.invoices.read"] as const;

export function appBaseUrl(): string {
  const base = process.env["APP_BASE_URL"];
  return base === undefined || base === "" ? "http://localhost:3000" : base;
}

export function isMockEnabled(): boolean {
  return process.env["ENABLE_MOCK_PROVIDER"] === "true";
}

export const mockProvider: ProviderDefinition = {
  name: MOCK_PROVIDER_NAME,
  label: "Mock CRM",
  description:
    "A built-in fake CRM with sample companies and contacts. Needs no credentials — use it to try the flow end to end.",

  auth: {
    kind: "oauth",

    get authorizeEndpoint(): string {
      return `${appBaseUrl()}/api/oauth/mock/authorize`;
    },
    get tokenEndpoint(): string {
      return `${appBaseUrl()}/api/oauth/mock/token`;
    },
    get revokeEndpoint(): string {
      return `${appBaseUrl()}/api/oauth/mock/revoke`;
    },

    clientIdEnv: "MOCK_CLIENT_ID",
    clientSecretEnv: "MOCK_CLIENT_SECRET",

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
        throw new Error("Mock token response has no access_token");
      }
      const refreshToken = body["refresh_token"];
      const expiresIn = body["expires_in"];

      return {
        accessToken,
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
        // Short on purpose, so proactive refresh is exercisable in a demo.
        expiresInSeconds: typeof expiresIn === "number" ? expiresIn : 900,
        metadata: { mock: "true" },
      };
    },
  },
};
