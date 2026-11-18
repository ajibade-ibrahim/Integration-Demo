/**
 * Known communication parties, built from the identity data this tenant already
 * has.
 *
 * A communication sync is not allowed to create customers or contacts. It only
 * joins messages to records that exist — every candidate here came from a
 * `Customer`, `Contact`, or the account key table identity resolution already
 * maintains. The mailbox owner is removed from the candidate set before it is
 * handed to the provider.
 *
 * The fingerprint is the whole re-attribution trigger. Adding a contact,
 * resolving a customer onto an account, changing a domain, or changing the
 * lookback must make the next communication run scan the full window again;
 * otherwise old messages would keep the attribution they had when they were
 * first seen. It is deterministic and deliberately includes IDs, not just
 * values, because two accounts can legitimately claim the same email.
 */

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isFreeEmailDomain } from "../identity/free-email-domains";
import { normalizeDomain, normalizeEmail } from "../identity/normalize";
import type { CommunicationMatchKind } from "./types";
import { communicationConfig } from "./config";

export const CONTACT_EMAIL_RANK = 3;
export const CUSTOMER_EMAIL_RANK = 2;
export const CUSTOMER_DOMAIN_RANK = 1;

/** Version this fingerprint shape. Bump when a matching rule changes. */
export const KNOWN_PARTIES_FINGERPRINT_VERSION = 1;

export interface KnownPartyCandidate {
  /** Stable identity: contact:<id> | account:<id> | customer:<id>. */
  partyKey: string;
  contactId?: string;
  customerId?: string;
  customerAccountId?: string;
  matchKind: CommunicationMatchKind;
  matchedValue: string;
  rank: number;
  /** Source integration's identity priority, for the fingerprint. */
  priority: number;
}

export interface KnownParties {
  byEmail: Map<string, KnownPartyCandidate[]>;
  byDomain: Map<string, KnownPartyCandidate[]>;
  /** Raw addresses suitable for Gmail's search terms. */
  rawEmails: string[];
  /** Normalized exact-host domains suitable for Gmail's search terms. */
  domains: string[];
  /** The mailbox owner's normalized address, when the credential named it. */
  mailboxEmail?: string;
  fingerprint: string;
  /** True when no safe candidate remains after mailbox exclusion. */
  isEmpty: boolean;
}

export interface LoadKnownPartiesOptions {
  /**
   * The connected mailbox's own address. Its primary address must never be
   * attributed to a customer, even if a contact record happens to use it.
   */
  mailboxEmail?: string;
}

type CandidateMap = Map<string, Map<string, KnownPartyCandidate>>;

function addCandidate(
  maps: CandidateMap,
  value: string,
  candidate: KnownPartyCandidate
): void {
  if (value === "") return;
  const bucket = maps.get(value) ?? new Map<string, KnownPartyCandidate>();
  const existing = bucket.get(candidate.partyKey);
  // A party can arrive through several rows (a customer and one of its account
  // keys, say). Keep the strongest observation, then the highest-priority
  // source; the rest are the same party and would only create duplicate rows.
  if (
    existing === undefined ||
    candidate.rank > existing.rank ||
    (candidate.rank === existing.rank && candidate.priority < existing.priority)
  ) {
    bucket.set(candidate.partyKey, candidate);
  }
  maps.set(value, bucket);
}

function toArrays(maps: CandidateMap): Map<string, KnownPartyCandidate[]> {
  return new Map(
    [...maps.entries()].map(([value, bucket]) => [value, [...bucket.values()]])
  );
}

function groupKey(candidate: KnownPartyCandidate): string {
  if (candidate.customerAccountId !== undefined) {
    return `account:${candidate.customerAccountId}`;
  }
  if (candidate.customerId !== undefined) return `customer:${candidate.customerId}`;
  if (candidate.contactId !== undefined) return `contact:${candidate.contactId}`;
  return candidate.partyKey;
}

export function knownPartyGroupKey(candidate: KnownPartyCandidate): string {
  return groupKey(candidate);
}

