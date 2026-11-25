/**
 * Slack conversation reads: the conversation-centric list and the
 * thread-grouped, bounded detail.
 *
 * Seeded directly rather than through a sync so the tests can pin message
 * timestamps, thread roots and an empty conversation — the cases a provider
 * response makes awkward to arrange.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  countSlackConversationsForUser,
  findSlackConversationForUser,
  loadSlackConversationsForUser,
} from "@/core/repositories/slack-conversation-repository";

const USER_ID = "user-slack-conversation-reads";
const OTHER_USER_ID = "user-slack-conversation-reads-other";
const INTEGRATION_ID = "integration-slack-conversation-reads";
const OTHER_INTEGRATION_ID = "integration-slack-conversation-reads-other";

const LIMIT_KEY = "SLACK_CONVERSATION_MESSAGE_LIMIT";
const savedLimit = process.env[LIMIT_KEY];

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "slack-conversations@example.test" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: OTHER_USER_ID },
    create: { id: OTHER_USER_ID, email: "slack-conversations-other@example.test" },
    update: {},
  });
});

afterEach(() => {
  delete process.env[LIMIT_KEY];
  if (savedLimit !== undefined) process.env[LIMIT_KEY] = savedLimit;
});

afterAll(async () => {
  await prisma.integration.deleteMany({
    where: { id: { in: [INTEGRATION_ID, OTHER_INTEGRATION_ID] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [USER_ID, OTHER_USER_ID] } },
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({
    where: { id: { in: [INTEGRATION_ID, OTHER_INTEGRATION_ID] } },
  });
});

async function createIntegration(
  id: string,
  userId: string,
  label: string
): Promise<void> {
  await prisma.integration.create({
    data: {
      id,
      userId,
      providerName: "slack",
      status: "active",
      instanceLabel: label,
      functions: { create: [{ functionName: "communication" }] },
    },
  });
}

async function createCustomer(name: string, integrationId = INTEGRATION_ID) {
  return prisma.customer.create({
    data: {
      integrationId,
      externalSourceId: `customer-${name}`,
      name,
    },
    select: { id: true },
  });
}

async function createMapping(args: {
  integrationId?: string;
  conversationId: string;
  kind: "shared_channel" | "connect_dm" | "group_dm";
  label: string;
  customerId: string;
}) {
  return prisma.slackConversationMapping.create({
    data: {
      integrationId: args.integrationId ?? INTEGRATION_ID,
      conversationId: args.conversationId,
      conversationKind: args.kind,
      label: args.label,
      customerId: args.customerId,
    },
    select: { id: true },
  });
}

async function createMessage(args: {
  externalSourceId: string;
  mappingId: string;
  ts: string;
  sentAt: string;
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
  authorExternal?: boolean;
  threadRootTs?: string;
  bodyText?: string;
  snippet?: string;
  direction?: string;
  authorContactId?: string;
}) {
  return prisma.slackMessage.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: args.externalSourceId,
      mappingId: args.mappingId,
      authorId: args.authorId ?? "U-alice",
      authorName: args.authorName ?? "Alice External",
      authorEmail: args.authorEmail ?? "alice@acme.example",
      authorIsExternal: args.authorExternal ?? true,
      threadRootTs: args.threadRootTs ?? args.ts,
      bodyText: args.bodyText ?? null,
      snippet: args.snippet ?? null,
      sentAt: new Date(args.sentAt),
      direction: args.direction ?? "received",
      authorContactId: args.authorContactId ?? null,
    },
  });
}

describe("loadSlackConversationsForUser", () => {
  it("lists one row per mapping, including conversations with no messages", async () => {
    await createIntegration(INTEGRATION_ID, USER_ID, "Slack Acme");
    const acme = await createCustomer("Acme");

    const quiet = await createMapping({
      conversationId: "D-quiet",
      kind: "connect_dm",
      label: "DM with Alice",
      customerId: acme.id,
    });
    const busy = await createMapping({
      conversationId: "C-busy",
      kind: "shared_channel",
      label: "#acme-support",
      customerId: acme.id,
    });
    const group = await createMapping({
      conversationId: "M-group",
      kind: "group_dm",
      label: "Group DM with Alice",
      customerId: acme.id,
    });

    await prisma.slackConversationMember.createMany({
      data: [
        {
          integrationId: INTEGRATION_ID,
          mappingId: busy.id,
          slackUserId: "U-me",
          isExternal: false,
        },
        {
          integrationId: INTEGRATION_ID,
          mappingId: busy.id,
          slackUserId: "U-alice",
          name: "Alice External",
          isExternal: true,
        },
      ],
    });

    await createMessage({
      externalSourceId: "C-busy:100",
      mappingId: busy.id,
      ts: "100",
      sentAt: "2026-01-15T10:00:00Z",
      bodyText: "older",
    });
    await createMessage({
      externalSourceId: "C-busy:200",
      mappingId: busy.id,
      ts: "200",
      sentAt: "2026-01-16T10:00:00Z",
      authorId: "U-alice",
      authorName: "Alice External",
      snippet: "newest",
    });
    await createMessage({
      externalSourceId: "M-group:300",
      mappingId: group.id,
      ts: "300",
      sentAt: "2026-01-17T10:00:00Z",
      authorId: "U-alice",
      authorName: "Alice External",
      snippet: "group message",
    });

    const rows = await loadSlackConversationsForUser(USER_ID);

    // Newest activity first, the zero-message conversation last.
    expect(rows.map((row) => row.mappingId)).toEqual([
      group.id,
      busy.id,
      quiet.id,
    ]);

    const busyRow = rows.find((row) => row.mappingId === busy.id);
    expect(busyRow).toMatchObject({
      conversationId: "C-busy",
      conversationKind: "shared_channel",
      label: "#acme-support",
      customerName: "Acme",
      integrationLabel: "Slack Acme",
      memberCount: 2,
      messageCount: 2,
    });
    expect(busyRow?.latestMessage).toMatchObject({
      authorId: "U-alice",
      authorName: "Alice External",
      snippet: "newest",
    });

    const quietRow = rows.find((row) => row.mappingId === quiet.id);
    expect(quietRow).toMatchObject({ messageCount: 0, memberCount: 0 });
    expect(quietRow?.latestMessage).toBeNull();

    expect(await countSlackConversationsForUser(USER_ID)).toBe(3);
  });

  it("filters by conversation kind", async () => {
    await createIntegration(INTEGRATION_ID, USER_ID, "Slack Acme");
    const acme = await createCustomer("Acme");

    await createMapping({
      conversationId: "C-one",
      kind: "shared_channel",
      label: "#one",
      customerId: acme.id,
    });
    await createMapping({
      conversationId: "D-one",
      kind: "connect_dm",
      label: "DM one",
      customerId: acme.id,
    });

    const shared = await loadSlackConversationsForUser(USER_ID, "shared_channel");
    expect(shared.map((row) => row.conversationId)).toEqual(["C-one"]);

    const dms = await loadSlackConversationsForUser(USER_ID, "connect_dm");
    expect(dms.map((row) => row.conversationId)).toEqual(["D-one"]);

    // The tab count is not the filtered count.
    expect(await countSlackConversationsForUser(USER_ID)).toBe(2);
  });

  it("does not read another tenant's conversations", async () => {
    await createIntegration(INTEGRATION_ID, USER_ID, "Slack Acme");
    await createIntegration(OTHER_INTEGRATION_ID, OTHER_USER_ID, "Slack Other");
    const acme = await createCustomer("Acme");
    const other = await createCustomer("Other", OTHER_INTEGRATION_ID);

    await createMapping({
      conversationId: "C-mine",
      kind: "shared_channel",
      label: "#mine",
      customerId: acme.id,
    });
    const otherMapping = await createMapping({
      integrationId: OTHER_INTEGRATION_ID,
      conversationId: "C-theirs",
      kind: "shared_channel",
      label: "#theirs",
      customerId: other.id,
    });
    await createMessage({
      externalSourceId: "C-theirs:100",
      mappingId: otherMapping.id,
      ts: "100",
      sentAt: "2026-01-15T10:00:00Z",
    });

    const rows = await loadSlackConversationsForUser(USER_ID);
    expect(rows.map((row) => row.conversationId)).toEqual(["C-mine"]);
    expect(await countSlackConversationsForUser(USER_ID)).toBe(1);
  });
});

describe("findSlackConversationForUser", () => {
  it("groups messages into thread blocks ordered by root time", async () => {
    await createIntegration(INTEGRATION_ID, USER_ID, "Slack Acme");
    const acme = await createCustomer("Acme");
    const contact = await prisma.contact.create({
      data: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "alice",
        name: "Alice Contact",
        email: "alice@acme.example",
        customerId: acme.id,
      },
      select: { id: true },
    });
    const mapping = await createMapping({
      conversationId: "C-threaded",
      kind: "shared_channel",
      label: "#threaded",
      customerId: acme.id,
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
          email: "alice@acme.example",
          isExternal: true,
        },
      ],
    });

    // A root at 10:00 with a deliberately out-of-order reply, a standalone
    // root at 10:10, and a thread whose root is not in the retained set.
    await createMessage({
      externalSourceId: "C-threaded:100.0",
      mappingId: mapping.id,
      ts: "100.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:00:00Z",
      authorId: "U-me",
      authorName: "Me",
      authorExternal: false,
      bodyText: "root one",
      direction: "sent",
    });
    await createMessage({
      externalSourceId: "C-threaded:200.0",
      mappingId: mapping.id,
      ts: "200.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:05:00Z",
      bodyText: "reply later",
      authorContactId: contact.id,
    });
    await createMessage({
      externalSourceId: "C-threaded:150.0",
      mappingId: mapping.id,
      ts: "150.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:02:00Z",
      bodyText: "reply earlier",
    });
    await createMessage({
      externalSourceId: "C-threaded:300.0",
      mappingId: mapping.id,
      ts: "300.0",
      threadRootTs: "300.0",
      sentAt: "2026-01-15T10:10:00Z",
      bodyText: "standalone",
    });
    await createMessage({
      externalSourceId: "C-threaded:900.0",
      mappingId: mapping.id,
      ts: "900.0",
      threadRootTs: "50.0",
      sentAt: "2026-01-15T10:20:00Z",
      bodyText: "reply whose root is gone",
    });

    const detail = await findSlackConversationForUser(mapping.id, USER_ID);
    expect(detail).toBeDefined();
    if (detail === undefined) return;

    expect(detail).toMatchObject({
      conversationId: "C-threaded",
      conversationKind: "shared_channel",
      label: "#threaded",
      integrationLabel: "Slack Acme",
      customer: { id: acme.id, name: "Acme" },
      totalMessageCount: 5,
      loadedMessageCount: 5,
    });
    expect(detail.members.map((member) => member.slackUserId)).toEqual([
      "U-alice",
      "U-me",
    ]);

    expect(detail.threads.map((thread) => thread.threadRootTs)).toEqual([
      "100.0",
      "300.0",
      "50.0",
    ]);
    expect(detail.threads.map((thread) => thread.rootRetained)).toEqual([
      true,
      true,
      false,
    ]);

    const first = detail.threads[0];
    expect(first?.messages.map((message) => message.bodyText)).toEqual([
      "root one",
      "reply earlier",
      "reply later",
    ]);
    expect(first?.messages.map((message) => message.isThreadRoot)).toEqual([
      true,
      false,
      false,
    ]);

    const reply = first?.messages[2];
    expect(reply).toMatchObject({
      authorId: "U-alice",
      authorName: "Alice External",
      authorEmail: "alice@acme.example",
      authorIsExternal: true,
      direction: "received",
      authorContactName: "Alice Contact",
    });

    // A standalone message is a one-message block.
    expect(detail.threads[1]?.messages).toHaveLength(1);

    // Root 50 is older than the loaded window: its reply is retained and
    // flagged so the page can explain the missing root.
    expect(detail.threads[2]).toMatchObject({
      threadRootTs: "50.0",
      rootRetained: false,
    });
    expect(detail.threads[2]?.messages).toHaveLength(1);
  });

  it("loads only the latest N messages and reports the total", async () => {
    process.env[LIMIT_KEY] = "2";
    await createIntegration(INTEGRATION_ID, USER_ID, "Slack Acme");
    const acme = await createCustomer("Acme");
    const mapping = await createMapping({
      conversationId: "C-busy",
      kind: "shared_channel",
      label: "#busy",
      customerId: acme.id,
    });

    await createMessage({
      externalSourceId: "C-busy:100.0",
      mappingId: mapping.id,
      ts: "100.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:00:00Z",
      bodyText: "root",
    });
    await createMessage({
      externalSourceId: "C-busy:200.0",
      mappingId: mapping.id,
      ts: "200.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:01:00Z",
      bodyText: "reply one",
    });
    await createMessage({
      externalSourceId: "C-busy:300.0",
      mappingId: mapping.id,
      ts: "300.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:02:00Z",
      bodyText: "reply two",
    });
    await createMessage({
      externalSourceId: "C-busy:400.0",
      mappingId: mapping.id,
      ts: "400.0",
      threadRootTs: "100.0",
      sentAt: "2026-01-15T10:03:00Z",
      bodyText: "reply three",
    });

    const detail = await findSlackConversationForUser(mapping.id, USER_ID);
    expect(detail).toBeDefined();
    if (detail === undefined) return;

    expect(detail.totalMessageCount).toBe(4);
    expect(detail.loadedMessageCount).toBe(2);
    expect(detail.threads).toHaveLength(1);
    expect(detail.threads[0]).toMatchObject({
      threadRootTs: "100.0",
      rootRetained: false,
    });
    expect(detail.threads[0]?.messages.map((message) => message.bodyText)).toEqual([
      "reply two",
      "reply three",
    ]);
  });

  it("answers as not found for a mapping owned by another user", async () => {
    await createIntegration(OTHER_INTEGRATION_ID, OTHER_USER_ID, "Slack Other");
    const other = await createCustomer("Other", OTHER_INTEGRATION_ID);
    const mapping = await createMapping({
      integrationId: OTHER_INTEGRATION_ID,
      conversationId: "C-theirs",
      kind: "shared_channel",
      label: "#theirs",
      customerId: other.id,
    });

    await expect(
      findSlackConversationForUser(mapping.id, USER_ID)
    ).resolves.toBeUndefined();
  });
});
