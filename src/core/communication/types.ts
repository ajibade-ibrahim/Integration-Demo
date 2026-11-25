/**
 * Shared communication types.
 *
 * Kept free of Prisma and provider imports because the registry types and every
 * communication handler name these shapes. The matchers are the producers of an
 * attribution; the writers are the only consumers.
 *
 * There are two attribution shapes because email and Slack answer different
 * questions. An email is address-matched: every role on the message may resolve
 * to a known party, and one of them may be primary. A Slack message lives in a
 * conversation a human mapped to exactly one customer, so the customer is fixed
 * and the author may add one best-effort contact belonging to that customer.
 */

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export const EMAIL_MESSAGE_ROLES = ["from", "to", "cc"] as const;

export type EmailMessageRole = (typeof EMAIL_MESSAGE_ROLES)[number];

export const EMAIL_MATCH_KINDS = [
  "contact_email",
  "customer_email",
  "customer_domain",
] as const;

export type EmailMatchKind = (typeof EMAIL_MATCH_KINDS)[number];

/** A single matched party on one role of one email. */
export interface EmailParticipantCandidate {
  role: EmailMessageRole;
  /** Stable: contact:<id> | account:<id> | customer:<id>. */
  partyKey: string;
  contactId?: string;
  customerId?: string;
  customerAccountId?: string;
  matchKind: EmailMatchKind;
  matchedValue: string;
  rank: number;
  disputed: boolean;
  isPrimary: boolean;
}

/** What the address matcher decided for one email. */
export interface EmailAttribution {
  kind: "email";
  participants: EmailParticipantCandidate[];
  /** At most one; absent when the top candidates span account groups. */
  primaryPartyKey?: string;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/**
 * The kinds of Slack conversation that can be attributed to a customer.
 *
 * A team channel is deliberately absent: internal channels and internal-only
 * DMs are never ingested, so they have no mapping the UI could offer.
 */
export type SlackConversationKind =
  | "shared_channel"
  | "connect_dm"
  | "group_dm";

/**
 * One conversation a human mapped to a customer, as handed to a sync handler.
 *
 * Carries the mapping id (which the writer stores on every message), the
 * customer, and the resolved account so provider code stays free of Prisma.
 */
export interface SlackConversationMappingView {
  mappingId: string;
  conversationId: string;
  conversationKind: SlackConversationKind;
  label: string;
  customerId: string;
  customerName: string;
  customerAccountId?: string;
}

/**
 * One human member of a mapped conversation.
 *
 * This is a snapshot refreshed per mapped conversation, not copied onto each
 * message. `email` is present only when Slack exposes it to the authorizing
 * user's token.
 */
export interface SlackConversationMemberSnapshot {
  slackUserId: string;
  name?: string;
  email?: string;
  isExternal: boolean;
}

/** A contact candidate belonging to the mapped customer. */
export interface SlackAuthorContactCandidate {
  partyKey: string;
  contactId: string;
  customerId?: string;
  customerAccountId?: string;
  matchKind: EmailMatchKind;
  matchedValue: string;
  rank: number;
}

/** The single best contact chosen for an external Slack author. */
export interface SlackAuthorContact {
  contactId: string;
  customerId: string;
  customerAccountId?: string;
  matchKind: EmailMatchKind;
  matchedValue: string;
  rank: number;
}

/**
 * What the Slack handler decided for one message.
 *
 * `conversationMembers` is deliberately tri-state. Absent means the member
 * lookup failed and the stored snapshot must be kept; an empty array means the
 * conversation genuinely has no human members and the snapshot is replaced.
 */
export interface SlackAttribution {
  kind: "slack";
  mappingId: string;
  customerId: string;
  authorExternal: boolean;
  authorContact?: SlackAuthorContact;
  conversationMembers?: readonly SlackConversationMemberSnapshot[];
}

export type CommunicationAttribution = EmailAttribution | SlackAttribution;
