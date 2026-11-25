/**
 * Email message reads and retention.
 *
 * The writer lives beside the other record writers; this module owns the two
 * destructive operations and the UI projections. Every read is scoped by
 * `integration.userId`, including the detail page, so an id from another tenant
 * answers as "not found" rather than leaking a subject or body.
 */

import { prisma } from "@/lib/prisma";
import { readJsonArray } from "./json-column";

export interface EmailMessageParticipantView {
  id: string;
  role: string;
  partyKey: string;
  matchKind: string;
  matchedValue: string;
  rank: number;
  disputed: boolean;
  isPrimary: boolean;
  contactName: string | null;
  customerName: string | null;
  accountName: string | null;
}

export interface EmailMessageListRow {
  id: string;
  externalSourceId: string;
  subject: string | null;
  snippet: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  sentAt: Date;
  direction: string;
  integrationLabel: string;
  providerName: string;
  participants: EmailMessageParticipantView[];
  /** A name when one primary exists, otherwise the ambiguity's shape. */
  primaryLabel: string;
}

export interface EmailMessageDetail extends EmailMessageListRow {
  threadId: string | null;
  toEmails: string[];
  ccEmails: string[];
  bodyText: string | null;
  bodyHtml: string | null;
}

const participantSelect = {
  id: true,
  role: true,
  partyKey: true,
  matchKind: true,
  matchedValue: true,
  rank: true,
  disputed: true,
  isPrimary: true,
  contact: { select: { name: true } },
  customer: { select: { name: true } },
  customerAccount: { select: { name: true } },
} as const;

type ParticipantRow = {
  id: string;
  role: string;
  partyKey: string;
  matchKind: string;
  matchedValue: string;
  rank: number;
  disputed: boolean;
  isPrimary: boolean;
  contact: { name: string } | null;
  customer: { name: string } | null;
  customerAccount: { name: string } | null;
};

function participantView(row: ParticipantRow): EmailMessageParticipantView {
  return {
    id: row.id,
    role: row.role,
    partyKey: row.partyKey,
    matchKind: row.matchKind,
    matchedValue: row.matchedValue,
    rank: row.rank,
    disputed: row.disputed,
    isPrimary: row.isPrimary,
    contactName: row.contact?.name ?? null,
    customerName: row.customer?.name ?? null,
    accountName: row.customerAccount?.name ?? null,
  };
}

function primaryLabel(
  participants: readonly EmailMessageParticipantView[]
): string {
  const primary = participants.find((participant) => participant.isPrimary);
  if (primary !== undefined) {
    return (
      primary.contactName ??
      primary.customerName ??
      primary.accountName ??
      primary.matchedValue
    );
  }

  const groups = new Set(
    participants.map(
      (participant) =>
        participant.customerName ??
        participant.accountName ??
        participant.contactName ??
        participant.partyKey
    )
  );
  return groups.size > 1 ? "Multiple parties" : "Unresolved party";
}

function toListRow(row: {
  id: string;
  externalSourceId: string;
  subject: string | null;
  snippet: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string;
  sentAt: Date;
  direction: string;
  integration: { instanceLabel: string; providerName: string };
  participants: ParticipantRow[];
}): EmailMessageListRow {
  const participants = row.participants.map(participantView);
  return {
    id: row.id,
    externalSourceId: row.externalSourceId,
    subject: row.subject,
    snippet: row.snippet,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    toEmails: readJsonArray<string>(row.toEmails),
    sentAt: row.sentAt,
    direction: row.direction,
    integrationLabel: row.integration.instanceLabel,
    providerName: row.integration.providerName,
    participants,
    primaryLabel: primaryLabel(participants),
  };
}

/** Newest emails across every integration this user owns. */
export async function loadEmailMessagesForUser(
  userId: string,
  take = 200
): Promise<EmailMessageListRow[]> {
  const rows = await prisma.emailMessage.findMany({
    where: { integration: { userId } },
    orderBy: [{ sentAt: "desc" }, { id: "asc" }],
    take,
    include: {
      integration: { select: { instanceLabel: true, providerName: true } },
      participants: {
        select: participantSelect,
        orderBy: [{ isPrimary: "desc" }, { role: "asc" }, { partyKey: "asc" }],
      },
    },
  });

  return rows.map(toListRow);
}

export async function countEmailMessagesForUser(
  userId: string
): Promise<number> {
  return prisma.emailMessage.count({ where: { integration: { userId } } });
}

/** One email for the detail page, scoped through its integration's owner. */
export async function findEmailMessageForUser(
  id: string,
  userId: string
): Promise<EmailMessageDetail | undefined> {
  const row = await prisma.emailMessage.findFirst({
    where: { id, integration: { userId } },
    include: {
      integration: { select: { instanceLabel: true, providerName: true } },
      participants: {
        select: participantSelect,
        orderBy: [{ isPrimary: "desc" }, { role: "asc" }, { partyKey: "asc" }],
      },
    },
  });
  if (row === null) return undefined;

  return {
    ...toListRow(row),
    threadId: row.threadId,
    toEmails: readJsonArray<string>(row.toEmails),
    ccEmails: readJsonArray<string>(row.ccEmails),
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
  };
}

/**
 * Delete one integration's emails older than the retained window.
 *
 * Called only after a complete acquisition. A page-limited or failed run must
 * not advance the window and then delete the history it did not re-read.
 */
export async function pruneEmailMessagesForIntegration(
  integrationId: string,
  cutoff: Date
): Promise<number> {
  const result = await prisma.emailMessage.deleteMany({
    where: { integrationId, sentAt: { lt: cutoff } },
  });
  return result.count;
}

/** Delete expired emails for every integration, including inactive ones. */
export async function pruneExpiredEmailMessages(
  cutoff: Date
): Promise<number> {
  const result = await prisma.emailMessage.deleteMany({
    where: { sentAt: { lt: cutoff } },
  });
  return result.count;
}
