import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  listConversationMembers,
  listEligibleConversations,
  validateConversationForMapping,
} from "@/core/providers/slack/conversations";
import type { SessionContext } from "@/core/providers/http";

const API = "https://slack.com/api";
const server = setupServer();

const USERS = [
  {
    id: "U-me",
    team_id: "T1",
    profile: { real_name: "Me", email: "me@our-company.example" },
  },
  {
    id: "U-alice",
    team_id: "T2",
    is_external: true,
    profile: { real_name: "Alice External", email: "alice@acme.example" },
  },
  { id: "U-bob", team_id: "T1", profile: { real_name: "Bob Internal" } },
  { id: "U-bot", team_id: "T2", is_bot: true, profile: { real_name: "Bot" } },
  { id: "U-deleted", team_id: "T2", deleted: true },
];

const CONVERSATIONS = [
  {
    id: "C-public",
    name: "acme-support",
    is_channel: true,
    is_ext_shared: true,
    is_private: false,
    is_member: false,
    num_members: 12,
  },
  {
    id: "C-internal-shared",
    name: "internal",
    is_channel: true,
    is_shared: true,
    is_ext_shared: false,
  },
  {
    id: "C-pending",
    name: "pending",
    is_channel: true,
    is_ext_shared: true,
    is_pending_ext_shared: true,
  },
  {
    id: "C-frozen",
    name: "frozen",
    is_channel: true,
    is_ext_shared: true,
    is_frozen: true,
  },
  {
    id: "C-archived",
    name: "archived",
    is_channel: true,
    is_ext_shared: true,
    is_archived: true,
  },
  {
    id: "G-private-no",
    name: "private-no",
    is_channel: true,
    is_ext_shared: true,
    is_private: true,
    is_member: false,
  },
  {
    id: "G-private-yes",
    name: "private-acme",
    is_channel: true,
    is_ext_shared: true,
    is_private: true,
    is_member: true,
  },
  { id: "D-ext", is_im: true, user: "U-alice" },
  { id: "D-deleted", is_im: true, user: "U-deleted", is_user_deleted: true },
  { id: "D-internal", is_im: true, user: "U-bob" },
  { id: "M-ext", is_mpim: true, num_members: 3 },
  { id: "M-bot", is_mpim: true },
  { id: "M-internal", is_mpim: true },
];

const MEMBERS: Record<string, string[]> = {
  "M-ext": ["U-me", "U-alice", "U-bot"],
  "M-bot": ["U-me", "U-bot"],
  "M-internal": ["U-me", "U-bob"],
};

function ctx(): SessionContext {
  return {
    integrationId: "integration-1",
    accessToken: "token",
    metadata: { userId: "U-me", teamId: "T1", email: "me@our-company.example" },
  };
}

beforeAll(() => {
  process.env["SLACK_API_BASE"] = API;
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function serveListing(): void {
  server.use(
    http.get(`${API}/users.list`, () =>
      HttpResponse.json({
        ok: true,
        members: USERS,
        response_metadata: { next_cursor: "" },
      })
    ),
    http.get(`${API}/conversations.list`, () =>
      HttpResponse.json({
        ok: true,
        channels: CONVERSATIONS,
        response_metadata: { next_cursor: "" },
      })
    ),
    http.get(`${API}/conversations.members`, ({ request }) => {
      const channel = new URL(request.url).searchParams.get("channel") ?? "";
      return HttpResponse.json({ ok: true, members: MEMBERS[channel] ?? [] });
    })
  );
}

describe("Slack conversation eligibility", () => {
  it("offers shared channels, external DMs and group DMs only", async () => {
    serveListing();

    const conversations = await listEligibleConversations(ctx());

    expect(conversations.map((c) => c.conversationId)).toEqual([
      "C-public",
      "G-private-yes",
      "D-ext",
      "M-ext",
    ]);
    expect(conversations.map((c) => c.conversationKind)).toEqual([
      "shared_channel",
      "shared_channel",
      "connect_dm",
      "group_dm",
    ]);
    expect(conversations.find((c) => c.conversationId === "C-public")).toMatchObject({
      label: "#acme-support",
      isPrivate: false,
      isMember: false,
      memberCount: 12,
    });
    expect(conversations.find((c) => c.conversationId === "D-ext")).toMatchObject({
      label: "DM with Alice External",
      memberCount: 2,
    });
    expect(conversations.find((c) => c.conversationId === "M-ext")?.label).toContain(
      "Group DM with Alice External"
    );
  });

  it("validates one conversation against the same rules", async () => {
    serveListing();
    server.use(
      http.get(`${API}/conversations.info`, ({ request }) => {
        const channel = new URL(request.url).searchParams.get("channel");
        if (channel === "C-missing") {
          return HttpResponse.json({ ok: false, error: "channel_not_found" });
        }
        const record = CONVERSATIONS.find((item) => item.id === channel);
        return HttpResponse.json({ ok: true, channel: record ?? {} });
      })
    );

    await expect(
      validateConversationForMapping(ctx(), "C-public")
    ).resolves.toMatchObject({
      ok: true,
      conversation: { conversationId: "C-public", conversationKind: "shared_channel" },
    });

    await expect(
      validateConversationForMapping(ctx(), "G-private-no")
    ).resolves.toMatchObject({ ok: false });

    await expect(
      validateConversationForMapping(ctx(), "C-internal-shared")
    ).resolves.toMatchObject({ ok: false });

    await expect(
      validateConversationForMapping(ctx(), "C-missing")
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("Slack conversation members", () => {
  function serveUsers(): void {
    server.use(
      http.get(`${API}/users.list`, () =>
        HttpResponse.json({
          ok: true,
          members: USERS,
          response_metadata: { next_cursor: "" },
        })
      )
    );
  }

  it("paginates the member list and omits bots and deleted users", async () => {
    serveUsers();
    const pages: string[] = [];
    server.use(
      http.get(`${API}/conversations.members`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        pages.push(cursor ?? "");
        return cursor === "page-2"
          ? HttpResponse.json({
              ok: true,
              members: ["U-bot", "U-deleted"],
              response_metadata: { next_cursor: "" },
            })
          : HttpResponse.json({
              ok: true,
              members: ["U-me", "U-alice"],
              response_metadata: { next_cursor: "page-2" },
            });
      })
    );

    const snapshot = await listConversationMembers(ctx(), "C-public");

    expect(pages).toEqual(["", "page-2"]);
    expect(snapshot?.map((member) => member.slackUserId)).toEqual([
      "U-me",
      "U-alice",
    ]);
    expect(snapshot?.find((member) => member.slackUserId === "U-me")).toMatchObject({
      name: "Me",
      email: "me@our-company.example",
      isExternal: false,
    });
    expect(
      snapshot?.find((member) => member.slackUserId === "U-alice")
    ).toMatchObject({
      name: "Alice External",
      email: "alice@acme.example",
      isExternal: true,
    });
  });

  it("returns undefined, not an empty snapshot, when the lookup is skipped", async () => {
    serveUsers();
    server.use(
      http.get(`${API}/conversations.members`, () =>
        HttpResponse.json({ ok: false, error: "channel_not_found" })
      )
    );

    await expect(listConversationMembers(ctx(), "C-gone")).resolves.toBeUndefined();
  });

  it("returns an empty snapshot when the conversation has no members", async () => {
    serveUsers();
    server.use(
      http.get(`${API}/conversations.members`, () =>
        HttpResponse.json({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "" },
        })
      )
    );

    await expect(listConversationMembers(ctx(), "C-empty")).resolves.toEqual([]);
  });
});
