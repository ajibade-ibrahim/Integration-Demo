/**
 * Slack provider definition.
 *
 * Docs: https://api.slack.com/authentication/oauth-v2
 *
 * Slack connects with a **user token only**. There is no bot scope and no
 * `chat:write`: the connection can read exactly the conversations the
 * authorizing teammate can see, and nothing else. That is the whole privacy
 * model — a customer conversation is data the teammate already has, not a new
 * grant.
 *
 * Three quirks make this file longer than Gmail's:
 *
 *   1. Slack reports failures as HTTP 200 with `{ ok: false, error }`. The
 *      exchange and metadata calls check `ok` explicitly rather than relying on
 *      the status code.
 *   2. The user token is nested under `authed_user`. The top-level token is the
 *      bot's, and using it would silently grant bot visibility instead.
 *   3. User-scope grants live in `authed_user.scope`, while the top-level
 *      `scope` describes the bot. Recording the wrong one would make every
 *      connection look permanently under-scoped, so the parser states the
 *      granted list explicitly and the OAuth service prefers it.
 */

import type {
  ParsedTokenResponse,
  ProviderDefinition,
  ProviderMetadata,
} from "../../types/registry";
import { asRecord, asString } from "../http";

export const SLACK_PROVIDER_NAME = "slack";

/** User scopes for the communication function. No bot scopes, deliberately. */
export const SLACK_COMMUNICATION_SCOPES = [
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "users:read.email",
] as const;

const SLACK_API = "https://slack.com/api";
const AUTHORIZE_ENDPOINT = "https://slack.com/oauth/v2/authorize";
const TOKEN_ENDPOINT = `${SLACK_API}/oauth.v2.access`;
const REVOKE_ENDPOINT = `${SLACK_API}/auth.revoke`;

/**
 * Ten years, in seconds.
 *
 * Used when token rotation is off. Slack then issues a token with no expiry and
 * no refresh token; a far-future date keeps `getValidToken` from trying to
 * refresh a credential that has nothing to exchange. This is the same local
 * pattern as `NON_EXPIRING_AT`, without reusing `isNonExpiring`, which is keyed
 * off the API-key metadata rather than a date.
 */
const FAR_FUTURE_SECONDS = 10 * 365 * 24 * 60 * 60;

const TIMEOUT_MS = 15_000;

function parseExpiresIn(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return FAR_FUTURE_SECONDS;
}

