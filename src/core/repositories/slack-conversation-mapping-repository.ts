/**
 * Slack conversation-to-customer mapping persistence.
 *
 * The mapping is the source of truth for Slack: a conversation with no row here
 * is never fetched. Every write therefore has to reset the communication
 * function's complete-pass state, because the set of conversations a complete
 * acquisition covers has changed. Leaving the watermark alone would make the
 * next run incremental against a window that no longer describes what was read.
 *
 * Messages and members cascade from a deleted mapping, so removal is a plain
 * delete rather than the prefix match the generic message table needed.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  SlackConversationKind,
  SlackConversationMappingView,
  SlackConversationMemberSnapshot,
} from "../communication/types";

const COMMUNICATION_FUNCTION = "communication";

/** Bounded so a very large tenant cannot build an unbounded dropdown. */
const CUSTOMER_OPTION_LIMIT = 500;

/**
 * Reset the communication complete-pass state.
 *
 * Null rather than "now": the next run must take the full-window path, and a
 * null watermark is the engine's encoding of "no complete acquisition exists".
 * `syncFingerprint` goes with it because the two are written as a pair.
 */
async function resetCommunicationSyncStateWith(
  db: Prisma.TransactionClient,
  integrationId: string
): Promise<void> {
  await db.integrationFunction.updateMany({
    where: { integrationId, functionName: COMMUNICATION_FUNCTION },
    data: { lastCompleteSyncAt: null, syncFingerprint: null },
  });
}

export async function resetCommunicationSyncState(
  integrationId: string
): Promise<void> {
  await resetCommunicationSyncStateWith(prisma, integrationId);
}

export async function listSlackConversationMappings(
  integrationId: string
): Promise<SlackConversationMappingView[]> {
  const rows = await prisma.slackConversationMapping.findMany({
    where: { integrationId },
    orderBy: { label: "asc" },
    select: {
      id: true,
      conversationId: true,
      conversationKind: true,
      label: true,
      customerId: true,
      customer: { select: { name: true, customerAccountId: true } },
    },
  });

  return rows.map((row) => ({
    mappingId: row.id,
    conversationId: row.conversationId,
    conversationKind: row.conversationKind as SlackConversationKind,
    label: row.label,
    customerId: row.customerId,
    customerName: row.customer.name,
    ...(row.customer.customerAccountId === null
      ? {}
      : { customerAccountId: row.customer.customerAccountId }),
  }));
}

export async function countSlackConversationMappings(
  integrationId: string
): Promise<number> {
  return prisma.slackConversationMapping.count({ where: { integrationId } });
}

export async function findSlackConversationMapping(
  integrationId: string,
  conversationId: string
): Promise<{ conversationId: string; customerId: string } | undefined> {
  const row = await prisma.slackConversationMapping.findUnique({
    where: {
      integrationId_conversationId: { integrationId, conversationId },
    },
    select: { conversationId: true, customerId: true },
  });
  return row ?? undefined;
}

export interface UpsertSlackConversationMappingInput {
  integrationId: string;
  conversationId: string;
  kind: SlackConversationKind;
  label: string;
  customerId: string;
  /**
   * The refreshed member snapshot. Absent means the lookup failed or was not
   * attempted; the stored snapshot is then left alone. An empty array is a
   * genuine empty conversation and replaces it.
   */
  members?: readonly SlackConversationMemberSnapshot[];
}

async function replaceMembersWith(
  db: Prisma.TransactionClient,
  integrationId: string,
  mappingId: string,
  members: readonly SlackConversationMemberSnapshot[]
): Promise<void> {
  const ids = members.map((member) => member.slackUserId);

  await db.slackConversationMember.deleteMany({
    where: {
      integrationId,
      mappingId,
      ...(ids.length === 0 ? {} : { slackUserId: { notIn: ids } }),
    },
  });

  for (const member of members) {
    const data = {
      name: member.name ?? null,
      email: member.email ?? null,
      isExternal: member.isExternal,
    };
    await db.slackConversationMember.upsert({
      where: {
        mappingId_slackUserId: { mappingId, slackUserId: member.slackUserId },
      },
      create: {
        integrationId,
        mappingId,
        slackUserId: member.slackUserId,
        ...data,
      },
      update: data,
    });
  }
}

/**
 * Create or re-point one conversation mapping and reset the sync watermark.
 *
 * Validation — that the conversation is eligible and the customer is owned by
 * the caller — belongs to the route, which is the layer that can answer with a
 * useful error. This function only persists.
 *
 * Re-pointing a mapping keeps its messages but clears their author-contact
 * links immediately. Waiting for the rescan would show a contact belonging to
 * the previous customer until the run completes.
 */