/**
 * Build the candidate maps and fingerprint for one user.
 *
 * The query is deliberately tenant-wide. Known parties are a property of the
 * user's whole identity graph, not of the Gmail integration: a customer synced
 * from Stripe is just as valid a participant as one synced from HubSpot.
 */
export async function loadKnownParties(
  userId: string,
  options: LoadKnownPartiesOptions = {}
): Promise<KnownParties> {
  const config = communicationConfig();
  const mailbox = options.mailboxEmail
    ? normalizeEmail(options.mailboxEmail)?.value
    : undefined;

  const [integrations, customers, contacts, accountKeys] = await Promise.all([
    prisma.integration.findMany({
      where: { userId },
      select: { id: true, identityPriority: true },
    }),
    prisma.customer.findMany({
      where: { integration: { userId } },
      select: {
        id: true,
        email: true,
        domain: true,
        customerAccountId: true,
        integrationId: true,
      },
    }),
    prisma.contact.findMany({
      where: { integration: { userId } },
      select: {
        id: true,
        email: true,
        customerId: true,
        integrationId: true,
        customer: { select: { customerAccountId: true } },
      },
    }),
    prisma.customerAccountKey.findMany({
      where: { userId, kind: { in: ["email", "domain"] } },
      select: {
        customerAccountId: true,
        kind: true,
        value: true,
        rawValue: true,
        sourceIntegrationId: true,
      },
    }),
  ]);

  const priorityByIntegration = new Map(
    integrations.map((integration) => [integration.id, integration.identityPriority])
  );

  const byEmail: CandidateMap = new Map();
  const byDomain: CandidateMap = new Map();
  const rawEmails = new Set<string>();
  const domains = new Set<string>();

  const isMailbox = (normalized: string): boolean =>
    mailbox !== undefined && normalized === mailbox;

  // Account keys are evidence of account ownership even when the customer or
  // contact row itself has not been resolved onto the account yet. Build this
  // lookup first so both candidate kinds can use it.
  const accountByEmail = new Map<string, string>();
  const accountByDomain = new Map<string, string>();
  for (const key of accountKeys) {
    if (key.kind === "email") {
      const normalized = normalizeEmail(
        key.rawValue.trim() === "" ? key.value : key.rawValue
      );
      if (normalized !== undefined && !accountByEmail.has(normalized.value)) {
        accountByEmail.set(normalized.value, key.customerAccountId);
      }
    } else if (key.kind === "domain") {
      const domain = normalizeDomain(
        key.rawValue.trim() === "" ? key.value : key.rawValue
      );
      if (domain !== undefined && !accountByDomain.has(domain)) {
        accountByDomain.set(domain, key.customerAccountId);
      }
    }
  }

  for (const customer of customers) {
    const priority = priorityByIntegration.get(customer.integrationId) ?? 100;
    const normalizedEmail = normalizeEmail(customer.email);
    const domain = normalizeDomain(customer.domain);
    const resolvedAccountId =
      customer.customerAccountId ??
      (normalizedEmail === undefined
        ? undefined
        : accountByEmail.get(normalizedEmail.value)) ??
      (domain === undefined ? undefined : accountByDomain.get(domain));

    if (normalizedEmail !== undefined && !isMailbox(normalizedEmail.value)) {
      rawEmails.add(customer.email?.trim() ?? normalizedEmail.value);
      addCandidate(byEmail, normalizedEmail.value, {
        partyKey: resolvedAccountId
          ? `account:${resolvedAccountId}`
          : `customer:${customer.id}`,
        customerId: customer.id,
        ...(resolvedAccountId === undefined
          ? {}
          : { customerAccountId: resolvedAccountId }),
        matchKind: "customer_email",
        matchedValue: normalizedEmail.value,
        rank: CUSTOMER_EMAIL_RANK,
        priority,
      });
    }

    if (domain !== undefined) {
      domains.add(domain);
      addCandidate(byDomain, domain, {
        partyKey: resolvedAccountId
          ? `account:${resolvedAccountId}`
          : `customer:${customer.id}`,
        customerId: customer.id,
        ...(resolvedAccountId === undefined
          ? {}
          : { customerAccountId: resolvedAccountId }),
        matchKind: "customer_domain",
        matchedValue: domain,
        rank: CUSTOMER_DOMAIN_RANK,
        priority,
      });
    }
  }

  for (const contact of contacts) {
    const priority = priorityByIntegration.get(contact.integrationId) ?? 100;
    const normalizedEmail = normalizeEmail(contact.email);
    if (normalizedEmail === undefined || isMailbox(normalizedEmail.value)) {
      continue;
    }

    const domain = normalizedEmail.domain;
    const resolvedAccountId =
      contact.customer?.customerAccountId ??
      accountByEmail.get(normalizedEmail.value) ??
      (isFreeEmailDomain(domain) ? undefined : accountByDomain.get(domain));

    rawEmails.add(contact.email?.trim() ?? normalizedEmail.value);
    addCandidate(byEmail, normalizedEmail.value, {
      partyKey: `contact:${contact.id}`,
      contactId: contact.id,
      ...(contact.customerId === null ? {} : { customerId: contact.customerId }),
      ...(resolvedAccountId === undefined
        ? {}
        : { customerAccountId: resolvedAccountId }),
      matchKind: "contact_email",
      matchedValue: normalizedEmail.value,
      rank: CONTACT_EMAIL_RANK,
      priority,
    });
  }

  for (const key of accountKeys) {
    const priority =
      priorityByIntegration.get(key.sourceIntegrationId) ?? 100;
    const raw = key.rawValue.trim() === "" ? key.value : key.rawValue;

    if (key.kind === "email") {
      const normalized = normalizeEmail(raw);
      if (normalized === undefined || isMailbox(normalized.value)) continue;
      rawEmails.add(raw);
      addCandidate(byEmail, normalized.value, {
        partyKey: `account:${key.customerAccountId}`,
        customerAccountId: key.customerAccountId,
        matchKind: "customer_email",
        matchedValue: normalized.value,
        rank: CUSTOMER_EMAIL_RANK,
        priority,
      });
    } else if (key.kind === "domain") {
      const domain = normalizeDomain(raw);
      if (domain === undefined || isFreeEmailDomain(domain)) continue;
      domains.add(domain);
      addCandidate(byDomain, domain, {
        partyKey: `account:${key.customerAccountId}`,
        customerAccountId: key.customerAccountId,
        matchKind: "customer_domain",
        matchedValue: domain,
        rank: CUSTOMER_DOMAIN_RANK,
        priority,
      });
    }
  }

  const emailMap = toArrays(byEmail);
  const domainMap = toArrays(byDomain);

  const fingerprint = fingerprintFor({
    lookbackDays: config.lookbackDays,
    mailboxEmail: mailbox,
    candidates: [
      ...[...emailMap.values()].flat(),
      ...[...domainMap.values()].flat(),
    ],
  });

  return {
    byEmail: emailMap,
    byDomain: domainMap,
    rawEmails: [...rawEmails].sort(),
    domains: [...domains].sort(),
    ...(mailbox === undefined ? {} : { mailboxEmail: mailbox }),
    fingerprint,
    isEmpty: emailMap.size === 0 && domainMap.size === 0,
  };
}

interface FingerprintInput {
  lookbackDays: number;
  mailboxEmail?: string;
  candidates: KnownPartyCandidate[];
}

export function fingerprintFor(input: FingerprintInput): string {
  const candidates = input.candidates
    .map((candidate) => ({
      partyKey: candidate.partyKey,
      contactId: candidate.contactId ?? null,
      customerId: candidate.customerId ?? null,
      customerAccountId: candidate.customerAccountId ?? null,
      matchKind: candidate.matchKind,
      matchedValue: candidate.matchedValue,
      rank: candidate.rank,
      priority: candidate.priority,
    }))
    .sort((a, b) =>
      `${a.partyKey}|${a.matchKind}|${a.matchedValue}`.localeCompare(
        `${b.partyKey}|${b.matchKind}|${b.matchedValue}`
      )
    );

  const payload = {
    version: KNOWN_PARTIES_FINGERPRINT_VERSION,
    lookbackDays: input.lookbackDays,
    mailboxEmail: input.mailboxEmail ?? null,
    candidates,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