function splitScopes(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

function slackError(body: Record<string, unknown>): string {
  return asString(body["error"]) ?? "unknown_error";
}

async function readSlackJson(response: Response): Promise<Record<string, unknown>> {
  const body = asRecord(await response.json());
  if (body === undefined) {
    throw new Error(`Slack responded ${response.status} with a non-object body`);
  }
  return body;
}

async function revokeOne(token: string): Promise<boolean> {
  try {
    const url = new URL(REVOKE_ENDPOINT);
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return false;

    const body = await readSlackJson(response);
    // `revoked` is the provider's confirmation. `ok: true` alone only says the
    // request was understood.
    return body["ok"] === true && body["revoked"] === true;
  } catch {
    return false;
  }
}

async function fetchSlackUserMetadata(
  accessToken: string
): Promise<ProviderMetadata> {
  const authResponse = await fetch(`${SLACK_API}/auth.test`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const auth = await readSlackJson(authResponse);
  if (auth["ok"] !== true) {
    throw new Error(`Slack auth.test failed: ${slackError(auth)}`);
  }

  const teamId = asString(auth["team_id"]);
  const userId = asString(auth["user_id"]);
  const teamName = asString(auth["team"]);
  const enterpriseId = asString(auth["enterprise_id"]);

  const metadata: ProviderMetadata = {
    ...(teamId === undefined ? {} : { teamId }),
    ...(teamName === undefined ? {} : { teamName }),
    ...(userId === undefined ? {} : { userId }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
  };

  if (userId === undefined) return metadata;

  // The identity facts are best-effort: a token scoped without `users:read.email`
  // still works for every conversation read, and losing the mailbox exclusion
  // is recoverable (the handler resolves the address again when it can). A
  // failed auth.test, by contrast, means the credential itself is unusable and
  // must surface.
  try {
    const url = new URL(`${SLACK_API}/users.info`);
    url.searchParams.set("user", userId);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readSlackJson(response);
    if (body["ok"] !== true) return metadata;

    const user = asRecord(body["user"]);
    const profile = asRecord(user?.["profile"]);
    const email = asString(profile?.["email"]);
    const name =
      asString(profile?.["real_name"]) ??
      asString(profile?.["display_name"]) ??
      asString(user?.["real_name"]) ??
      asString(user?.["name"]);

    return {
      ...metadata,
      ...(email === undefined ? {} : { email }),
      ...(name === undefined ? {} : { name }),
    };
  } catch {
    return metadata;
  }
}

export const slackProvider: ProviderDefinition = {
  name: SLACK_PROVIDER_NAME,
  label: "Slack",
  description:
    "Read customer conversations from shared channels and external DMs, attributed to the customers you map them to.",

  auth: {
    kind: "oauth",

    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    revokeEndpoint: REVOKE_ENDPOINT,

    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",

    buildAuthorizeParams({ clientId, redirectUri, scopes, state }) {
      // `user_scope`, not `scope`: this is a user-token connection. Sending
      // `scope` would ask for bot permissions the app does not use and would
      // make the token response's bot fields look meaningful.
      return new URLSearchParams({
        client_id: clientId,
        user_scope: scopes.join(","),
        redirect_uri: redirectUri,
        state,
        response_type: "code",
      });
    },

    parseTokenResponse(json: unknown): ParsedTokenResponse {
      const body = asRecord(json);
      if (body === undefined) {
        throw new Error("Slack token response is not an object");
      }
      if (body["ok"] !== true) {
        throw new Error(`Slack token exchange failed: ${slackError(body)}`);
      }

      const authed = asRecord(body["authed_user"]);
      const authedToken = asString(authed?.["access_token"]);
      const topLevelToken = asString(body["access_token"]);
      const tokenType = asString(body["token_type"]);

      // A rotation refresh returns the user token at the top level with
      // `token_type: "user"`. A connect response normally nests it under
      // `authed_user`. The top-level bot token is never accepted: it would read
      // the app's visibility rather than the teammate's.
      const usedTopLevelUserToken = authedToken === undefined;
      const accessToken = authedToken ?? (tokenType === "user" ? topLevelToken : undefined);
      if (accessToken === undefined) {
        throw new Error(
          "Slack token response has no user access token; the app must request user scopes"
        );
      }

      const refreshToken =
        asString(authed?.["refresh_token"]) ??
        (usedTopLevelUserToken ? asString(body["refresh_token"]) : undefined);

      const team = asRecord(body["team"]);
      const enterprise = asRecord(body["enterprise"]);
      const teamId = asString(team?.["id"]);
      const teamName = asString(team?.["name"]);
      const userId = asString(authed?.["id"]);
      const enterpriseId = asString(enterprise?.["id"]);

      // An empty list is meaningful: Slack supplied no user-scope information,
      // and the OAuth service must not fall back to the bot's top-level scope.
      // On connect the empty list becomes the requested scopes; on refresh it
      // becomes the stored grant.
      const scopes =
        authed?.["scope"] !== undefined
          ? splitScopes(asString(authed["scope"]))
          : usedTopLevelUserToken
            ? splitScopes(asString(body["scope"]))
            : [];

      return {
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        expiresInSeconds: parseExpiresIn(
          authed?.["expires_in"] ?? body["expires_in"]
        ),
        metadata: {
          ...(teamId === undefined ? {} : { teamId }),
          ...(teamName === undefined ? {} : { teamName }),
          ...(userId === undefined ? {} : { userId }),
          ...(enterpriseId === undefined ? {} : { enterpriseId }),
        },
        grantedScopes: scopes,
      };
    },

    resolveTokenMetadata: fetchSlackUserMetadata,

    async revokeCredential({ accessToken, refreshToken }) {
      // Both tokens are revoked because Slack revokes one per call, and a live
      // refresh token can mint a new access token after the access token is
      // gone. Attempting both even after one fails is the only way to leave the
      // smallest possible grant behind.
      const accessRevoked = await revokeOne(accessToken);
      const refreshRevoked =
        refreshToken === undefined ? true : await revokeOne(refreshToken);
      return accessRevoked && refreshRevoked;
    },
  },

  externalIdScope: "tenant",

  tenantScopeValue(metadata) {
    return metadata["teamId"];
  },
};
