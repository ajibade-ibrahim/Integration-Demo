/**
 * Gmail REST specifics.
 *
 * Two parts of this file are transport-independent and are the ones most worth
 * testing without a server: query construction and MIME/header parsing. The
 * handler itself only wires them to `createProviderSession`.
 *
 * The official search documentation guarantees full addresses in `from:` and
 * `to:` terms but not bare domains. We still use domain terms, because local
 * exact-host matching makes over-matching harmless; if a live mailbox shows
 * under-matching, `fetchPages` can fall back to scanning the window and
 * filtering locally.
 */

import type { RawRecord } from "../../types/common";
import { communicationConfig } from "../../communication/config";
import type { KnownParties } from "../../communication/known-parties";
import { asArray, asRecord, asString } from "../http";

export const GMAIL_BASE = "https://gmail.googleapis.com";

/** Runaway guard shared by every chunk's list pagination. */
export const GMAIL_MAX_PAGES = 1000;

export function gmailApiBase(): string {
  const configured = process.env["GMAIL_API_BASE"];
  const base =
    configured === undefined || configured.trim() === ""
      ? GMAIL_BASE
      : configured;
  return base.replace(/\/+$/, "");
}

export function gmailPageSize(): number {
  return communicationConfig().pageSize;
}

export function gmailMaxPages(): number {
  return communicationConfig().maxPages;
}

function endpoint(path: string): string {
  return `${gmailApiBase()}/gmail/v1${path}`;
}

export function messagesListUrl(
  query: string,
  pageToken: string | undefined,
  pageSize = gmailPageSize()
): string {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(pageSize),
  });
  if (pageToken !== undefined) params.set("pageToken", pageToken);
  return `${endpoint("/users/me/messages")}?${params.toString()}`;
}

export function messageGetUrl(id: string): string {
  return `${endpoint(`/users/me/messages/${encodeURIComponent(id)}`)}?format=full`;
}

export function profileUrl(): string {
  return endpoint("/users/me/profile");
}

const GMAIL_QUERY_LIMIT = 1_500;

/**
 * Build one or more Gmail `q` expressions from known parties.
 *
 * The terms are chunked well below Gmail's hard limit. A single party can
 * appear in several chunks; the handler deduplicates message ids.
 */
export function buildQueryChunks(
  parties: Pick<KnownParties, "rawEmails" | "domains">,
  windowStart: Date
): string[] {
  const terms: string[] = [];

  for (const email of parties.rawEmails) {
    terms.push(`from:${email} OR to:${email} OR cc:${email}`);
  }
  for (const domain of parties.domains) {
    terms.push(`from:${domain} OR to:${domain} OR cc:${domain}`);
  }

  if (terms.length === 0) return [];

  const suffix = ` after:${gmailDate(windowStart)} -in:spam -in:trash -in:chats`;
  const chunks: string[] = [];
  let current = "";

  for (const term of terms) {
    const next = current === "" ? term : `${current} OR ${term}`;
    if (next.length + suffix.length > GMAIL_QUERY_LIMIT && current !== "") {
      chunks.push(`${current}${suffix}`);
      current = term;
    } else {
      current = next;
    }
  }
  if (current !== "") chunks.push(`${current}${suffix}`);

  return chunks;
}

/** Gmail's `after:` operator takes a date, not a full timestamp. */
export function gmailDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

// ---------------------------------------------------------------------------
// Header and address parsing
// ---------------------------------------------------------------------------

export interface ParsedAddress {
  email: string;
  name?: string;
}

