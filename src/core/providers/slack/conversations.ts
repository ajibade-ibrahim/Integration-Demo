/**
 * Which Slack conversations a user-token connection may ingest.
 *
 * The eligibility rules are the privacy boundary, so they are stated once and
 * reused by both the mapping picker and the POST that saves a mapping. The
 * picker must not trust a client-supplied kind or label, and the sync must not
 * read a conversation a human could not have chosen.
 *
 * Three surfaces qualify:
 *
 *   - a **shared channel** (`is_ext_shared`), not pending, archived or frozen;
 *     a private one additionally requires membership, because a user token
 *     cannot read a private shared channel it is not in;
 *   - a **Connect DM** whose counterpart is external;
 *   - a **group DM** with at least one external human member.
 *
 * `is_shared` alone is deliberately not used: Enterprise Grid internal sharing
 * sets it too, and an internally shared channel is not a customer conversation.
 */

import { communicationConfig } from "../../communication/config";
import type {
  SlackConversationKind,
  SlackConversationMemberSnapshot,
} from "../../communication/types";
import type { SessionContext } from "../http";
import { asArray, asRecord, asString } from "../http";
import { SlackApiError, slackGet, SlackUserCache } from "./api";

export interface ConversationDescriptor {
  conversationId: string;
  conversationKind: SlackConversationKind;
  label: string;
  isPrivate: boolean;
  isMember: boolean;
  memberCount?: number;
}

export type ConversationValidation =
  | { ok: true; conversation: ConversationDescriptor }
  | { ok: false; error: string };

/** A DM always has two participants; the list endpoint omits `num_members`. */
const DIRECT_MESSAGE_MEMBER_COUNT = 2;

/** How many external names a group-DM label shows before trimming. */
const LABEL_NAME_LIMIT = 3;

/**
 * Every member id of one conversation, following cursors.
 *
 * `conversations.members` is tier-4 and paginated; a single page silently
 * truncates a large channel, which would make both the eligibility check and
 * the stored member snapshot wrong.
 */
async function memberIdsOf(
  ctx: SessionContext,
  conversationId: string
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  const maxPages = communicationConfig().maxPages;

  for (let page = 0; page < maxPages; page += 1) {
    const body = await slackGet(ctx, "conversations.members", {
      channel: conversationId,
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });

    for (const item of asArray(body["members"])) {
      const id = asString(item);
      if (id !== undefined) ids.push(id);
    }

    const next = asString(
      asRecord(body["response_metadata"])?.["next_cursor"]
    );
    if (next === undefined || next === cursor) break;
    cursor = next;
  }

  return ids;
}

/**
 * The human member snapshot for one mapped conversation.
 *
 * Returns `undefined` when the member lookup cannot be completed (a provider
 * rejection such as `channel_not_found`). That is deliberately different from
 * an empty array: `undefined` tells the writer to keep the previous snapshot,
 * while `[]` says the conversation genuinely has no human members left.
 *
 * Bots, deleted users and users invisible to the token are omitted.
 */
