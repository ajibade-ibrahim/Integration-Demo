/**
 * Slack conversation reads and retention.
 *
 * Slack is conversation-centric: a mapping, not a message, is the unit the
 * customer UI lists. A mapped conversation with no stored messages is still a
 * real row, so the list is built from `SlackConversationMapping` and only then
 * decorated with counts and the latest message. Reading it the other way round
 * — from messages with an included mapping — would silently drop every empty
 * conversation and turn the tab count into a message count.
 *
 * Every read is scoped by `integration.userId`, including the detail lookup, so
 * a mapping id from another tenant answers as "not found".
 *
 * The detail is bounded to the latest `SLACK_CONVERSATION_MESSAGE_LIMIT`
 * messages. Grouping happens here rather than in the page because a thread's
 * root and its retained replies are one decision: a root outside the window
 * must render the replies under an explicit notice, not disappear.
 */

import { prisma } from "@/lib/prisma";
import type { SlackConversationKind } from "../communication/types";
import { slackConversationMessageLimit } from "../providers/slack/config";

export interface SlackConversationMemberView {
  slackUserId: string;
  name: string | null;
  email: string | null;
  isExternal: boolean;
}

export interface SlackConversationLatestMessage {
  authorId: string;
  authorName: string | null;
  sentAt: Date;
  snippet: string | null;
}

/** One row per mapped conversation, including ones with no messages. */
export interface SlackConversationListRow {
  mappingId: string;
  conversationId: string;
  conversationKind: SlackConversationKind;
  label: string;
  customerId: string;
  customerName: string;
  integrationLabel: string;
  memberCount: number;
  messageCount: number;
  latestMessage: SlackConversationLatestMessage | null;
}

export interface SlackConversationThreadMessage {
  id: string;
  externalSourceId: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
  authorIsExternal: boolean;
  threadRootTs: string;
  /** True when this message is the thread root rather than a reply. */
  isThreadRoot: boolean;
  sentAt: Date;
  direction: string;
  bodyText: string | null;
  snippet: string | null;
  authorContactName: string | null;
}

export interface SlackConversationThread {
  threadRootTs: string;
  /**
   * False when the root is older than the loaded window. The replies are still
   * shown, under a notice naming the root timestamp rather than pretending the
   * thread starts with them.
   */
  rootRetained: boolean;
  messages: SlackConversationThreadMessage[];
}

export interface SlackConversationDetail {
  mappingId: string;
  conversationId: string;
  conversationKind: SlackConversationKind;
  label: string;
  integrationLabel: string;
  providerName: string;
  customer: { id: string; name: string };
  members: SlackConversationMemberView[];
  totalMessageCount: number;
  loadedMessageCount: number;
  threads: SlackConversationThread[];
}

/**
 * Every mapped conversation this user owns, newest activity first.
 *
 * Counts come from `_count` and the latest message from a grouped `_max` plus
 * one lookup, rather than `include: { messages: { take: 1 } }`. The include
 * would filter the *messages* relation, not the mappings, which turns the read
 * into an inner join and drops zero-message conversations.
 */
export async function loadSlackConversationsForUser(
  userId: string,
  kind?: SlackConversationKind
): Promise<SlackConversationListRow[]> {
  const mappings = await prisma.slackConversationMapping.findMany({
    where: {
      integration: { userId },
      ...(kind === undefined ? {} : { conversationKind: kind }),
    },
    select: {
      id: true,
      conversationId: true,
      conversationKind: true,
      label: true,
      customer: { select: { id: true, name: true } },
      integration: { select: { instanceLabel: true } },
      _count: { select: { members: true, messages: true } },
    },
  });

  if (mappings.length === 0) return [];

  const mappingIds = mappings.map((mapping) => mapping.id);
  const maxima = await prisma.slackMessage.groupBy({
    by: ["mappingId"],
    where: { integration: { userId }, mappingId: { in: mappingIds } },
    _max: { sentAt: true },
  });

  const latestByMapping = new Map<string, SlackConversationLatestMessage>();
  const withMessages = maxima.flatMap((entry) =>
    entry._max.sentAt === null
      ? []
      : [{ mappingId: entry.mappingId, sentAt: entry._max.sentAt }]
  );

  if (withMessages.length > 0) {
    const latestRows = await prisma.slackMessage.findMany({
      where: {
        integration: { userId },
        OR: withMessages.map((entry) => ({
          mappingId: entry.mappingId,
          sentAt: entry.sentAt,
        })),
      },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      select: {
        mappingId: true,
        authorId: true,
        authorName: true,
        sentAt: true,
        snippet: true,
      },
    });

    // The OR can match more than one row for a mapping when messages share a
    // timestamp; the newest-by-id wins because of the ordering above.
    for (const row of latestRows) {
      if (latestByMapping.has(row.mappingId)) continue;
      latestByMapping.set(row.mappingId, {
        authorId: row.authorId,
        authorName: row.authorName,
        sentAt: row.sentAt,
        snippet: row.snippet,
      });
    }
  }

  const rows: SlackConversationListRow[] = mappings.map((mapping) => ({
    mappingId: mapping.id,
    conversationId: mapping.conversationId,
    conversationKind: mapping.conversationKind as SlackConversationKind,
    label: mapping.label,
    customerId: mapping.customer.id,
    customerName: mapping.customer.name,
    integrationLabel: mapping.integration.instanceLabel,
    memberCount: mapping._count.members,
    messageCount: mapping._count.messages,
    latestMessage: latestByMapping.get(mapping.id) ?? null,
  }));

  return rows.sort((a, b) => {
    if (a.latestMessage === null && b.latestMessage === null) {
      return a.label.localeCompare(b.label);
    }
    if (a.latestMessage === null) return 1;
    if (b.latestMessage === null) return -1;
    const byTime = b.latestMessage.sentAt.getTime() - a.latestMessage.sentAt.getTime();
    if (byTime !== 0) return byTime;
    return a.label.localeCompare(b.label);
  });
}

