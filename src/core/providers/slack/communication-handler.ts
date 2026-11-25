/**
 * Slack communication handler.
 *
 * Only conversations a human mapped are read. Slack's history endpoints return
 * newest-first for `conversations.history` and oldest-first for
 * `conversations.replies`, so neither ordering is assumed when deciding
 * `has_more`; each response states its cursor.
 *
 * Three paths can produce the same message — history, a root's replies, and the
 * tracked-thread refresh — so one `Set` of `<conversationId>:<ts>` deduplicates
 * the whole run. Intermediate pages make no completeness claim; the final empty
 * page declares `complete: true` only when every mapped conversation was paged
 * to exhaustion, no page guard fired, and the tracked-thread cap was not hit.
 *
 * A permanent per-conversation error (`channel_not_found`, `not_in_channel`,
 * `is_archived`, `thread_not_found`) is a warning-level skip: a conversation
 * re-keyed by Slack must not fail the run. Authentication errors do fail it.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type { KnownParties } from "../../communication/known-parties";
import type {
  SlackAttribution,
  SlackAuthorContact,
  SlackAuthorContactCandidate,
  SlackConversationMappingView,
  SlackConversationMemberSnapshot,
} from "../../communication/types";
import { EMAIL_MATCH_KINDS } from "../../communication/types";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { communicationConfig } from "../../communication/config";
import { matchAuthorContactsForCustomer } from "../../communication/matching";
import { asArray, asRecord, asString } from "../http";
import {
  dateToSlackTs,
  isIngestibleMessage,
  SlackApiError,
  slackGet,
  slackTsToDate,
  snippetOf,
  SlackUserCache,
} from "./api";
import { listConversationMembers } from "./conversations";

/** Bound on tracked-thread refreshes in one run; tier-3 calls, and a cap is a warning. */
export const MAX_TRACKED_THREAD_REFRESHES = 500;

interface RecordInfo {
  mapping: SlackConversationMappingView;
  authorExternal: boolean;
  /** Resolved authorizing address when token metadata lacked one. */
  mailboxEmail?: string;
  /** `undefined` means the member lookup could not complete. */
  conversationMembers?: readonly SlackConversationMemberSnapshot[];
}

/**
 * Out-of-band data for one raw record.
 *
 * Keeping the mapping, author classification and member snapshot out of the
 * record means they cannot leak into discovery or a saved field mapping, exactly
 * as Gmail keeps its resolved mailbox aside.
 */
const infoByRecord = new WeakMap<object, RecordInfo>();

/** Slack error codes that mean this conversation is gone or unreadable. */
const SKIPPABLE_CONVERSATION_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "thread_not_found",
]);

function conversationSkippable(error: unknown): boolean {
  return (
    error instanceof SlackApiError && SKIPPABLE_CONVERSATION_ERRORS.has(error.code)
  );
}

function chooseAuthorContact(
  candidates: readonly SlackAuthorContactCandidate[],
  mapping: SlackConversationMappingView
): SlackAuthorContact | undefined {
  const best = [...candidates].sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    const kind = EMAIL_MATCH_KINDS.indexOf(a.matchKind) -
      EMAIL_MATCH_KINDS.indexOf(b.matchKind);
    if (kind !== 0) return kind;
    return a.partyKey.localeCompare(b.partyKey);
  })[0];

  if (best === undefined) return undefined;

  return {
    contactId: best.contactId,
    customerId: mapping.customerId,
    ...(best.customerAccountId === undefined
      ? {}
      : { customerAccountId: best.customerAccountId }),
    matchKind: best.matchKind,
    matchedValue: best.matchedValue,
    rank: best.rank,
  };
}

/**
 * Attribution for one Slack message: the mapped customer is primary, and the
 * external author may add a contact belonging to that same customer.
 *
 * Exported as a pure function because the rule is the security boundary — no
 * other company may be attributed through a mapped conversation — and testing
 * it should not require an HTTP server.
 */