function decodeBytes(buffer: Buffer, charset: string | undefined): string {
  if (charset === undefined || charset.trim() === "") {
    return buffer.toString("utf8");
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** Decode RFC 2047 encoded words in a header value. */
export function decodeHeader(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, encoded: string) => {
      try {
        if (encoding.toLowerCase() === "b") {
          return decodeBytes(Buffer.from(encoded, "base64"), charset);
        }

        const bytes: number[] = [];
        const q = encoded.replace(/_/g, " ");
        for (let i = 0; i < q.length; i += 1) {
          if (q[i] === "=" && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
            bytes.push(Number.parseInt(q.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(q.charCodeAt(i));
          }
        }
        return decodeBytes(Buffer.from(bytes), charset);
      } catch {
        return _match;
      }
    }
  );
}

/** Split an address list on commas outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;

    if (char === '"' && (i === 0 || value[i - 1] !== "\\")) {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && char === "<") angleDepth += 1;
    if (!quoted && char === ">" && angleDepth > 0) angleDepth -= 1;

    if (char === "," && !quoted && angleDepth === 0) {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/**
 * Parse an RFC 5322 address list into bare addresses and display names.
 *
 * This is intentionally not a full parser. It covers the forms Gmail emits:
 * `Name <a@b>`, `"Doe, Jane" <a@b>`, and a bare address.
 */
export function parseAddressList(value: string | undefined): ParsedAddress[] {
  if (value === undefined || value.trim() === "") return [];

  return splitAddresses(value).flatMap((part) => {
    const bracketed = /<([^<>]+)>/.exec(part);
    const email = (bracketed?.[1] ?? part).trim();
    if (!email.includes("@")) return [];

    let name = bracketed === null ? "" : part.slice(0, bracketed.index).trim();
    name = name.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();

    return [
      {
        email,
        ...(name === "" ? {} : { name: decodeHeader(name) }),
      },
    ];
  });
}

interface HeaderMap {
  [key: string]: string;
}

function headersFrom(payload: Record<string, unknown> | undefined): HeaderMap {
  const headers: HeaderMap = {};
  for (const item of asArray(payload?.["headers"])) {
    const header = asRecord(item);
    const name = asString(header?.["name"])?.toLowerCase();
    const value = asString(header?.["value"]);
    if (name !== undefined && value !== undefined && headers[name] === undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function bodyText(
  payload: Record<string, unknown> | undefined,
  mimeType: string
): string[] {
  if (payload === undefined) return [];

  const found: string[] = [];
  const ownType = asString(payload["mimeType"]);
  const body = asRecord(payload["body"]);
  const data = asString(body?.["data"]);
  const headers = headersFrom(payload);
  const isAttachment =
    body?.["attachmentId"] !== undefined ||
    (headers["content-disposition"] ?? "")
      .toLowerCase()
      .startsWith("attachment");

  if (data !== undefined && ownType === mimeType && !isAttachment) {
    const decoded = decodeGmailBody(data, headers["content-type"]);
    if (decoded !== "") found.push(decoded);
  }

  for (const item of asArray(payload["parts"])) {
    found.push(...bodyText(asRecord(item), mimeType));
  }
  return found;
}

/** Decode Gmail's base64url body, using the declared charset when present. */
export function decodeGmailBody(data: string, contentType?: string): string {
  const charset = contentType === undefined
    ? undefined
    : /charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1];

  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    return decodeBytes(Buffer.from(padded, "base64"), charset);
  } catch {
    return "";
  }
}

function parseTimestamp(
  internalDate: unknown,
  dateHeader: string | undefined
): Date | undefined {
  if (typeof internalDate === "string" || typeof internalDate === "number") {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) {
      const parsed = new Date(ms);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  if (dateHeader !== undefined) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

/**
 * Turn one Gmail message resource into the raw record the mapper sees.
 *
 * Drafts are dropped here, before mapping. Gmail's list endpoint can return
 * them, and a draft is not communication that happened.
 */
export function parseGmailMessage(
  json: unknown,
  mailboxEmail: string
): RawRecord | undefined {
  const message = asRecord(json);
  if (message === undefined) return undefined;

  const id = asString(message["id"]);
  if (id === undefined) return undefined;

  const labels = asArray(message["labelIds"]).filter(
    (label): label is string => typeof label === "string"
  );
  if (labels.includes("DRAFT")) return undefined;

  const labelsAvailable = Array.isArray(message["labelIds"]);

  const payload = asRecord(message["payload"]);
  const headers = headersFrom(payload);

  const from = parseAddressList(headers["from"])[0];
  const to = parseAddressList(headers["to"]);
  const cc = parseAddressList(headers["cc"]);

  const sentAt = parseTimestamp(message["internalDate"], headers["date"]);
  if (sentAt === undefined) return undefined;

  const textParts = bodyText(payload, "text/plain");
  const htmlParts = bodyText(payload, "text/html");
  const subject = headers["subject"];
  const sentByMailbox =
    from?.email !== undefined &&
    from.email.trim().toLowerCase() === mailboxEmail.trim().toLowerCase();

  return {
    id,
    threadId: asString(message["threadId"]),
    fromEmail: from?.email,
    fromName: from?.name,
    toEmailsCsv: to.map((address) => address.email).join(","),
    ccEmailsCsv: cc.map((address) => address.email).join(","),
    subject: subject === undefined ? undefined : decodeHeader(subject),
    snippet: asString(message["snippet"]),
    sentAtIso: sentAt.toISOString(),
    internalDateMs: String(sentAt.getTime()),
    direction: labelsAvailable
      ? labels.includes("SENT")
        ? "sent"
        : "received"
      : sentByMailbox
        ? "sent"
        : "received",
    bodyText: textParts.length === 0 ? undefined : textParts.join("\n"),
    bodyHtml: htmlParts.length === 0 ? undefined : htmlParts.join("\n"),
  };
}
