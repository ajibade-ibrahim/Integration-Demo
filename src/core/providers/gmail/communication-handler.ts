/**
 * Gmail communication handler.
 *
 * It streams full messages page by page: list ids, fetch each message, parse
 * it, and yield the page. Attribution is derived by `attributionsOf` so the
 * engine can filter unmatched messages and write participants in the same page
 * transaction boundary. The final empty page is the only page that declares
 * the acquisition complete; intermediate pages deliberately make no claim.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { matchMessage } from "../../communication/matching";
import { createProviderSession, asArray, asRecord, asString } from "../http";
import {
  buildQueryChunks,
  gmailMaxPages,
  gmailPageSize,
  messageGetUrl,
  messagesListUrl,
  parseGmailMessage,
  profileUrl,
} from "./api";
import { ProviderHttpError } from "../../sync/errors";

function csvAddresses(value: unknown): string[] {
  const raw = asString(value);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// The raw record shape deliberately matches the documented parser output; the
// resolved mailbox (including the profile fallback) is kept out of band so it
// cannot leak into discovery or a mapping.
const mailboxByRecord = new WeakMap<object, string>();

function attributionFor(
  record: RawRecord,
  knownParties: HandlerContext["knownParties"],
  fallbackMailbox: string | undefined
) {
  if (knownParties === undefined) return undefined;
  return matchMessage({
    knownParties,
    addresses: {
      from: csvAddresses(record["fromEmail"]),
      to: csvAddresses(record["toEmailsCsv"]),
      cc: csvAddresses(record["ccEmailsCsv"]),
    },
    mailboxEmail:
      mailboxByRecord.get(record) ??
      fallbackMailbox ??
      knownParties.mailboxEmail,
  });
}

async function resolveMailboxEmail(
  session: ReturnType<typeof createProviderSession>,
  ctx: HandlerContext
): Promise<string> {
  const fromMetadata = ctx.metadata["email"] ?? ctx.metadata["emailAddress"];
  if (fromMetadata !== undefined && fromMetadata.trim() !== "") {
    return fromMetadata.trim();
  }

  const profile = asRecord(await session.getJson(profileUrl()));
  const email = asString(profile?.["emailAddress"]);
  if (email === undefined) {
    throw new Error("Gmail did not return a mailbox address");
  }
  return email.trim();
}

export const gmailCommunicationHandler: SyncHandler = {
  objects: ["message"],
  streaming: true,

  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Gmail");
    const mailboxEmail = await resolveMailboxEmail(session, ctx);
    const parties = ctx.knownParties;
    if (parties === undefined) {
      throw new Error("Communication sync started without known parties");
    }
    if (ctx.communicationWindowStart === undefined) {
      throw new Error("Communication sync started without a window start");
    }

    const chunks = buildQueryChunks(parties, ctx.communicationWindowStart);
    if (chunks.length === 0) {
      yield { object: "message", records: [], complete: true };
      return;
    }

    const seen = new Set<string>();
    let truncated = false;

    for (const chunk of chunks) {
      let pageToken: string | undefined;
      let listPages = 0;

      while (true) {
        listPages += 1;
        if (listPages > gmailMaxPages()) {
          truncated = true;
          break;
        }

        const listing = asRecord(
          await session.getJson(
            messagesListUrl(chunk, pageToken, gmailPageSize())
          )
        );
        const ids = asArray(listing?.["messages"])
          .map((item) => asString(asRecord(item)?.["id"]))
          .filter((id): id is string => id !== undefined);

        const records: RawRecord[] = [];
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);

          let message: unknown;
          try {
            message = await session.getJson(messageGetUrl(id));
          } catch (error) {
            // A message that disappeared between list and get is an ordinary
            // race, not a failed run.
            if (error instanceof ProviderHttpError && error.status === 404) {
              continue;
            }
            throw error;
          }

          const record = parseGmailMessage(message, mailboxEmail);
          if (record !== undefined) {
            mailboxByRecord.set(record, mailboxEmail);
            if (attributionFor(record, parties, mailboxEmail) !== undefined) {
              records.push(record);
            }
          }
        }

        if (records.length > 0) {
          yield { object: "message", records };
        }

        const next = asString(listing?.["nextPageToken"]);
        if (next === undefined) break;
        if (next === pageToken) {
          truncated = true;
          break;
        }
        pageToken = next;
      }

      if (truncated) break;
    }

    if (truncated) {
      // A page-limited list is not a complete acquisition. Yielding a final
      // page with `complete: false` withholds the state update and prune.
      yield { object: "message", records: [], complete: false };
      return;
    }

    yield { object: "message", records: [], complete: true };
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["id"]);
  },

  externalRefsOf(_record: RawRecord, _object: TargetObject): ExternalRefs {
    return {};
  },

  attributionsOf(record, object, ctx) {
    if (object !== "message") return undefined;
    const metadataMailbox = ctx.metadata["email"] ?? ctx.metadata["emailAddress"];
    return attributionFor(record, ctx.knownParties, metadataMailbox);
  },
};
