/**
 * Matching addresses against the known parties.
 *
 * Exact email beats an account/company email, which beats an exact-host domain.
 * Domain matching never folds `retail.acme.com` into `acme.com`; the two are
 * different hosts and a shared suffix is not evidence that one company owns the
 * other.
 *
 * All candidates are returned, not just the winner. One email can involve
 * several companies, and collapsing that to a single "attributed party" is the
 * failure this table exists to avoid. Primary is a convenience when the top
 * candidates agree; it is deliberately empty when they do not.
 *
 * Slack uses `matchAuthorContactsForCustomer` instead: the conversation mapping
 * already fixes the customer, and this only adds a best-effort contact for the
 * external author.
 */

import { isFreeEmailDomain } from "../identity/free-email-domains";
import { normalizeEmail } from "../identity/normalize";
import type { KnownParties, KnownPartyCandidate } from "./known-parties";
import {
  CONTACT_EMAIL_RANK,
  CUSTOMER_EMAIL_RANK,
  CUSTOMER_DOMAIN_RANK,
} from "./known-parties";
import type {
  EmailAttribution,
  EmailMessageRole,
  EmailParticipantCandidate,
  SlackAuthorContactCandidate,
} from "./types";

export interface MessageAddresses {
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
}

const ROLE_ORDER: Record<EmailMessageRole, number> = {
  from: 0,
  to: 1,
  cc: 2,
};

const MATCH_KIND_ORDER = {
  contact_email: 0,
  customer_email: 1,
  customer_domain: 2,
} as const;

function groupKey(candidate: {
  partyKey: string;
  contactId?: string;
  customerId?: string;
  customerAccountId?: string;
}): string {
  if (candidate.customerAccountId !== undefined) {
    return `account:${candidate.customerAccountId}`;
  }
  if (candidate.customerId !== undefined) return `customer:${candidate.customerId}`;
  if (candidate.contactId !== undefined) return `contact:${candidate.contactId}`;
  return candidate.partyKey;
}

function addressValue(raw: string): string | undefined {
  const direct = normalizeEmail(raw);
  if (direct !== undefined) return direct.value;

  // Gmail's parser normally hands us a bare address, but a caller (a test, or a
  // future provider) may pass a display-name form. Extracting the angle-bracket
  // address is enough; this is not an RFC 5322 parser.
  const bracketed = /<([^<>]+)>/.exec(raw)?.[1];
  return bracketed === undefined ? undefined : normalizeEmail(bracketed)?.value;
}

function domainValue(normalizedEmail: string): string | undefined {
  const at = normalizedEmail.lastIndexOf("@");
  if (at === -1) return undefined;
  const domain = normalizedEmail.slice(at + 1);
  return domain === "" || isFreeEmailDomain(domain) ? undefined : domain;
}

function isAmbiguous(
  parties: KnownParties,
  candidate: KnownPartyCandidate
): boolean {
  const bucket =
    candidate.matchKind === "customer_domain"
      ? parties.byDomain.get(candidate.matchedValue)
      : parties.byEmail.get(candidate.matchedValue);
  if (bucket === undefined || bucket.length < 2) return false;
  return new Set(bucket.map(groupKey)).size > 1;
}

function collectRoleCandidates(
  parties: KnownParties,
  addresses: readonly string[],
  mailboxEmail: string | undefined
): KnownPartyCandidate[] {
  const mailbox = mailboxEmail
    ? normalizeEmail(mailboxEmail)?.value
    : undefined;
  const best = new Map<string, KnownPartyCandidate>();

  for (const raw of addresses) {
    const normalized = addressValue(raw);
    if (normalized === undefined || normalized === mailbox) continue;

    const matches = [...(parties.byEmail.get(normalized) ?? [])];
    const domain = domainValue(normalized);
    if (domain !== undefined) {
      matches.push(...(parties.byDomain.get(domain) ?? []));
    }

    for (const candidate of matches) {
      const existing = best.get(candidate.partyKey);
      if (
        existing === undefined ||
        candidate.rank > existing.rank ||
        (candidate.rank === existing.rank &&
          MATCH_KIND_ORDER[candidate.matchKind] <
            MATCH_KIND_ORDER[existing.matchKind])
      ) {
        best.set(candidate.partyKey, candidate);
      }
    }
  }

  return [...best.values()];
}

