import { describe, expect, it } from "vitest";

import {
  GMAIL_COMMUNICATION_SCOPES,
  gmailProvider,
} from "@/core/providers/gmail/provider";
import { externalIdScopeValue } from "@/core/registries/provider-registry";

describe("Gmail provider definition", () => {
  it("declares the read-only scopes and tenant scope", () => {
    expect(GMAIL_COMMUNICATION_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    expect(gmailProvider.externalIdScope).toBe("tenant");
    expect(externalIdScopeValue(gmailProvider, { email: "owner@example.com" })).toBe(
      "owner@example.com"
    );
  });

  it("requests offline access and refresh-token consent", () => {
    const auth = gmailProvider.auth;
    if (auth.kind !== "oauth") throw new Error("expected OAuth");

    const params = auth.buildAuthorizeParams({
      clientId: "client",
      redirectUri: "https://app.test/api/oauth/gmail/callback",
      scopes: [...GMAIL_COMMUNICATION_SCOPES],
      state: "state",
    });

    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("include_granted_scopes")).toBe("true");
    expect(params.get("scope")).toBe(GMAIL_COMMUNICATION_SCOPES.join(" "));
    expect(auth.revokeEndpoint).toBe("https://oauth2.googleapis.com/revoke");
  });

  it("parses Google's token response", () => {
    const auth = gmailProvider.auth;
    if (auth.kind !== "oauth") throw new Error("expected OAuth");

    const parsed = auth.parseTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3599,
    });

    expect(parsed).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      expiresInSeconds: 3599,
    });
  });
});