export async function upsertSlackConversationMapping(
  input: UpsertSlackConversationMappingInput
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const existing = await tx.slackConversationMapping.findUnique({
        where: {
          integrationId_conversationId: {
            integrationId: input.integrationId,
            conversationId: input.conversationId,
          },
        },
        select: { id: true, customerId: true },
      });

      const mapping = await tx.slackConversationMapping.upsert({
        where: {
          integrationId_conversationId: {
            integrationId: input.integrationId,
            conversationId: input.conversationId,
          },
        },
        create: {
          integrationId: input.integrationId,
          conversationId: input.conversationId,
          conversationKind: input.kind,
          label: input.label,
          customerId: input.customerId,
        },
        update: {
          conversationKind: input.kind,
          label: input.label,
          customerId: input.customerId,
        },
        select: { id: true },
      });

      if (input.members !== undefined) {
        await replaceMembersWith(
          tx,
          input.integrationId,
          mapping.id,
          input.members
        );
      }

      if (existing !== null && existing.customerId !== input.customerId) {
        await tx.slackMessage.updateMany({
          where: {
            integrationId: input.integrationId,
            mappingId: mapping.id,
          },
          data: { authorContactId: null },
        });
      }

      await resetCommunicationSyncStateWith(tx, input.integrationId);
    },
    { timeout: 30_000 }
  );
}

/**
 * Remove one mapping and, by cascade, its messages and member snapshot.
 *
 * @returns Whether a mapping existed. The route refuses to delete a
 *   conversation that was never mapped rather than reporting success for a
 *   no-op.
 */
export async function deleteSlackConversationMapping(
  integrationId: string,
  conversationId: string
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const deleted = await tx.slackConversationMapping.deleteMany({
        where: { integrationId, conversationId },
      });
      if (deleted.count === 0) return false;

      await resetCommunicationSyncStateWith(tx, integrationId);
      return true;
    },
    { timeout: 30_000 }
  );
}

/**
 * Delete every Slack mapping for one integration, cascading its messages and
 * member rows.
 *
 * Used when the credential now points at a different workspace or a different
 * authorizing user: the visible conversation set and the provider's ids are no
 * longer the same, so nothing keyed by either can be trusted.
 */
export async function clearSlackConversationDataForIntegration(
  integrationId: string
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.slackConversationMapping.deleteMany({ where: { integrationId } });
      await resetCommunicationSyncStateWith(tx, integrationId);
    },
    { timeout: 30_000 }
  );
}

/**
 * Root `ts` values already stored for each mapped conversation.
 *
 * Stored directly on the message now, so no prefix splitting is needed.
 * Incremental runs use this to refresh replies to roots that have fallen out of
 * the overlap window without scanning the conversation's whole history.
 */
export async function listSlackThreadRoots(
  integrationId: string,
  conversationIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (conversationIds.length === 0) return new Map();

  const rows = await prisma.slackMessage.findMany({
    where: {
      integrationId,
      mapping: { conversationId: { in: [...conversationIds] } },
    },
    select: {
      mappingId: true,
      threadRootTs: true,
      mapping: { select: { conversationId: true } },
    },
    distinct: ["mappingId", "threadRootTs"],
  });

  const rootsByConversation = new Map<string, string[]>();
  for (const row of rows) {
    if (row.threadRootTs === "") continue;
    const conversationId = row.mapping.conversationId;
    rootsByConversation.set(conversationId, [
      ...(rootsByConversation.get(conversationId) ?? []),
      row.threadRootTs,
    ]);
  }

  return rootsByConversation;
}

export interface CustomerOption {
  id: string;
  name: string;
  integrationLabel: string;
  customerAccountId?: string;
}

/**
 * Customers this user may map a conversation to.
 *
 * Read directly rather than through `loadSyncedData`, whose 200-row cap is a
 * data-browser limit, not a picker limit. The bound here is its own constant so
 * the two cannot constrain each other.
 */
export async function listCustomerOptionsForUser(
  userId: string,
  search?: string
): Promise<CustomerOption[]> {
  const trimmed = search?.trim() ?? "";
  const rows = await prisma.customer.findMany({
    where: {
      integration: { userId },
      ...(trimmed === ""
        ? {}
        : { name: { contains: trimmed, mode: "insensitive" } }),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: CUSTOMER_OPTION_LIMIT,
    select: {
      id: true,
      name: true,
      customerAccountId: true,
      integration: { select: { instanceLabel: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    integrationLabel: row.integration.instanceLabel,
    ...(row.customerAccountId === null
      ? {}
      : { customerAccountId: row.customerAccountId }),
  }));
}

/** Whether a customer exists and belongs to this user. */
export async function customerBelongsToUser(
  customerId: string,
  userId: string
): Promise<boolean> {
  const row = await prisma.customer.findFirst({
    where: { id: customerId, integration: { userId } },
    select: { id: true },
  });
  return row !== null;
}
