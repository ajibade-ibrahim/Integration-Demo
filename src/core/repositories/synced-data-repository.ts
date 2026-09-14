/**
 * Reads over the records the sync engine wrote.
 *
 * Deliberately reports the *unlinked* contact count alongside the rows. A
 * contact whose company could not be resolved is kept rather than dropped, and
 * that decision is only defensible if the consequence is visible — otherwise it
 * is silent data loss wearing a different hat.
 *
 * Resolved accounts are read here too, beside the rows they were resolved from,
 * rather than in `identity-repository`. That file exists so every write and
 * every match query is scoped by `userId` in one reviewable place; a read-only
 * projection for a page is not part of the matcher and would only make the
 * surface it guards larger. This one still scopes by `userId` — the rule holds
 * wherever the query lives.
 */

import { prisma } from "@/lib/prisma";
import { readJsonObject } from "./json-column";
import type {
  IdentityAssertionKind,
  IdentityEvidenceSource,
  IdentityKeyKind,
} from "../types/common";

export interface CustomerRow {
  id: string;
  externalSourceId: string;
  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  createDate: Date | null;
  type: string | null;
  customFields: Record<string, string>;
  integrationLabel: string;
  providerName: string;
  contactCount: number;
}

export interface ContactRow {
  id: string;
  externalSourceId: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  phone: string | null;
  customerName: string | null;
  /** Provider's own company id, present even when the link is unresolved. */
  externalCustomerId: string | null;
  integrationLabel: string;
}

export interface SyncedDataPage {
  customers: CustomerRow[];
  contacts: ContactRow[];
  totals: {
    customers: number;
    contacts: number;
    /** Contacts that claimed a company we could not resolve. */
    unlinkedContacts: number;
  };
}

export async function loadSyncedData(
  userId: string,
  take = 200
): Promise<SyncedDataPage> {
  const scope = { integration: { userId } };

  const [customers, contacts, customerTotal, contactTotal, unlinked] =
    await Promise.all([
      prisma.customer.findMany({
        where: scope,
        orderBy: { name: "asc" },
        take,
        include: {
          integration: { select: { instanceLabel: true, providerName: true } },
          _count: { select: { contacts: true } },
        },
      }),
      prisma.contact.findMany({
        where: scope,
        orderBy: { name: "asc" },
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          customer: { select: { name: true } },
        },
      }),
      prisma.customer.count({ where: scope }),
      prisma.contact.count({ where: scope }),
      prisma.contact.count({
        where: { ...scope, customerId: null, externalCustomerId: { not: null } },
      }),
    ]);

  return {
    customers: customers.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      domain: row.domain,
      email: row.email,
      industry: row.industry,
      createDate: row.createDate,
      type: row.type,
      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
      providerName: row.integration.providerName,
      contactCount: row._count.contacts,
    })),
    contacts: contacts.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      email: row.email,
      jobTitle: row.jobTitle,
      phone: row.phone,
      customerName: row.customer?.name ?? null,
      externalCustomerId: row.externalCustomerId,
      integrationLabel: row.integration.instanceLabel,
    })),
    totals: {
      customers: customerTotal,
      contacts: contactTotal,
      unlinkedContacts: unlinked,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolved accounts
// ---------------------------------------------------------------------------

/** One per-integration row that resolved onto an account. */
export interface AccountMemberRow {
  /** The `Customer.id`, which is what an assertion is anchored to. */
  id: string;
  externalSourceId: string;
  name: string;
  integrationId: string;
  integrationLabel: string;
  providerName: string;
}

/** One entry in the identity table — the evidence a grouping rests on. */
export interface AccountKeyRow {
  kind: IdentityKeyKind;
  /** As the provider wrote it. The normalized form is never shown. */
  rawValue: string;
  source: IdentityEvidenceSource;
}

export interface CustomerAccountRow {
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  createDate: Date | null;
  type: string | null;
  customFields: Record<string, string>;
  /** field name -> the integrationId whose value won it. */
  fieldProvenance: Record<string, string>;
  members: AccountMemberRow[];
  keys: AccountKeyRow[];
}

/**
 * The resolved accounts for one user, with their members and their evidence.
 *
 * Members and keys come along rather than being fetched per row, because an
 * account on its own is not reviewable. The two questions a user has about a
 * grouping are "which records is this?" and "why?", and answering the second
 * needs the keys — a merge nobody can explain is one nobody can trust enough to
 * correct.
 *
 * Sorted `name asc, id asc`. The id tiebreak matters more than it looks: two
 * accounts can genuinely share a resolved name, and without it their order
 * would shift between renders of an unchanged page.
 */
export async function loadCustomerAccounts(
  userId: string,
  take = 200
): Promise<CustomerAccountRow[]> {
  const accounts = await prisma.customerAccount.findMany({
    where: { userId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take,
    include: {
      members: {
        orderBy: [{ externalSourceId: "asc" }],
        select: {
          id: true,
          externalSourceId: true,
          name: true,
          integrationId: true,
          integration: { select: { instanceLabel: true, providerName: true } },
        },
      },
      keys: {
        orderBy: [{ kind: "asc" }, { value: "asc" }],
        select: { kind: true, rawValue: true, source: true },
      },
    },
  });

  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    domain: account.domain,
    email: account.email,
    industry: account.industry,
    createDate: account.createDate,
    type: account.type,
    customFields: readJsonObject(account.customFields),
    fieldProvenance: readJsonObject(account.fieldProvenance),
    members: account.members.map((member) => ({
      id: member.id,
      externalSourceId: member.externalSourceId,
      name: member.name,
      integrationId: member.integrationId,
      integrationLabel: member.integration.instanceLabel,
      providerName: member.integration.providerName,
    })),
    keys: account.keys.map((key) => ({
      kind: key.kind as IdentityKeyKind,
      rawValue: key.rawValue,
      source: key.source as IdentityEvidenceSource,
    })),
  }));
}

/** A human verdict, with enough of both records to be readable in a list. */
export interface AssertionDisplayRow {
  id: string;
  kind: IdentityAssertionKind;
  note: string | null;
  left: { id: string; name: string; integrationLabel: string };
  right: { id: string; name: string; integrationLabel: string };
}

/**
 * Every assertion this user has made, named rather than as a pair of uuids.
 *
 * Shown so the undo is reachable. An assertion is the one input the resolver
 * never revises, so a verdict the user cannot find is a grouping they cannot
 * change — and the pass itself gives no hint that one is in play, because a
 * `same` group simply looks like a successful match.
 */
export async function loadAssertionsForDisplay(
  userId: string
): Promise<AssertionDisplayRow[]> {
  const member = {
    select: {
      id: true,
      name: true,
      integration: { select: { instanceLabel: true } },
    },
  } as const;

  const rows = await prisma.identityAssertion.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }],
    include: { left: member, right: member },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as IdentityAssertionKind,
    note: row.note,
    left: {
      id: row.left.id,
      name: row.left.name,
      integrationLabel: row.left.integration.instanceLabel,
    },
    right: {
      id: row.right.id,
      name: row.right.name,
      integrationLabel: row.right.integration.instanceLabel,
    },
  }));
}
