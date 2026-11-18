/**
 * Gmail provider definition.
 *
 * Docs: https://developers.google.com/gmail/api/auth/web-server
 *
 * `gmail.readonly` is a restricted scope: outside test-user mode Google
 * requires OAuth verification/CASA. That is a deployment prerequisite, not a
 * code workaround.
 */

import type {
  ParsedTokenResponse,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";

export const GMAIL_PROVIDER_NAME = "gmail";

export const GMAIL_COMMUNICATION_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

async function fetchGoogleUserMetadata(
  accessToken: string
): Promise<ProviderMetadata> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Google userinfo responded ${response.status}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const email = body["email"];
  if (typeof email !== "string" || email.trim() === "") {
    throw new Error("Google userinfo response has no email");
  }

  const name = body["name"];
  return {
    email: email.trim(),
    ...(typeof name === "string" && name.trim() !== ""
      ? { name: name.trim() }
      : {}),
  };
}

export const gmailProvider: ProviderDefinition = {
  name: GMAIL_PROVIDER_NAME,
  label: "Gmail",
  description: "Sync read-only email communication from a Gmail mailbox.",

  auth: {
    kind: "oauth",

    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revokeEndpoint: "https://oauth2.googleapis.com/revoke",

    clientIdEnv: "GMAIL_CLIENT_ID",
    clientSecretEnv: "GMAIL_CLIENT_SECRET",

    buildAuthorizeParams({ clientId, redirectUri, scopes, state }) {
      return new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
      });
    },

    parseTokenResponse(json: unknown): ParsedTokenResponse {
      const body = json as Record<string, unknown>;
      const accessToken = body["access_token"];
      if (typeof accessToken !== "string") {
        throw new Error("Google token response has no access_token");
      }

      const refreshToken = body["refresh_token"];
      const expiresIn = body["expires_in"];
      const expiresInSeconds =
        typeof expiresIn === "number"
          ? expiresIn
          : typeof expiresIn === "string" && /^\d+$/.test(expiresIn)
            ? Number.parseInt(expiresIn, 10)
            : 3600;

      return {
        accessToken,
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
        expiresInSeconds,
        metadata: {},
      };
    },

    // Captured once at connect time for the tenant scope and the mailbox-owner
    // exclusion. Failure is non-fatal; the handler can ask Gmail's profile
    // endpoint under gmail.readonly when this data is absent.
    resolveTokenMetadata: fetchGoogleUserMetadata,
  },

  externalIdScope: "tenant",

  tenantScopeValue(metadata) {
    return metadata["email"];
  },
};