/** The Slack tab count is conversations, not messages. */
export async function countSlackConversationsForUser(
  userId: string
): Promise<number> {
  return prisma.slackConversationMapping.count({
    where: { integration: { userId } },
  });
}

type ThreadMessageRow = {
  id: string;
  externalSourceId: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
  authorIsExternal: boolean;
  threadRootTs: string;
  sentAt: Date;
  direction: string;
  bodyText: string | null;
  snippet: string | null;
  authorContact: { name: string } | null;
};

function toThreadMessage(
  row: ThreadMessageRow,
  conversationId: string
): SlackConversationThreadMessage {
  return {
    id: row.id,
    externalSourceId: row.externalSourceId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    authorIsExternal: row.authorIsExternal,
    threadRootTs: row.threadRootTs,
    isThreadRoot:
      row.externalSourceId === `${conversationId}:${row.threadRootTs}`,
    sentAt: row.sentAt,
    direction: row.direction,
    bodyText: row.bodyText,
    snippet: row.snippet,
    authorContactName: row.authorContact?.name ?? null,
  };
}

/**
 * Group the loaded messages into thread blocks.
 *
 * Blocks are ordered by the root's time when the root is retained, otherwise by
 * the earliest retained reply; equal times fall back to the root timestamp so
 * the order is stable between requests. Messages inside a block are ascending.
 */
function groupThreads(
  messages: readonly SlackConversationThreadMessage[]
): SlackConversationThread[] {
  const byRoot = new Map<string, SlackConversationThreadMessage[]>();
  for (const message of messages) {
    const group = byRoot.get(message.threadRootTs) ?? [];
    group.push(message);
    byRoot.set(message.threadRootTs, group);
  }

  const threads = [...byRoot.entries()].map(([threadRootTs, group]) => {
    const chronological = [...group].sort((a, b) => {
      const byTime = a.sentAt.getTime() - b.sentAt.getTime();
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
    const root = chronological.find((message) => message.isThreadRoot);
    // The root leads its block even if a reply carries an earlier timestamp:
    // a thread is defined by its root, and rendering a reply above the message
    // it answers would read as two threads that happen to share a block.
    const messages =
      root === undefined
        ? chronological
        : [root, ...chronological.filter((message) => message !== root)];

    return {
      threadRootTs,
      rootRetained: root !== undefined,
      messages,
      sortTime: (root ?? chronological[0])?.sentAt.getTime() ?? 0,
    };
  });

  return threads
    .sort((a, b) => {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      return a.threadRootTs.localeCompare(b.threadRootTs);
    })
    .map(({ sortTime: _sortTime, ...thread }) => thread);
}

/**
 * One mapped conversation with its member snapshot and thread groups.
 *
 * The latest-N read is deliberate: loading ascending would truncate the oldest
 * threads instead of the newest, and grouping a partial window is only honest
 * if the caller can say which roots were not reached.
 */
export async function findSlackConversationForUser(
  mappingId: string,
  userId: string
): Promise<SlackConversationDetail | undefined> {
  const mapping = await prisma.slackConversationMapping.findFirst({
    where: { id: mappingId, integration: { userId } },
    select: {
      id: true,
      conversationId: true,
      conversationKind: true,
      label: true,
      customer: { select: { id: true, name: true } },
      integration: { select: { instanceLabel: true, providerName: true } },
      members: {
        orderBy: [
          { isExternal: "desc" },
          { name: "asc" },
          { slackUserId: "asc" },
        ],
        select: {
          slackUserId: true,
          name: true,
          email: true,
          isExternal: true,
        },
      },
      _count: { select: { messages: true } },
    },
  });
  if (mapping === null) return undefined;

  const rows = await prisma.slackMessage.findMany({
    where: { mappingId: mapping.id, integration: { userId } },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: slackConversationMessageLimit(),
    select: {
      id: true,
      externalSourceId: true,
      authorId: true,
      authorName: true,
      authorEmail: true,
      authorIsExternal: true,
      threadRootTs: true,
      sentAt: true,
      direction: true,
      bodyText: true,
      snippet: true,
      authorContact: { select: { name: true } },
    },
  });

  const messages = rows.map((row) =>
    toThreadMessage(row, mapping.conversationId)
  );

  return {
    mappingId: mapping.id,
    conversationId: mapping.conversationId,
    conversationKind: mapping.conversationKind as SlackConversationKind,
    label: mapping.label,
    integrationLabel: mapping.integration.instanceLabel,
    providerName: mapping.integration.providerName,
    customer: mapping.customer,
    members: mapping.members,
    totalMessageCount: mapping._count.messages,
    loadedMessageCount: messages.length,
    threads: groupThreads(messages),
  };
}

/**
 * Delete one integration's Slack messages older than the retained window.
 *
 * Member snapshots are configuration-like and are not pruned: they describe the
 * conversation, not a point in its history.
 */
export async function pruneSlackMessagesForIntegration(
  integrationId: string,
  cutoff: Date
): Promise<number> {
  const result = await prisma.slackMessage.deleteMany({
    where: { integrationId, sentAt: { lt: cutoff } },
  });
  return result.count;
}

/** Delete expired Slack messages for every integration, including inactive ones. */
export async function pruneExpiredSlackMessages(
  cutoff: Date
): Promise<number> {
  const result = await prisma.slackMessage.deleteMany({
    where: { sentAt: { lt: cutoff } },
  });
  return result.count;
}
