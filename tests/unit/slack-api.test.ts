import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  dateToSlackTs,
  isExternalSlackUser,
  isIngestibleMessage,
  slackGet,
  SlackApiError,
  SlackUserCache,
  slackTsToDate,
  snippetOf,
} from "@/core/providers/slack/api";
import {
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import type { SessionContext } from "@/core/providers/http";

const API = "https://slack.com/api";
const server = setupServer();

beforeAll(() => {
  process.env["SLACK_API_BASE"] = API;
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    integrationId: "integration-1",
    accessToken: "old-token",
    metadata: {},
    ...overrides,
  };
}

describe("Slack timestamps and text", () => {
  it("converts Slack timestamps both ways", () => {
    const at = slackTsToDate("1768471200.123456");
    expect(at?.toISOString()).toBe("2026-01-15T10:00:00.123Z");

    expect(dateToSlackTs(new Date("2026-01-15T10:00:00.123Z"))).toBe(
      "1768471200.123000"
    );
  });

  it("rejects a malformed timestamp", () => {
    expect(slackTsToDate("not-a-ts")).toBeUndefined();
  });

  it("collapses and bounds a snippet", () => {
    expect(snippetOf({ text: "  hello\n\n world  " })).toBe("hello world");
    expect(snippetOf({ text: "" })).toBeUndefined();
    const long = snippetOf({ text: "x".repeat(400) });
    expect(long?.length).toBe(200);
    expect(long?.endsWith("...")).toBe(true);
  });
});

describe("Slack message ingestion", () => {
  it("allows ordinary messages and the three human subtypes", () => {
    expect(isIngestibleMessage({ user: "U1" })).toBe(true);
    expect(isIngestibleMessage({ user: "U1", subtype: "thread_broadcast" })).toBe(true);
    expect(isIngestibleMessage({ user: "U1", subtype: "file_share" })).toBe(true);
    expect(isIngestibleMessage({ user: "U1", subtype: "me_message" })).toBe(true);
  });

  it("drops joins, bots and messages with no author", () => {
    expect(isIngestibleMessage({ user: "U1", subtype: "channel_join" })).toBe(false);
    expect(isIngestibleMessage({ user: "U1", bot_id: "B1" })).toBe(false);
    expect(isIngestibleMessage({ user: "U1", app_id: "A1" })).toBe(false);
    expect(isIngestibleMessage({ text: "no author" })).toBe(false);
  });
});

describe("external classification", () => {
  const base = {
    id: "U1",
    isExternal: false,
    isStranger: false,
    isBot: false,
    deleted: false,
  };

  it("never treats a bot or deleted user as a customer", () => {
    expect(
      isExternalSlackUser({ ...base, isBot: true }, { teamId: "T1" })
    ).toBe(false);
    expect(
      isExternalSlackUser({ ...base, deleted: true }, { teamId: "T1" })
    ).toBe(false);
  });

  it("treats a same-enterprise workspace as internal", () => {
    expect(
      isExternalSlackUser(
        { ...base, isExternal: true, teamId: "T2", enterpriseId: "E1" },
        { teamId: "T1", enterpriseId: "E1" }
      )
    ).toBe(false);
  });

  it("uses Slack's external and stranger flags", () => {
    expect(
      isExternalSlackUser({ ...base, isExternal: true, teamId: "T2" }, { teamId: "T1" })
    ).toBe(true);
    expect(
      isExternalSlackUser({ ...base, isStranger: true, teamId: "T1" }, { teamId: "T1" })
    ).toBe(true);
  });

  it("falls back to workspace membership", () => {
    expect(
      isExternalSlackUser({ ...base, teamId: "T2" }, { teamId: "T1" })
    ).toBe(true);
    expect(
      isExternalSlackUser({ ...base, teamId: "T1" }, { teamId: "T1" })
    ).toBe(false);
    expect(isExternalSlackUser(base, { teamId: "T1" })).toBe(false);
  });
});

describe("slackGet error policy", () => {
  it("refreshes once on token_expired and retries with the new token", async () => {
    const seen: Array<string | null> = [];
    let calls = 0;
    server.use(
      http.get(`${API}/conversations.history`, ({ request }) => {
        calls += 1;
        seen.push(request.headers.get("authorization"));
        return calls === 1
          ? HttpResponse.json({ ok: false, error: "token_expired" })
          : HttpResponse.json({ ok: true, messages: [] });
      })
    );

    const body = await slackGet(
      ctx({
        refreshAccessToken: async () => ({
          accessToken: "new-token",
          metadata: {},
        }),
      }),
      "conversations.history",
      { channel: "C1" }
    );

    expect(body["ok"]).toBe(true);
    expect(calls).toBe(2);
    expect(seen).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  it("requires reauthorization when an auth error survives the refresh", async () => {
    server.use(
      http.get(`${API}/users.list`, () =>
        HttpResponse.json({ ok: false, error: "invalid_auth" })
      )
    );

    // No refresh callback, and Slack's body-level auth error is not an HTTP 401.
    await expect(slackGet(ctx(), "users.list", {})).rejects.toBeInstanceOf(
      ReauthorizationRequiredError
    );
  });

  it("retries a rate-limit body through the run-level backoff", async () => {
    server.use(
      http.get(`${API}/users.list`, () =>
        HttpResponse.json({ ok: false, error: "ratelimited" })
      )
    );

    await expect(slackGet(ctx(), "users.list", {})).rejects.toBeInstanceOf(
      RetryableSyncError
    );
  });

  it("preserves an ordinary Slack error code for the caller", async () => {
    server.use(
      http.get(`${API}/conversations.history`, () =>
        HttpResponse.json({ ok: false, error: "channel_not_found" })
      )
    );

    const error = await slackGet(ctx(), "conversations.history", {
      channel: "C1",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as SlackApiError).code).toBe("channel_not_found");
  });
});

describe("Slack user cache", () => {
  it("preloads users.list and only asks users.info for an unseen id", async () => {
    let infoCalls = 0;
    server.use(
      http.get(`${API}/users.list`, () =>
        HttpResponse.json({
          ok: true,
          members: [
            {
              id: "U1",
              team_id: "T1",
              profile: { real_name: "Known", email: "known@acme.example" },
            },
          ],
          response_metadata: { next_cursor: "" },
        })
      ),
      http.get(`${API}/users.info`, ({ request }) => {
        infoCalls += 1;
        const user = new URL(request.url).searchParams.get("user");
        return HttpResponse.json({
          ok: true,
          user: {
            id: user,
            team_id: "T2",
            is_external: true,
            profile: { real_name: "External", email: "external@elsewhere.example" },
          },
        });
      })
    );

    const users = await SlackUserCache.load(ctx(), { teamId: "T1" });

    expect(users.peek("U1")).toMatchObject({ name: "Known" });
    await expect(users.get("U1")).resolves.toMatchObject({ name: "Known" });
    expect(infoCalls).toBe(0);

    const external = await users.get("U2");
    expect(external?.email).toBe("external@elsewhere.example");
    expect(infoCalls).toBe(1);
    await users.get("U2");
    expect(infoCalls).toBe(1);
    expect(external === undefined ? false : users.isExternal(external)).toBe(true);
  });
});