/**
 * Match every address on an email.
 *
 * @returns The participants, or undefined when nothing matched. The handler
 *   treats undefined as "not a communication record for this tenant", which is
 *   why unmatched messages are never written.
 */
export function matchMessage(args: {
  knownParties: KnownParties;
  addresses: MessageAddresses;
  mailboxEmail?: string;
}): EmailAttribution | undefined {
  const { knownParties, addresses } = args;
  const mailbox = args.mailboxEmail ?? knownParties.mailboxEmail;

  const participants: EmailParticipantCandidate[] = [];

  for (const role of ["from", "to", "cc"] as const) {
    for (const candidate of collectRoleCandidates(
      knownParties,
      addresses[role],
      mailbox
    )) {
      participants.push({
        role,
        partyKey: candidate.partyKey,
        ...(candidate.contactId === undefined
          ? {}
          : { contactId: candidate.contactId }),
        ...(candidate.customerId === undefined
          ? {}
          : { customerId: candidate.customerId }),
        ...(candidate.customerAccountId === undefined
          ? {}
          : { customerAccountId: candidate.customerAccountId }),
        matchKind: candidate.matchKind,
        matchedValue: candidate.matchedValue,
        rank: candidate.rank,
        disputed: isAmbiguous(knownParties, candidate),
        isPrimary: false,
      });
    }
  }

  if (participants.length === 0) return undefined;

  const topRank = Math.max(...participants.map((participant) => participant.rank));
  const top = participants.filter(
    (participant) => participant.rank === topRank
  );
  const topGroups = new Set(top.map(groupKey));

  if (topGroups.size > 1 || top.some((participant) => participant.disputed)) {
    // The same top-strength evidence points at different companies, or the
    // strongest candidate itself is ambiguous because its address/host maps to
    // more than one account group. Keeping all of them and declining to choose
    // is the only honest answer.
    for (const participant of top) participant.disputed = true;
    return { kind: "email", participants };
  }

  const primary = [...top].sort((a, b) => {
    const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (role !== 0) return role;
    const kind = MATCH_KIND_ORDER[a.matchKind] - MATCH_KIND_ORDER[b.matchKind];
    if (kind !== 0) return kind;
    return a.partyKey.localeCompare(b.partyKey);
  })[0];

  if (primary !== undefined) {
    primary.isPrimary = true;
    return { kind: "email", participants, primaryPartyKey: primary.partyKey };
  }

  return { kind: "email", participants };
}

/**
 * Match addresses to contacts belonging to one already-chosen customer.
 *
 * Used by a conversation-mapped provider: the customer is authoritative, and
 * this only adds a best-effort contact for the external author. Restricting the
 * result to that customer is the whole point — a message in a mapped
 * conversation must never be attributed to a different company merely because
 * the author's address matches one.
 *
 * Deliberately does not choose a primary: the handler picks one contact
 * deterministically (rank, then match kind, then party key) and the mapping
 * customer remains the attribution's primary party.
 */
export function matchAuthorContactsForCustomer(args: {
  knownParties: KnownParties;
  addresses: readonly string[];
  customerId: string;
}): SlackAuthorContactCandidate[] {
  const { knownParties, customerId } = args;

  return collectRoleCandidates(
    knownParties,
    args.addresses,
    knownParties.mailboxEmail
  )
    .filter(
      (candidate) =>
        candidate.contactId !== undefined && candidate.customerId === customerId
    )
    .map((candidate) => ({
      partyKey: candidate.partyKey,
      contactId: candidate.contactId as string,
      ...(candidate.customerId === undefined
        ? {}
        : { customerId: candidate.customerId }),
      ...(candidate.customerAccountId === undefined
        ? {}
        : { customerAccountId: candidate.customerAccountId }),
      matchKind: candidate.matchKind,
      matchedValue: candidate.matchedValue,
      rank: candidate.rank,
    }));
}

/** Rank constants re-exported for tests and the detail page's explanations. */
export const COMMUNICATION_RANKS = {
  contactEmail: CONTACT_EMAIL_RANK,
  customerEmail: CUSTOMER_EMAIL_RANK,
  customerDomain: CUSTOMER_DOMAIN_RANK,
} as const;
