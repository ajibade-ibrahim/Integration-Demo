/**
 * Salesforce provider definition.
 *
 * Docs: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 */

import type {
  ParsedTokenResponse,
  ProviderDefinition,
} from "../../types/registry";

export const SALESFORCE_PROVIDER_NAME = "salesforce";

/**
 * `api` grants read access to Account and Contact; `refresh_token` is what
 * makes long-lived sync possible at all.
 */
export const SALESFORCE_IDENTITY_SCOPES = ["api", "refresh_token"] as const;

/**
 * Support needs no additional scopes: `api` already spans every object the
 * user can see, Case included. Salesforce's coarse scopes are why scope sets
 * are held per (function, provider) rather than per function — the same
 * function widens the request on HubSpot and not here.
 */
export const SALESFORCE_SUPPORT_SCOPES = ["api", "refresh_token"] as const;

/**
 * Agreement needs no additional scopes either: Contract and Opportunity are
 * ordinary objects, and `api` already spans everything the user can see.
 *
 * Salesforce is the reason the agreement function exists at the shape it does
 * — it is the only connected provider carrying a sales-led agreement (a
 * Contract with status, dates and a linked opportunity) rather than a
 * self-serve subscription.
 */
export const SALESFORCE_AGREEMENT_SCOPES = ["api", "refresh_token"] as const;

/**
 * Sandboxes authorize against test.salesforce.com, production and Developer
 * Edition orgs against login.salesforce.com. Configurable because getting it
 * wrong produces an opaque "invalid_client_id" that is hard to diagnose.
 */
function loginHost(): string {
  const host = process.env["SALESFORCE_LOGIN_HOST"];
  return host === undefined || host === "" ? "login.salesforce.com" : host;
}

export function salesforceApiVersion(): string {
  const version = process.env["SALESFORCE_API_VERSION"];
  return version === undefined || version === "" ? "v60.0" : version;
}

/**
 * Pull the org id out of Salesforce's identity URL.
 *
 * The token response's `id` looks like
 * `https://login.salesforce.com/id/00Dx0000000BV7z/005x00000012Q9P` — org id,
 * then user id. The org id is the stable tenant identifier, and the reason
 * identity resolution cannot use `instanceUrl` for that job: legacy pod
 * hostnames like `na1.salesforce.com` were shared by thousands of unrelated
 * orgs, so scoping record ids by host would have been no scoping at all.
 *
 * @returns The 15- or 18-character org id, or undefined if the URL is not the
 *   expected shape — in which case no self-key is emitted.
 */
export function organizationIdFromIdentityUrl(
  identityUrl: string
): string | undefined {
  const match = /\/id\/(00D[A-Za-z0-9]{12,15})\//.exec(identityUrl);
  return match?.[1];
}

export const salesforceProvider: ProviderDefinition = {
  name: SALESFORCE_PROVIDER_NAME,
  label: "Salesforce",
  description: "Sync Accounts and Contacts from a Salesforce org.",

  auth: {
    kind: "oauth",

    // Read through getters so a changed env var takes effect without a rebuild.
    get authorizeEndpoint(): string {
      return `https://${loginHost()}/services/oauth2/authorize`;
    },
    get tokenEndpoint(): string {
      return `https://${loginHost()}/services/oauth2/token`;
    },
    get revokeEndpoint(): string {
      return `https://${loginHost()}/services/oauth2/revoke`;
    },

    clientIdEnv: "SALESFORCE_CLIENT_ID",
    clientSecretEnv: "SALESFORCE_CLIENT_SECRET",

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
        throw new Error("Salesforce token response has no access_token");
      }

      // Every subsequent Salesforce call is addressed to the org's own host,
      // which is only ever communicated here. Dropping it makes the integration
      // unusable, so treat its absence as a hard failure rather than defaulting.
      const instanceUrl = body["instance_url"];
      if (typeof instanceUrl !== "string" || instanceUrl === "") {
        throw new Error("Salesforce token response has no instance_url");
      }

      const refreshToken = body["refresh_token"];
      const issuedAt = body["issued_at"];

      // Captured for identity resolution, not for addressing requests — unlike
      // `instance_url`, whose absence is fatal above. A missing or unparseable
      // identity URL costs one join and nothing else, so it must not refuse a
      // perfectly usable connection.
      const identityUrl = body["id"];
      const organizationId =
        typeof identityUrl === "string"
          ? organizationIdFromIdentityUrl(identityUrl)
          : undefined;

      return {
        accessToken,
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
        // Salesforce returns no expires_in; session lifetime is org policy,
        // commonly 2 hours. We refresh proactively well before that.
        expiresInSeconds: 7200,
        metadata: {
          instanceUrl,
          ...(typeof issuedAt === "string" ? { issuedAt } : {}),
          ...(organizationId === undefined ? {} : { organizationId }),
        },
      };
    },
  },

  // Account and Contact ids are unique within an org, not across Salesforce.
  externalIdScope: "tenant",

  // The org id, captured above. The one provider here whose credential actually
  // names its tenant, so the only one that emits self-keys today.
  tenantScopeValue(metadata) {
    return metadata["organizationId"];
  },
};
