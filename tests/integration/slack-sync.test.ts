/**
 * A Slack communication sync end to end.
 *
 * The provider runs against msw and the writer against the real test database,
 * so this covers the seam the unit tests cannot: conversation mappings handed
 * through the handler context, attribution, streaming page writes, the
 * complete-pass watermark, tracked-thread refresh, and the mapping lifecycle.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { bootstrap } from "@/core/bootstrap";
import { executeSync } from "@/core/sync/sync-engine";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import {
  NON_EXPIRING_AT,
  saveToken,
  findToken,
} from "@/core/repositories/token-repository";
import { createFakeClock } from "@/core/sync/clock";
import {
  countSlackConversationMappings,
  deleteSlackConversationMapping,
  upsertSlackConversationMapping,
} from "@/core/repositories/slack-conversation-mapping-repository";
import {
  buildAuthorizationRequest,
  handleCallback,
  revokeTokens,
} from "@/core/oauth/oauth-service";
import { prisma } from "@/lib/prisma";

const USER_ID = "user-slack-sync";
const INTEGRATION_ID = "integration-slack-sync";
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
  { id: "U-bot", team_id: "T2", is_bot: true, profile: { real_name: "Bot" } },
];

const historyByChannel: Record<string, unknown[]> = {};
const repliesByKey: Record<string, unknown[]> = {};
const calls = { history: 0, replies: 0 };

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "slack-sync@example.test" },
    update: {},
  });
});

afterEach(() => {
  server.resetHandlers();
  for (const key of Object.keys(historyByChannel)) delete historyByChannel[key];
  for (const key of Object.keys(repliesByKey)) delete repliesByKey[key];
  calls.history = 0;
  calls.replies = 0;
});

afterAll(async () => {
  server.close();
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });
});

function json(body: unknown) {
  return HttpResponse.json(body as Record<string, unknown>);
}

function tsOf(iso: string): string {
  return `${(Date.parse(iso) / 1000).toFixed(6)}`;
}

const ROOT_TS = tsOf("2026-01-15T10:00:00Z");
const REPLY_TS = tsOf("2026-01-16T10:00:00Z");
const NEW_REPLY_TS = tsOf("2026-02-04T10:00:00Z");
const DM_TS = tsOf("2026-01-17T10:00:00Z");

function message(
  ts: string,
  user: string,
  text: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type: "message", ts, user, text, ...extra };
}

function serveSyncApi(): void {
  server.use(
    http.get(`${API}/users.list`, () =>
      json({
        ok: true,
        members: USERS,
        response_metadata: { next_cursor: "" },
      })
    ),
    http.get(`${API}/conversations.members`, ({ request }) => {
      const channel = new URL(request.url).searchParams.get("channel") ?? "";
      return json({
        ok: true,
        members: channel === "D-dm" ? ["U-me", "U-alice"] : ["U-me", "U-alice"],
        response_metadata: { next_cursor: "" },
      });
    }),
    http.get(`${API}/conversations.history`, ({ request }) => {
      calls.history += 1;
      const channel = new URL(request.url).searchParams.get("channel") ?? "";
      return json({
        ok: true,
        messages: historyByChannel[channel] ?? [],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    }),
    http.get(`${API}/conversations.replies`, ({ request }) => {
      calls.replies += 1;
      const url = new URL(request.url);
      const channel = url.searchParams.get("channel") ?? "";
      const ts = url.searchParams.get("ts") ?? "";
      return json({
        ok: true,
        messages: repliesByKey[`${channel}:${ts}`] ?? [],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    })
  );
}

async function connect(
  metadata: Record<string, string> = {
    teamId: "T1",
    userId: "U-me",
    email: "me@our-company.example",
  }
): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "slack",
      status: "active",
      instanceLabel: "Slack",
      functions: { create: [{ functionName: "communication" }] },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "fake-slack-token",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata,
  });

  await saveMappings(
    INTEGRATION_ID,
    "communication",
    defaultMappingsFor("communication", "slack")
  );
}

async function seedParties(): Promise<{ acmeId: string; betaId: string }> {
  const acme = await prisma.customer.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "acme",
      name: "Acme",
      email: "alice@acme.example",
      domain: "acme.example",
    },
    select: { id: true },
  });
  await prisma.contact.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "alice",
      name: "Alice",
      email: "alice@acme.example",
      customerId: acme.id,
    },
  });

  const beta = await prisma.customer.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "beta",
      name: "Beta",
      email: "bob@beta.example",
      domain: "beta.example",
    },
    select: { id: true },
  });
  await prisma.contact.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "bob",
      name: "Bob",
      email: "bob@beta.example",
      customerId: beta.id,
    },
  });

  return { acmeId: acme.id, betaId: beta.id };
}

async function mapConversation(
  conversationId: string,
  customerId: string,
  kind: "shared_channel" | "connect_dm" | "group_dm" = "shared_channel",
  label = "#acme-support"
): Promise<void> {
  await upsertSlackConversationMapping({
    integrationId: INTEGRATION_ID,
    conversationId,
    kind,
    label,
    customerId,
  });
}

async function syncAt(iso: string) {
  return executeSync(INTEGRATION_ID, {
    trigger: "manual",
    clock: createFakeClock(Date.parse(iso)),
  });
}

function channelThread(): unknown[] {
  return [
    message(ROOT_TS, "U-me", "Internal note about Acme", {
      reply_count: 1,
    }),
    message(tsOf("2026-01-15T11:00:00Z"), "U-bot", "bot says hi"),
    {
      type: "message",
      subtype: "channel_join",
      ts: tsOf("2026-01-15T12:00:00Z"),
      user: "U-me",
      text: "joined",
    },
  ];
}

describe("a Slack communication sync", () => {
  it("writes only mapped conversations with mapping attribution and members", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);
    await mapConversation("D-dm", acmeId, "connect_dm", "DM with Alice External");

    serveSyncApi();
    historyByChannel["C-shared"] = channelThread();
    historyByChannel["D-dm"] = [message(DM_TS, "U-alice", "Hello from Slack")];
    repliesByKey[`C-shared:${ROOT_TS}`] = [
      message(ROOT_TS, "U-me", "Internal note about Acme", {
        thread_ts: ROOT_TS,
        reply_count: 1,
      }),
      message(REPLY_TS, "U-alice", "Thanks, Alice", { thread_ts: ROOT_TS }),
    ];

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    expect(result.recordCounts.slackMessage).toBe(3);

    const messages = await prisma.slackMessage.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: {
        mapping: { include: { customer: true } },
        authorContact: true,
      },
    });
    expect(messages).toHaveLength(3);

    const channelRoot = messages.find(
      (row) => row.externalSourceId === `C-shared:${ROOT_TS}`
    );
    expect(channelRoot).toMatchObject({
      authorId: "U-me",
      authorName: "Me",
      authorIsExternal: false,
      threadRootTs: ROOT_TS,
      direction: "sent",
    });
    expect(channelRoot?.mapping.label).toBe("#acme-support");
    expect(channelRoot?.mapping.customerId).toBe(acmeId);
    expect(channelRoot?.authorContact).toBeNull();

    const reply = messages.find(
      (row) => row.externalSourceId === `C-shared:${REPLY_TS}`
    );
    expect(reply).toMatchObject({
      authorId: "U-alice",
      authorName: "Alice External",
      authorEmail: "alice@acme.example",
      authorIsExternal: true,
      threadRootTs: ROOT_TS,
      direction: "received",
    });
    expect(reply?.mapping.customerId).toBe(acmeId);
    expect(reply?.authorContact).toMatchObject({
      name: "Alice",
      email: "alice@acme.example",
      customerId: acmeId,
    });

    const dm = messages.find(
      (row) => row.externalSourceId === `D-dm:${DM_TS}`
    );
    expect(dm).toMatchObject({
      authorId: "U-alice",
      authorEmail: "alice@acme.example",
      direction: "received",
      threadRootTs: DM_TS,
    });
    expect(dm?.mapping.label).toBe("DM with Alice External");

    // The member snapshot is stored once per mapping, not copied onto messages.
    const members = await prisma.slackConversationMember.findMany({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(
      members
        .filter((member) => member.mappingId === channelRoot?.mappingId)
        .map((member) => member.slackUserId)
        .sort()
    ).toEqual(["U-alice", "U-me"]);
    expect(members.find((member) => member.slackUserId === "U-alice")).toMatchObject({
      name: "Alice External",
      email: "alice@acme.example",
      isExternal: true,
    });
    expect(members.find((member) => member.slackUserId === "U-me")).toMatchObject({
      isExternal: false,
    });

    // The bot message and the join subtype never reached the writer.
    expect(messages.map((row) => row.authorName)).not.toContain("Bot");

    const state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).not.toBeNull();
    expect(state.syncFingerprint).not.toBeNull();
  });

  it("refreshes replies to a tracked root on an incremental run", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);

    serveSyncApi();
    historyByChannel["C-shared"] = [
      message(ROOT_TS, "U-me", "Root with no reply yet"),
    ];

    const first = await syncAt("2026-02-01T12:00:00Z");
    expect(first.status).toBe("success");
    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
    expect(calls.replies).toBe(0);

    // Beyond the two-day overlap: history is empty, but the stored thread is
    // still refreshed so a late reply is ingested.
    historyByChannel["C-shared"] = [];
    repliesByKey[`C-shared:${ROOT_TS}`] = [
      message(ROOT_TS, "U-me", "Root with no reply yet", { thread_ts: ROOT_TS }),
      message(NEW_REPLY_TS, "U-alice", "Late reply", { thread_ts: ROOT_TS }),
    ];

    const second = await syncAt("2026-02-05T12:00:00Z");
    expect(second.status).toBe("success");
    expect(calls.replies).toBe(1);

    const messages = await prisma.slackMessage.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { sentAt: "asc" },
    });
    expect(messages).toHaveLength(2);
    expect(messages.map((row) => row.externalSourceId)).toEqual([
      `C-shared:${ROOT_TS}`,
      `C-shared:${NEW_REPLY_TS}`,
    ]);
  });

  it("treats a vanished conversation as a warning-level skip", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);

    serveSyncApi();
    server.use(
      http.get(`${API}/conversations.history`, () =>
        json({ ok: false, error: "channel_not_found" })
      )
    );

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    expect(result.recordCounts.slackMessage).toBe(0);
    const state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).not.toBeNull();
  });

  it("fails the run when Slack rejects the grant", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);

    serveSyncApi();
    server.use(
      http.get(`${API}/conversations.history`, () =>
        json({ ok: false, error: "invalid_auth" })
      )
    );

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("failed");
    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: INTEGRATION_ID },
      select: { status: true },
    });
    expect(integration.status).toBe("requires_reauthorization");
  });

  it("completes without reading Slack when nothing is mapped", async () => {
    await connect();
    await seedParties();
    serveSyncApi();

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    expect(result.recordCounts.slackMessage).toBe(0);
    expect(calls.history).toBe(0);
    const state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).not.toBeNull();
  });

  it("ingests a mapped customer with no known communication parties", async () => {
    await connect();
    // No email, no domain, no contacts: the tenant-wide known-party set is
    // empty. Slack must still ingest because the mapping names the customer.
    const customer = await prisma.customer.create({
      data: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "plain",
        name: "Plain Customer",
      },
      select: { id: true },
    });
    await mapConversation("C-shared", customer.id);

    serveSyncApi();
    historyByChannel["C-shared"] = [message(ROOT_TS, "U-me", "Internal hello")];

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    expect(result.recordCounts.slackMessage).toBe(1);
    expect(
      await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);
  });

  it("refreshes the member snapshot from a successful sync", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);
    const mapping = await prisma.slackConversationMapping.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, conversationId: "C-shared" },
      select: { id: true },
    });
    await prisma.slackConversationMember.create({
      data: {
        integrationId: INTEGRATION_ID,
        mappingId: mapping.id,
        slackUserId: "U-stale",
        name: "No Longer Here",
        isExternal: true,
      },
    });

    serveSyncApi();
    historyByChannel["C-shared"] = [message(ROOT_TS, "U-me", "Hello")];

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    const members = await prisma.slackConversationMember.findMany({
      where: { mappingId: mapping.id },
      orderBy: { slackUserId: "asc" },
    });
    expect(members.map((member) => member.slackUserId)).toEqual([
      "U-alice",
      "U-me",
    ]);
  });

  it("keeps the stored member snapshot when the member lookup is skipped", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);
    const mapping = await prisma.slackConversationMapping.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, conversationId: "C-shared" },
      select: { id: true },
    });
    await prisma.slackConversationMember.createMany({
      data: [
        {
          integrationId: INTEGRATION_ID,
          mappingId: mapping.id,
          slackUserId: "U-me",
          name: "Me",
          isExternal: false,
        },
        {
          integrationId: INTEGRATION_ID,
          mappingId: mapping.id,
          slackUserId: "U-alice",
          name: "Alice External",
          isExternal: true,
        },
      ],
    });

    serveSyncApi();
    server.use(
      http.get(`${API}/conversations.members`, () =>
        json({ ok: false, error: "channel_not_found" })
      )
    );
    historyByChannel["C-shared"] = [message(ROOT_TS, "U-alice", "Hello")];

    const result = await syncAt("2026-02-01T12:00:00Z");

    expect(result.status).toBe("success");
    expect(
      await prisma.slackConversationMember.count({
        where: { mappingId: mapping.id },
      })
    ).toBe(2);
  });
});

describe("mapping lifecycle", () => {
  it("resets the watermark on upsert and deletes messages on removal", async () => {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);

    serveSyncApi();
    historyByChannel["C-shared"] = [message(ROOT_TS, "U-alice", "Hello")];
    await syncAt("2026-02-01T12:00:00Z");

    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
    let state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).not.toBeNull();

    await upsertSlackConversationMapping({
      integrationId: INTEGRATION_ID,
      conversationId: "C-shared",
      kind: "shared_channel",
      label: "#acme-support",
      customerId: acmeId,
    });
    state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).toBeNull();
    expect(state.syncFingerprint).toBeNull();

    await expect(
      deleteSlackConversationMapping(INTEGRATION_ID, "C-shared")
    ).resolves.toBe(true);
    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(0);
    expect(await countSlackConversationMappings(INTEGRATION_ID)).toBe(0);

    await expect(
      deleteSlackConversationMapping(INTEGRATION_ID, "C-shared")
    ).resolves.toBe(false);
  });

  it("stores, replaces, and preserves member snapshots per the tri-state", async () => {
    await connect();
    const { acmeId } = await seedParties();
    const members = [
      {
        slackUserId: "U-me",
        name: "Me",
        email: "me@our-company.example",
        isExternal: false,
      },
      {
        slackUserId: "U-alice",
        name: "Alice External",
        email: "alice@acme.example",
        isExternal: true,
      },
    ];

    await upsertSlackConversationMapping({
      integrationId: INTEGRATION_ID,
      conversationId: "C-shared",
      kind: "shared_channel",
      label: "#acme-support",
      customerId: acmeId,
      members,
    });

    const mapping = await prisma.slackConversationMapping.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, conversationId: "C-shared" },
      select: { id: true },
    });
    expect(
      await prisma.slackConversationMember.count({
        where: { mappingId: mapping.id },
      })
    ).toBe(2);

    // An empty snapshot is a genuine empty conversation and replaces the rows.
    await upsertSlackConversationMapping({
      integrationId: INTEGRATION_ID,
      conversationId: "C-shared",
      kind: "shared_channel",
      label: "#acme-support",
      customerId: acmeId,
      members: [],
    });
    expect(
      await prisma.slackConversationMember.count({
        where: { mappingId: mapping.id },
      })
    ).toBe(0);

    // No snapshot means the lookup failed: the existing rows must survive.
    await upsertSlackConversationMapping({
      integrationId: INTEGRATION_ID,
      conversationId: "C-shared",
      kind: "shared_channel",
      label: "#acme-support",
      customerId: acmeId,
      members,
    });
    await upsertSlackConversationMapping({
      integrationId: INTEGRATION_ID,
      conversationId: "C-shared",
      kind: "shared_channel",
      label: "#acme-support (renamed)",
      customerId: acmeId,
    });
    expect(
      await prisma.slackConversationMember.count({
        where: { mappingId: mapping.id },
      })
    ).toBe(2);

    await expect(
      deleteSlackConversationMapping(INTEGRATION_ID, "C-shared")
    ).resolves.toBe(true);
    expect(
      await prisma.slackConversationMember.count({
        where: { mappingId: mapping.id },
      })
    ).toBe(0);
  });

  it("clears old author contacts on remap and reattributes on a full run", async () => {
    await connect();
    const { acmeId, betaId } = await seedParties();
    const betaAlice = await prisma.contact.create({
      data: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "alice-beta",
        name: "Alice Beta",
        email: "alice@acme.example",
        customerId: betaId,
      },
      select: { id: true },
    });
    await mapConversation("C-shared", acmeId);

    serveSyncApi();
    historyByChannel["C-shared"] = [message(ROOT_TS, "U-alice", "Hello")];
    await syncAt("2026-02-01T12:00:00Z");

    const first = await prisma.slackMessage.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(first.authorContactId).not.toBeNull();

    await mapConversation("C-shared", betaId);

    // Cleared immediately, so the detail page cannot show the previous
    // customer's contact while waiting for the rescan.
    const cleared = await prisma.slackMessage.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(cleared.authorContactId).toBeNull();
    expect(cleared.mappingId).toBe(first.mappingId);

    const second = await syncAt("2026-02-02T12:00:00Z");
    expect(second.status).toBe("success");

    const messages = await prisma.slackMessage.findMany({
      where: { integrationId: INTEGRATION_ID },
      include: { mapping: true, authorContact: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.mapping.customerId).toBe(betaId);
    expect(messages[0]?.authorContactId).toBe(betaAlice.id);
    expect(messages[0]?.authorContact?.customerId).toBe(betaId);
  });
});

describe("credential identity changes", () => {
  async function seedStoredConversation(): Promise<void> {
    await connect();
    const { acmeId } = await seedParties();
    await mapConversation("C-shared", acmeId);

    const mapping = await prisma.slackConversationMapping.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, conversationId: "C-shared" },
      select: { id: true },
    });

    await prisma.slackMessage.create({
      data: {
        integrationId: INTEGRATION_ID,
        externalSourceId: `C-shared:${ROOT_TS}`,
        mappingId: mapping.id,
        authorId: "U-alice",
        authorIsExternal: true,
        threadRootTs: ROOT_TS,
        sentAt: new Date("2026-01-15T10:00:00Z"),
        direction: "received",
      },
    });
  }

  function authorizeResponse(teamId: string, userId: string) {
    server.use(
      http.post(`${API}/oauth.v2.access`, () =>
        json({
          ok: true,
          team: { id: teamId, name: teamId === "T1" ? "Acme" : "Other" },
          authed_user: {
            id: userId,
            access_token: "new-user-token",
            scope: "im:read,users:read",
          },
        })
      ),
      http.post(`${API}/auth.test`, () =>
        json({ ok: true, team_id: teamId, user_id: userId })
      ),
      http.get(`${API}/users.info`, ({ request }) =>
        json({
          ok: true,
          user: {
            id: new URL(request.url).searchParams.get("user"),
            profile: { email: "new@example.test", real_name: "New User" },
          },
        })
      )
    );
  }

  async function reconnect(): Promise<void> {
    const request = await buildAuthorizationRequest({
      subject: { kind: "integration", integrationId: INTEGRATION_ID },
      providerName: "slack",
      functionNames: ["communication"],
    });

    const result = await handleCallback({
      providerName: "slack",
      code: "authorization-code",
      state: request.state,
    });
    expect(result.ok).toBe(true);
  }

  it("clears conversation data when the workspace changes", async () => {
    await seedStoredConversation();
    authorizeResponse("T2", "U-me");

    await reconnect();

    expect(await countSlackConversationMappings(INTEGRATION_ID)).toBe(0);
    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(0);
    const token = await findToken(INTEGRATION_ID);
    expect(token?.metadata["teamId"]).toBe("T2");
  });

  it("clears conversation data when the authorizing user changes", async () => {
    await seedStoredConversation();
    authorizeResponse("T1", "U-other");

    await reconnect();

    expect(await countSlackConversationMappings(INTEGRATION_ID)).toBe(0);
    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(0);
    const token = await findToken(INTEGRATION_ID);
    expect(token?.metadata["userId"]).toBe("U-other");
  });

  it("keeps conversation data when the same user reconnects", async () => {
    await seedStoredConversation();
    authorizeResponse("T1", "U-me");

    await reconnect();

    expect(await countSlackConversationMappings(INTEGRATION_ID)).toBe(1);
    expect(await prisma.slackMessage.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
  });
});

describe("disconnect", () => {
  it("revokes both the access and refresh token", async () => {
    await connect();
    await saveToken({
      integrationId: INTEGRATION_ID,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: NON_EXPIRING_AT,
      grantedScopes: [],
      metadata: { teamId: "T1", userId: "U-me" },
    });

    const revocations: string[] = [];
    server.use(
      http.get(`${API}/auth.revoke`, ({ request }) => {
        revocations.push(new URL(request.url).searchParams.get("token") ?? "");
        return json({ ok: true, revoked: true });
      })
    );

    await expect(revokeTokens(INTEGRATION_ID)).resolves.toBe(true);
    expect(revocations.sort()).toEqual(["access-token", "refresh-token"]);
  });
});