export function buildSlackAttribution(args: {
  mapping: SlackConversationMappingView;
  authorEmail?: string;
  authorExternal: boolean;
  knownParties?: KnownParties;
  mailboxEmail?: string;
  conversationMembers?: readonly SlackConversationMemberSnapshot[];
}): SlackAttribution {
  const { mapping } = args;

  let authorContact: SlackAuthorContact | undefined;
  if (
    args.authorExternal &&
    args.authorEmail !== undefined &&
    args.knownParties !== undefined
  ) {
    const parties =
      args.mailboxEmail !== undefined &&
      args.knownParties.mailboxEmail === undefined
        ? { ...args.knownParties, mailboxEmail: args.mailboxEmail }
        : args.knownParties;

    authorContact = chooseAuthorContact(
      matchAuthorContactsForCustomer({
        knownParties: parties,
        addresses: [args.authorEmail],
        customerId: mapping.customerId,
      }),
      mapping
    );
  }

  return {
    kind: "slack",
    mappingId: mapping.mappingId,
    customerId: mapping.customerId,
    authorExternal: args.authorExternal,
    ...(authorContact === undefined ? {} : { authorContact }),
    ...(args.conversationMembers === undefined
      ? {}
      : { conversationMembers: args.conversationMembers }),
  };
}

