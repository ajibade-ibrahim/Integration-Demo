/**
 * Shared communication types.
 *
 * Kept free of Prisma and provider imports because the registry types and the
 * Gmail handler both name these shapes. The matcher is the only producer of a
 * `MessageAttribution`; the writer is the only consumer.
 */

export const MESSAGE_ROLES = ["from", "to", "cc"] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const COMMUNICATION_MATCH_KINDS = [
  "contact_email",
  "customer_email",
  "customer_domain",
] as const;

export type CommunicationMatchKind =
  (typeof COMMUNICATION_MATCH_KINDS)[number];

/** A single matched party on one role of one message. */
export interface MessageParticipantCandidate {
  role: MessageRole;
  /** Stable: contact:<id> | account:<id> | customer:<id>. */
  partyKey: string;
  contactId?: string;
  customerId?: string;
  customerAccountId?: string;
  matchKind: CommunicationMatchKind;
  matchedValue: string;
  rank: number;
  disputed: boolean;
  isPrimary: boolean;
}

/** What the matcher decided for one message. */
export interface MessageAttribution {
  participants: MessageParticipantCandidate[];
  /** At most one; absent when the top candidates span account groups. */
  primaryPartyKey?: string;
}