export async function listConversationMembers(
  ctx: SessionContext,
  conversationId: string,
  users?: SlackUserCache
): Promise<SlackConversationMemberSnapshot[] | undefined> {
  try {
    const cache =
      users ??
      (await SlackUserCache.load(ctx, {
        teamId: ctx.metadata["teamId"],
        enterpriseId: ctx.metadata["enterpriseId"],
      }));

    const memberIds = await memberIdsOf(ctx, conversationId);
    const snapshot: SlackConversationMemberSnapshot[] = [];

    for (const id of memberIds) {
      const user = await cache.get(id);
      if (user === undefined || user.deleted || user.isBot) continue;

      snapshot.push({
        slackUserId: user.id,
        ...(user.name === undefined ? {} : { name: user.name }),
        ...(user.email === undefined ? {} : { email: user.email }),
        isExternal: cache.isExternal(user),
      });
    }

    return snapshot;
  } catch (error) {
    // A conversation the token can no longer read is a per-conversation gap,
    // not a failed sync or a failed save. Auth and transport errors keep their
    // original meaning.
    if (error instanceof SlackApiError) return undefined;
    throw error;
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function groupLabel(names: readonly string[]): string {
  if (names.length === 0) return "Group DM";
  const shown = names.slice(0, LABEL_NAME_LIMIT);
  const suffix = names.length > LABEL_NAME_LIMIT ? ` and ${names.length - LABEL_NAME_LIMIT} more` : "";
  return `Group DM with ${shown.join(", ")}${suffix}`;
}

async function classify(
  ctx: SessionContext,
  raw: Record<string, unknown>,
  users: SlackUserCache
): Promise<ConversationDescriptor | undefined> {
  const conversationId = asString(raw["id"]);
  if (conversationId === undefined) return undefined;

  if (raw["is_im"] === true) {
    if (raw["is_user_deleted"] === true) return undefined;

    const counterpartId =
      asString(raw["user"]) ??
      (await memberIdsOf(ctx, conversationId)).find(
        (member) => member !== ctx.metadata["userId"]
      );
    if (counterpartId === undefined) return undefined;

    const counterpart = await users.get(counterpartId);
    if (counterpart === undefined || !users.isExternal(counterpart)) {
      return undefined;
    }

    return {
      conversationId,
      conversationKind: "connect_dm",
      label: `DM with ${users.displayName(counterpart, counterpartId)}`,
      isPrivate: true,
      isMember: true,
      memberCount: DIRECT_MESSAGE_MEMBER_COUNT,
    };
  }

  if (raw["is_mpim"] === true) {
    if (raw["is_archived"] === true) return undefined;

    const members = await memberIdsOf(ctx, conversationId);
    const resolved = await Promise.all(members.map((id) => users.get(id)));
    const external = resolved.filter(
      (user): user is NonNullable<typeof user> =>
        user !== undefined && users.isExternal(user)
    );
    // A group DM whose only external member is a bot is not a customer
    // conversation: `isExternal` already rejects bots, so an empty list does.
    if (external.length === 0) return undefined;

    const names = external.map((user) =>
      users.displayName(user, user.id)
    );

    return {
      conversationId,
      conversationKind: "group_dm",
      label: groupLabel(names),
      isPrivate: true,
      isMember: true,
      memberCount: numeric(raw["num_members"]) ?? members.length,
    };
  }

  if (raw["is_channel"] === true) {
    if (raw["is_ext_shared"] !== true) return undefined;
    if (raw["is_pending_ext_shared"] === true) return undefined;
    if (raw["is_archived"] === true) return undefined;
    if (raw["is_frozen"] === true) return undefined;

    const isPrivate = raw["is_private"] === true;
    const isMember = raw["is_member"] === true;
    if (isPrivate && !isMember) return undefined;

    return {
      conversationId,
      conversationKind: "shared_channel",
      label: `#${asString(raw["name"]) ?? conversationId}`,
      isPrivate,
      isMember,
      ...(numeric(raw["num_members"]) === undefined
        ? {}
        : { memberCount: numeric(raw["num_members"]) }),
    };
  }

  return undefined;
}

/** Every conversation the connection can read and may attribute to a customer. */
export async function listEligibleConversations(
  ctx: SessionContext
): Promise<ConversationDescriptor[]> {
  const users = await SlackUserCache.load(ctx, {
    teamId: ctx.metadata["teamId"],
    enterpriseId: ctx.metadata["enterpriseId"],
  });

  const found: ConversationDescriptor[] = [];
  let cursor: string | undefined;
  const maxPages = communicationConfig().maxPages;

  for (let page = 0; page < maxPages; page += 1) {
    const body = await slackGet(ctx, "conversations.list", {
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: "true",
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });

    for (const item of asArray(body["channels"])) {
      const raw = asRecord(item);
      if (raw === undefined) continue;
      const descriptor = await classify(ctx, raw, users);
      if (descriptor !== undefined) found.push(descriptor);
    }

    const next = asString(asRecord(body["response_metadata"])?.["next_cursor"]);
    if (next === undefined || next === cursor) break;
    cursor = next;
  }

  return found.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Re-check one conversation immediately before a mapping is saved.
 *
 * The picker's list can be minutes old, and Slack will silently omit a
 * conversation that was archived, unshared or re-keyed. The POST therefore asks
 * the provider about this exact id rather than trusting what the client last
 * saw.
 */
export async function validateConversationForMapping(
  ctx: SessionContext,
  conversationId: string
): Promise<ConversationValidation> {
  const users = await SlackUserCache.load(ctx, {
    teamId: ctx.metadata["teamId"],
    enterpriseId: ctx.metadata["enterpriseId"],
  });

  let raw: Record<string, unknown> | undefined;
  try {
    const body = await slackGet(ctx, "conversations.info", {
      channel: conversationId,
      include_num_members: "true",
    });
    raw = asRecord(body["channel"]);
  } catch (error) {
    // A vanished or unreadable conversation is a validation result, not a
    // failed request. Auth and transport errors keep their meaning.
    if (error instanceof SlackApiError) {
      return {
        ok: false,
        error: `Slack rejected this conversation: ${error.code}`,
      };
    }
    throw error;
  }

  if (raw === undefined) {
    return { ok: false, error: "Slack returned no conversation details" };
  }

  const descriptor = await classify(ctx, raw, users);
  if (descriptor === undefined) {
    return {
      ok: false,
      error:
        "This conversation is not eligible: it is not a shared channel, an external DM, or a group DM with an external person.",
    };
  }

  return { ok: true, conversation: descriptor };
}