export const slackCommunicationHandler: SyncHandler = {
  objects: ["slackMessage"],
  attributionObjects: ["slackMessage"],
  conversationScoped: true,
  requiresKnownParties: false,
  streaming: true,

  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const mappings = ctx.slackConversationMappings;
    if (mappings === undefined) {
      throw new Error(
        "Slack communication sync started without conversation mappings"
      );
    }
    if (ctx.communicationWindowStart === undefined) {
      throw new Error("Communication sync started without a window start");
    }
    if (ctx.knownParties === undefined) {
      throw new Error("Communication sync started without known parties");
    }

    if (mappings.length === 0) {
      yield { object: "slackMessage", records: [], complete: true };
      return;
    }

    const config = communicationConfig();
    const windowStart = ctx.communicationWindowStart;
    const oldest = dateToSlackTs(windowStart);
    const limit = String(Math.min(config.pageSize, 200));
    const pageLimit = config.maxPages;

    const users = await SlackUserCache.load(ctx, {
      teamId: ctx.metadata["teamId"],
      enterpriseId: ctx.metadata["enterpriseId"],
    });

    // The engine's known parties already exclude the mailbox when metadata
    // named it. A connection whose token metadata lacks the address resolves it
    // once here so a contact record using the authorizing user's own address is
    // still never attributed to a customer.
    let mailboxEmail =
      ctx.metadata["email"] ?? ctx.metadata["emailAddress"];
    if (
      (mailboxEmail === undefined || mailboxEmail.trim() === "") &&
      ctx.metadata["userId"] !== undefined
    ) {
      mailboxEmail = (await users.get(ctx.metadata["userId"]))?.email;
    }

    const buffer: RawRecord[] = [];
    const seen = new Set<string>();
    const processedThreadRoots = new Set<string>();
    let totalPages = 0;
    let truncated = false;
    let trackedRefreshes = 0;
    let trackedCapHit = false;

    async function addMessage(
      raw: Record<string, unknown>,
      mapping: SlackConversationMappingView,
      members: readonly SlackConversationMemberSnapshot[] | undefined
    ): Promise<void> {
      if (!isIngestibleMessage(raw)) return;

      const ts = asString(raw["ts"]);
      const authorId = asString(raw["user"]);
      if (ts === undefined || authorId === undefined) return;

      const author = await users.get(authorId);
      if (author === undefined || author.deleted || author.isBot) return;

      const sentAt = slackTsToDate(ts);
      if (sentAt === undefined || sentAt.getTime() < windowStart.getTime()) {
        return;
      }

      const externalId = `${mapping.conversationId}:${ts}`;
      if (seen.has(externalId)) return;
      seen.add(externalId);

      const threadRootTs = asString(raw["thread_ts"]) ?? ts;
      const authorExternal = users.isExternal(author);
      const text = asString(raw["text"]);
      const snippet = snippetOf(raw);

      const record: RawRecord = {
        ts,
        channelId: mapping.conversationId,
        threadRootTs,
        conversationLabel: mapping.label,
        conversationKind: mapping.conversationKind,
        authorId,
        ...(author.name === undefined ? {} : { authorName: author.name }),
        // Stored on the message for the source interface even for an internal
        // author. Attribution below uses it only for an external author.
        ...(author.email === undefined ? {} : { authorEmail: author.email }),
        ...(text === undefined ? {} : { bodyText: text }),
        ...(snippet === undefined ? {} : { snippet }),
        sentAtIso: sentAt.toISOString(),
        direction: authorExternal ? "received" : "sent",
      };

      infoByRecord.set(record, {
        mapping,
        authorExternal,
        ...(mailboxEmail === undefined ? {} : { mailboxEmail }),
        ...(members === undefined ? {} : { conversationMembers: members }),
      });
      buffer.push(record);
    }

    /**
     * One paginated Slack list call. `truncated` is set when the shared page
     * guard is reached, which the final page reports as incomplete.
     */
    async function* pagedMessages(
      method: string,
      params: Record<string, string | undefined>
    ): AsyncGenerator<Record<string, unknown>> {
      let cursor: string | undefined;

      for (;;) {
        if (totalPages >= pageLimit) {
          truncated = true;
          return;
        }
        totalPages += 1;

        const body = await slackGet(ctx, method, {
          ...params,
          ...(cursor === undefined ? {} : { cursor }),
        });

        if (body["is_limited"] === true) {
          // Free workspaces truncate history. The messages that are returned
          // are real; the run simply cannot claim the window was complete.
          console.warn(
            `[slack] ${method} reported is_limited for ${params["channel"] ?? "(conversation)"}; history is truncated by the workspace plan`
          );
        }

        for (const item of asArray(body["messages"])) {
          const raw = asRecord(item);
          if (raw !== undefined) yield raw;
        }

        const next = asString(
          asRecord(body["response_metadata"])?.["next_cursor"]
        );
        // `has_more` is not enough on its own: the cursor is what resumes the
        // page, and a provider that sets one without the other would otherwise
        // loop forever.
        if (next === undefined || next === cursor) return;
        cursor = next;
      }
    }

    async function* repliesFor(
      conversationId: string,
      rootTs: string
    ): AsyncGenerator<Record<string, unknown>> {
      yield* pagedMessages("conversations.replies", {
        channel: conversationId,
        ts: rootTs,
        oldest,
        inclusive: "true",
        limit,
      });
    }

    function flushReady(): SourcePage[] {
      const pages: SourcePage[] = [];
      while (buffer.length >= config.pageSize) {
        pages.push({
          object: "slackMessage",
          records: buffer.splice(0, config.pageSize),
        });
      }
      return pages;
    }

    for (const mapping of mappings) {
      if (truncated) break;

      // Once per mapped conversation per run. `undefined` is a failed lookup
      // and leaves the stored snapshot alone; `[]` replaces it with empty.
      const members = await listConversationMembers(
        ctx,
        mapping.conversationId,
        users
      );

      const pendingRoots = new Set<string>();

      try {
        for await (const raw of pagedMessages("conversations.history", {
          channel: mapping.conversationId,
          oldest,
          inclusive: "true",
          limit,
        })) {
          const ts = asString(raw["ts"]);
          const threadTs = asString(raw["thread_ts"]);
          const isRoot = ts !== undefined && (threadTs === undefined || threadTs === ts);

          if (ts !== undefined && isRoot) {
            processedThreadRoots.add(`${mapping.conversationId}:${ts}`);
            const replyCount = raw["reply_count"];
            if (typeof replyCount === "number" && replyCount > 0) {
              pendingRoots.add(ts);
            }
          }

          await addMessage(raw, mapping, members);
          for (const page of flushReady()) yield page;
        }

        for (const rootTs of pendingRoots) {
          for await (const raw of repliesFor(mapping.conversationId, rootTs)) {
            await addMessage(raw, mapping, members);
            for (const page of flushReady()) yield page;
          }
        }
      } catch (error) {
        if (conversationSkippable(error)) {
          // The mapping outlived the conversation (archived, unshared, or its
          // id changed G→C). Skip it; the UI marks the mapping unavailable.
          console.warn(
            `[slack] Skipping conversation ${mapping.conversationId}: ${
              error instanceof Error ? error.message : "provider rejected it"
            }`
          );
          continue;
        }
        throw error;
      }

      // Incremental only: refresh threads already tracked in the window. A
      // thread with no message inside the retained window is out of scope — it
      // cannot be discovered without reading the workspace's entire history.
      const tracked = ctx.slackThreadRoots?.get(mapping.conversationId) ?? [];
      for (const rootTs of tracked) {
        if (processedThreadRoots.has(`${mapping.conversationId}:${rootTs}`)) {
          continue;
        }
        if (trackedRefreshes >= MAX_TRACKED_THREAD_REFRESHES) {
          // The cap withholds completeness, but it must not stop the history
          // reads for the remaining mapped conversations: those are still
          // within scope and cheap relative to an extra full run.
          trackedCapHit = true;
          console.warn(
            `[slack] Tracked-thread refresh cap (${MAX_TRACKED_THREAD_REFRESHES}) reached; the next run will continue`
          );
          break;
        }
        trackedRefreshes += 1;

        try {
          for await (const raw of repliesFor(mapping.conversationId, rootTs)) {
            await addMessage(raw, mapping, members);
            for (const page of flushReady()) yield page;
          }
        } catch (error) {
          if (conversationSkippable(error)) {
            console.warn(
              `[slack] Skipping thread ${mapping.conversationId}:${rootTs}: ${
                error instanceof Error ? error.message : "provider rejected it"
              }`
            );
            continue;
          }
          throw error;
        }
      }

      for (const page of flushReady()) yield page;
    }

    if (buffer.length > 0) {
      yield { object: "slackMessage", records: buffer.splice(0, buffer.length) };
    }

    // The final page is the only one that claims completeness. A page-limited
    // or capped run withholds it so the watermark and prune do not run.
    yield {
      object: "slackMessage",
      records: [],
      complete: !truncated && !trackedCapHit,
    };
  },

  externalIdOf(record: RawRecord): string | undefined {
    const info = infoByRecord.get(record);
    const ts = asString(record["ts"]);
    if (info === undefined || ts === undefined) return undefined;
    return `${info.mapping.conversationId}:${ts}`;
  },

  externalRefsOf(_record: RawRecord, _object: TargetObject): ExternalRefs {
    return {};
  },

  attributionsOf(record, object, ctx) {
    if (object !== "slackMessage") return undefined;

    const info = infoByRecord.get(record);
    if (info === undefined) return undefined;

    return buildSlackAttribution({
      mapping: info.mapping,
      authorExternal: info.authorExternal,
      ...(asString(record["authorEmail"]) === undefined
        ? {}
        : { authorEmail: asString(record["authorEmail"]) }),
      ...(ctx.knownParties === undefined
        ? {}
        : { knownParties: ctx.knownParties }),
      ...(info.mailboxEmail === undefined
        ? {}
        : { mailboxEmail: info.mailboxEmail }),
      ...(info.conversationMembers === undefined
        ? {}
        : { conversationMembers: info.conversationMembers }),
    });
  },
};
