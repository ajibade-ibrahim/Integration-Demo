import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SLACK_COMMUNICATION_SCOPES,
  slackProvider,
} from "@/core/providers/slack/provider";
import { externalIdScopeValue } from "@/core/registries/provider-registry";

afterEach(() => {
  vi.unstubAllGlobals();
});

function oauth() {
  const auth = slackProvider.auth;
  if (auth.kind !== "oauth") throw new Error("expected OAuth");
  return auth;
}

describe("Slack provider definition", () => {
  it("declares user scopes only and a tenant scope keyed on team", () => {
    expect(SLACK_COMMUNICATION_SCOPES).toEqual([
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
    ]);
    expect(slackProvider.externalIdScope).toBe("tenant");
    expect(
      externalIdScopeValue(slackProvider, { teamId: "T-123" })
    ).toBe("T-123");
  });

  it("requests user_scope and never a bot scope", () => {
    const params = oauth().buildAuthorizeParams({
      clientId: "client",
      redirectUri: "https://app.test/api/oauth/slack/callback",
      scopes: ["im:read", "users:read"],
      state: "state",
    });

    expect(params.get("user_scope")).toBe("im:read,users:read");
    expect(params.get("scope")).toBeNull();
    expect(params.get("response_type")).toBe("code");
  });

  it("parses the nested user token, scopes and workspace facts", () => {
    const parsed = oauth().parseTokenResponse({
      ok: true,
      access_token: "bot-token",
      token_type: "bot",
      scope: "chat:write",
      team: { id: "T-1", name: "Acme" },
      enterprise: { id: "E-1" },
      authed_user: {
        id: "U-1",
        scope: "im:read,users:read",
        access_token: "user-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      },
    });

    expect(parsed).toMatchObject({
      accessToken: "user-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 3600,
      metadata: {
        teamId: "T-1",
        teamName: "Acme",
        userId: "U-1",
        enterpriseId: "E-1",
      },
    });
    expect(parsed.grantedScopes).toEqual(["im:read", "users:read"]);
  });

  it("throws on Slack's HTTP-200 error body", () => {
    expect(() =>
      oauth().parseTokenResponse({ ok: false, error: "invalid_code" })
    ).toThrow(/invalid_code/);
  });

  it("uses a far-future sentinel when rotation is off", () => {
    const parsed = oauth().parseTokenResponse({
      ok: true,
      team: { id: "T-1" },
      authed_user: { id: "U-1", access_token: "user-token" },
    });

    expect(parsed.expiresInSeconds).toBeGreaterThan(9 * 365 * 24 * 60 * 60);
    expect(parsed.refreshToken).toBeUndefined();
  });

  it("accepts a top-level user token on the rotation refresh path", () => {
    const parsed = oauth().parseTokenResponse({
      ok: true,
      access_token: "rotated-user-token",
      token_type: "user",
      refresh_token: "rotated-refresh",
      expires_in: "7200",
      scope: "im:read users:read",
      team: { id: "T-1" },
    });

    expect(parsed.accessToken).toBe("rotated-user-token");
    expect(parsed.refreshToken).toBe("rotated-refresh");
    expect(parsed.expiresInSeconds).toBe(7200);
    expect(parsed.grantedScopes).toEqual(["im:read", "users:read"]);
    expect(parsed.metadata["teamId"]).toBe("T-1");
  });

  it("never uses a top-level bot token", () => {
    expect(() =>
      oauth().parseTokenResponse({
        ok: true,
        access_token: "bot-token",
        token_type: "bot",
        team: { id: "T-1" },
      })
    ).toThrow(/user access token/);
  });

  it("returns an empty granted list when Slack omits user scopes", () => {
    const parsed = oauth().parseTokenResponse({
      ok: true,
      team: { id: "T-1" },
      authed_user: { id: "U-1", access_token: "user-token" },
    });

    expect(parsed.grantedScopes).toEqual([]);
  });

  it("resolves workspace facts with auth.test and the user profile", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method });
        if (url.includes("/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: "T-1",
              team: "Acme",
              user_id: "U-1",
              enterprise_id: "E-1",
            }),
            { status: 200 }
          );
        }
        if (url.includes("/users.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              user: {
                id: "U-1",
                profile: { email: "me@acme.example", real_name: "Me" },
              },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected URL ${url}`);
      })
    );

    const metadata = await oauth().resolveTokenMetadata?.("token");

    expect(metadata).toEqual({
      teamId: "T-1",
      teamName: "Acme",
      userId: "U-1",
      enterpriseId: "E-1",
      email: "me@acme.example",
      name: "Me",
    });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]?.url).toContain("/auth.test");
    expect(calls[1]).toMatchObject({ method: "GET" });
    expect(calls[1]?.url).toContain("/users.info");
  });

  it("keeps auth.test facts when the profile lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/auth.test")) {
          return new Response(
            JSON.stringify({ ok: true, team_id: "T-1", user_id: "U-1" }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          status: 200,
        });
      })
    );

    await expect(oauth().resolveTokenMetadata?.("token")).resolves.toEqual({
      teamId: "T-1",
      userId: "U-1",
    });
  });

  it("revokes both tokens with a GET and reports confirmation", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response(JSON.stringify({ ok: true, revoked: true }), {
          status: 200,
        });
      })
    );

    const revoked = await oauth().revokeCredential?.({
      accessToken: "access",
      refreshToken: "refresh",
    });

    expect(revoked).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("token=access");
    expect(calls[1]).toContain("token=refresh");
    expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
  });

  it("still attempts the refresh token when the access revoke fails", async () => {
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        tokens.push(url);
        const ok = !url.includes("token=access");
        return new Response(JSON.stringify({ ok, revoked: ok }), { status: 200 });
      })
    );

    const revoked = await oauth().revokeCredential?.({
      accessToken: "access",
      refreshToken: "refresh",
    });

    expect(revoked).toBe(false);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toContain("token=refresh");
  });
});
