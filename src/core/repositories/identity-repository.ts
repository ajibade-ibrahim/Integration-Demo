/**
 * Every database operation identity resolution performs.
 *
 * ## Why all of it lives here
 *
 * The severe failure mode of a cross-integration matcher is not a missed join.
 * A missed join is visible — the user sees two Acmes and says so. It is a
 * *cross-tenant* merge: one customer's company data appearing under another
 * customer's account, which looks exactly like the matcher working well.
 *
 * The defence is that every query below filters on `userId`, and the only way
 * to keep that reviewable is for there to be no other place that touches these
 * tables. That is also why the mutations use `updateMany`/`deleteMany` with
 * `{ id, userId }` rather than `update`/`delete` with `{ id }`: Prisma's
 * single-record forms require a unique where-clause, so `{ id }` alone is the
 * path of least resistance and it silently spans tenants. The plural forms
 * accept the compound filter and report how many rows they actually matched,
 * which turns "not yours" into a number the caller can check instead of a
 * successful write.
 *
 * ## Transaction granularity
 *
 * One transaction per customer, not per run. The pass is monotone and
 * resumable — an interrupted run leaves correct partial state and the next pass
 * continues — so a single transaction spanning a large tenant would buy
 * nothing and hold locks for the length of a whole scan.
 */

import { prisma } from "@/lib/prisma";
import { readJsonArray, readJsonObject, writeJsonArray, writeJsonObject } from "./json-column";
import type { CrosswalkPair } from "../identity/crosswalk";
import type { ProviderMetadata } from "../types/registry";
import {
  type CustomerType,
  type EmailClass,
  type FieldProvenanceEntry,
  type IdentityAssertionKind,
  type IdentityEvidenceSource,
  type IdentityIssue,
  type IdentityKeyKind,
  type IdentityRunTrigger,
  type SyncRunStatus,
} from "../types/common";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One customer row, with everything the pass needs to key and rank it. */
export interface ResolutionCustomer {
  id: string;
  integrationId: string;
  providerName: string;
  /** From `Integration.identityPriority` — lower wins a value conflict. */
  identityPriority: number;
  instanceLabel: string;
  externalSourceId: string;

  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  createDate: Date | null;
  type: CustomerType | null;
  customFields: Record<string, string>;

  /**
   * When this connection last finished a sync. That is the observation time for
   * evidence from this record; `Customer.updatedAt` is not, because resolution
   * itself links customers and bumps it. Falls back to `updatedAt` only for a
   * customer on a connection that has never completed a sync.
   */
  observedAt: Date;

  /**
   * `<providerName> -> that provider's id for this same company`, from
   * `crossRef.<provider>` mapping rules.
   *
   * The deterministic join: a Metrifox customer naming its Stripe id matches
   * the Stripe customer with no email or domain overlap required at all.
   */
  crossRefs: Record<string, string>;

  /**
   * The same shape, but pasted or uploaded by a human rather than mapped.
   *
   * Held apart from `crossRefs` because the record writer overwrites that
   * column on every upsert — an imported pair stored there would last until the
   * next sync and no longer. Keeping them separate is also what lets the key
   * record `imported_crosswalk` as its source instead of naming a mapping rule
   * that does not exist.
   */
  importedCrossRefs: Record<string, string>;

  /**
   * The integration token's `providerMetadata`, for the external-id scope.
   *
   * Carried rather than looked up in the pass because scope is a property of
   * *this connection* — HubSpot portal id, Salesforce org id — and two
   * integrations of the same provider must not share one. Empty when the
   * integration has no token, which correctly costs a tenant-scoped provider
   * its self-key rather than emitting an unscoped one.
   */
  providerMetadata: ProviderMetadata;

  customerAccountId: string | null;

  /**
   * Addresses of contacts that resolved to this customer.
   *
   * The universal key source: all five providers map `contact.email`, while
   * only two carry an account-level address. Contacts whose company could not
   * be resolved are excluded by construction — they are reached through this
   * customer's own `contacts` relation, so an unresolved contact has no path
   * into this list. That is the correct exclusion: a contact whose company is
   * unknown is not evidence about any company.
   */
  contactEmails: string[];
}

export interface IdentityKeyRow {
  id: string;
  customerAccountId: string;
  kind: IdentityKeyKind;
  value: string;
  rawValue: string;
  emailClass: EmailClass;
  source: IdentityEvidenceSource;
  sourceIntegrationId: string;
}

/** A key to write. `id` is assigned by the database. */
export interface NewIdentityKey {
  kind: IdentityKeyKind;
  value: string;
  rawValue: string;
  emailClass: EmailClass;
  source: IdentityEvidenceSource;
  sourceIntegrationId: string;
}

export interface AssertionRow {
  id: string;
  kind: IdentityAssertionKind;
  leftCustomerId: string;
  rightCustomerId: string;
  note: string | null;
}

/** The resolved field values for an account, as survivorship decided them. */
export interface AccountFields {
  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  createDate: Date | null;
  type: CustomerType | null;
  customFields: Record<string, string>;
  /**
   * field name (or `customFields.<key>`) -> the source record and evidence
   * that won it, plus every losing value and why it lost.
   */
  fieldProvenance: Record<string, FieldProvenanceEntry>;
}

export interface ResolutionRunCounts {
  accountsCreated: number;
  accountsAbsorbed: number;
  accountsReaped: number;
  customersLinked: number;
  keysIndexed: number;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every customer belonging to one user, in the pass's canonical order.
 *
 * Ordered by `(identityPriority, providerName, integrationId, externalSourceId)`
 * — the first claimant of a key wins, so the pass's output would otherwise
 * depend on the order Postgres happened to return rows in. Ordering here rather
 * than in the pass keeps the sort in the one place that can push it down to the
 * database, and the chain ends in a column pair that is unique, so the total
 * order has no ties left to break arbitrarily.
 *
 * A whole-tenant scan. Fine at this scale; the incremental path is to filter on
 * `Customer.updatedAt` since the last run's `startedAt` and then expand to the
 * transitive closure of touched accounts, which is why the run row indexes that
 * timestamp.
 */
export async function loadResolutionInput(
  userId: string
): Promise<ResolutionCustomer[]> {
  const rows = await prisma.customer.findMany({
    where: { integration: { userId } },
    orderBy: [
      { integration: { identityPriority: "asc" } },
      { integration: { providerName: "asc" } },
      { integrationId: "asc" },
      { externalSourceId: "asc" },
    ],
    include: {
      integration: {
        select: {
          providerName: true,
          identityPriority: true,
          instanceLabel: true,
          lastSyncTimestamp: true,
          // The scope segment of every self-key on this integration.
          token: { select: { providerMetadata: true } },
        },
      },
      contacts: {
        where: { email: { not: null } },
        select: { email: true },
        orderBy: { email: "asc" },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    integrationId: row.integrationId,
    providerName: row.integration.providerName,
    identityPriority: row.integration.identityPriority,
    instanceLabel: row.integration.instanceLabel,
    externalSourceId: row.externalSourceId,
    name: row.name,
    domain: row.domain,
    email: row.email,
    industry: row.industry,
    createDate: row.createDate,
    type: row.type as CustomerType | null,
    customFields: readJsonObject(row.customFields),
    observedAt: row.integration.lastSyncTimestamp ?? row.updatedAt,
    crossRefs: readJsonObject(row.crossRefs),
    importedCrossRefs: readJsonObject(row.importedCrossRefs),
    providerMetadata: readJsonObject(
      row.integration.token?.providerMetadata ?? "{}"
    ),
    customerAccountId: row.customerAccountId,
    contactEmails: row.contacts.flatMap((c) => (c.email === null ? [] : [c.email])),
  }));
}

/** Every human assertion for one user. Read by the pass, never written by it. */
export async function loadAssertions(userId: string): Promise<AssertionRow[]> {
  const rows = await prisma.identityAssertion.findMany({
    where: { userId },
    orderBy: [{ leftCustomerId: "asc" }, { rightCustomerId: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as IdentityAssertionKind,
    leftCustomerId: row.leftCustomerId,
    rightCustomerId: row.rightCustomerId,
    note: row.note,
  }));
}

/**
 * Which accounts already claim any of these keys.
 *
 * The candidate lookup at the heart of the pass. Returns every matching key
 * rather than a bare account id set, because the *kind* that matched decides
 * which account wins when several are candidates — a foreign id beats an email
 * beats a shared domain.
 */
export async function findAccountsForKeys(
  userId: string,
  keys: readonly { kind: IdentityKeyKind; value: string }[]
): Promise<IdentityKeyRow[]> {
  // `OR: []` matches every row in Prisma, not none — the one input that would
  // turn a lookup for nothing into a scan of everything.
  if (keys.length === 0) return [];

  const rows = await prisma.customerAccountKey.findMany({
    where: {
      userId,
      OR: keys.map((key) => ({ kind: key.kind, value: key.value })),
    },
  });

  return rows.map(toKeyRow);
}

/** Every key held by the named accounts, for deciding what an account owns. */
export async function loadAccountKeys(
  userId: string,
  accountIds: readonly string[]
): Promise<IdentityKeyRow[]> {
  if (accountIds.length === 0) return [];

  const rows = await prisma.customerAccountKey.findMany({
    where: { userId, customerAccountId: { in: [...accountIds] } },
    orderBy: [{ kind: "asc" }, { value: "asc" }],
  });

  return rows.map(toKeyRow);
}

function toKeyRow(row: {
  id: string;
  customerAccountId: string;
  kind: string;
  value: string;
  rawValue: string;
  emailClass: string;
  source: string;
  sourceIntegrationId: string;
}): IdentityKeyRow {
  return {
    id: row.id,
    customerAccountId: row.customerAccountId,
    kind: row.kind as IdentityKeyKind,
    value: row.value,
    rawValue: row.rawValue,
    emailClass: row.emailClass as EmailClass,
    source: row.source as IdentityEvidenceSource,
    sourceIntegrationId: row.sourceIntegrationId,
  };
}

/** What the pass needs to know about a candidate account before choosing it. */
export interface AccountSummary {
  id: string;
  /** The age tiebreak when several accounts claim a customer's keys. */
  createdAt: Date;
  /** Members in canonical id order, for the `distinct` veto and the absorb test. */
  memberIds: string[];
}

/**
 * Summarise candidate accounts.
 *
 * Three questions answered by one query, because the pass asks all three about
 * the same accounts at the same moment and the answers have to be consistent
 * with each other: which account is oldest, who is already in it, and is it a
 * singleton this customer may absorb.
 *
 * Accounts with no members are returned with an empty `memberIds` rather than
 * omitted — the pass reaps those, and silently dropping them here would make an
 * abandoned key claim look like it belonged to nobody.
 */
export async function loadAccountSummaries(
  userId: string,
  accountIds: readonly string[]
): Promise<Map<string, AccountSummary>> {
  if (accountIds.length === 0) return new Map();

  const accounts = await prisma.customerAccount.findMany({
    where: { userId, id: { in: [...accountIds] } },
    select: {
      id: true,
      createdAt: true,
      members: { select: { id: true }, orderBy: { id: "asc" } },
    },
  });

  return new Map(
    accounts.map((account) => [
      account.id,
      {
        id: account.id,
        createdAt: account.createdAt,
        memberIds: account.members.map((member) => member.id),
      },
    ])
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Delete this user's accounts that have no members left.
 *
 * Step 0 of the pass, and not housekeeping. `Customer` cascades away when its
 * integration is deleted, which leaves the account behind still claiming its
 * keys. Those claims would then block the correct account from ever forming —
 * the unique on `(userId, kind, value)` cannot tell a live claim from an
 * abandoned one. Keys go with the account by cascade.
 *
 * @returns The ids of the accounts removed. Ids rather than a count, because a
 *   caller that has already reported a key as "claimed by another account"
 *   needs to know when that other account has just ceased to exist.
 */
export async function reapEmptyAccounts(userId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const empty = await tx.customerAccount.findMany({
      where: { userId, members: { none: {} } },
      select: { id: true },
    });
    if (empty.length === 0) return [];

    const ids = empty.map((account) => account.id);

    // Emptiness is re-asserted in the delete rather than trusted from the
    // select: a concurrent pass could have attached a member in between, and
    // deleting an account that has one would cascade its keys away and strand
    // the member with no account at all.
    await tx.customerAccount.deleteMany({
      where: { userId, id: { in: ids }, members: { none: {} } },
    });

    // Report what actually went, not what was selected. The caller uses this to
    // suppress conflicts against a deleted account, and an id that survived the
    // delete is still a live rival.
    const survivors = await tx.customerAccount.findMany({
      where: { userId, id: { in: ids } },
      select: { id: true },
    });
    const stillHere = new Set(survivors.map((account) => account.id));

    return ids.filter((id) => !stillHere.has(id));
  });
}

/**
 * Create an account for one customer, link it, and index its keys.
 *
 * The 0-candidate path, and also what a customer with no usable key at all
 * gets — resolution's "done when" is that every customer ends up linked, so an
 * unmatchable record becomes a singleton rather than being skipped.
 *
 * @returns The new account id, any keys another account had already claimed,
 *   and how many key rows were actually written.
 */
export async function createAccountForCustomer(args: {
  userId: string;
  customerId: string;
  fields: AccountFields;
  keys: readonly NewIdentityKey[];
}): Promise<{
  accountId: string;
  contested: NewIdentityKey[];
  keysIndexed: number;
}> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.customerAccount.create({
      data: { userId: args.userId, ...toFieldData(args.fields) },
      select: { id: true },
    });

    // Scoped by userId as well as id, so a customer id from another tenant
    // cannot be linked into an account created here.
    await tx.customer.updateMany({
      where: { id: args.customerId, integration: { userId: args.userId } },
      data: { customerAccountId: account.id },
    });

    const { contested, inserted } = await insertKeys(tx, {
      userId: args.userId,
      accountId: account.id,
      keys: args.keys,
    });

    return { accountId: account.id, contested, keysIndexed: inserted };
  });
}

/**
 * Link a customer to an existing account and index any keys it adds.
 *
 * @returns The keys that could not be indexed because another account holds
 *   them. Not an error: the caller records an issue and the grouping stands.
 */
export async function attachCustomerToAccount(args: {
  userId: string;
  customerId: string;
  accountId: string;
  keys: readonly NewIdentityKey[];
}): Promise<{
  linked: boolean;
  contested: NewIdentityKey[];
  keysIndexed: number;
}> {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.customerAccount.count({
      where: { id: args.accountId, userId: args.userId },
    });
    if (owned === 0) {
      // Not this user's account. Refusing rather than throwing keeps one bad
      // candidate from aborting a whole pass, and the count tells the caller.
      return { linked: false, contested: [...args.keys], keysIndexed: 0 };
    }

    await tx.customer.updateMany({
      where: { id: args.customerId, integration: { userId: args.userId } },
      data: { customerAccountId: args.accountId },
    });

    const { contested, inserted } = await insertKeys(tx, {
      userId: args.userId,
      accountId: args.accountId,
      keys: args.keys,
    });

    return { linked: true, contested, keysIndexed: inserted };
  });
}

/**
 * Move a singleton account's member and keys onto another account, then delete
 * the shell.
 *
 * The one merge the pass is allowed to perform, and it is the common path
 * rather than an optimization: without it, whichever integration synced first
 * would permanently decide the grouping, because its customer would already
 * hold an account by the time the second one arrived.
 *
 * A key the target already holds is dropped rather than re-pointed — the two
 * are the same claim, and the target's is the older one, so keeping it
 * preserves `firstSeenAt` and the `rawValue` the user first saw.
 */
export async function absorbAccount(args: {
  userId: string;
  fromAccountId: string;
  intoAccountId: string;
}): Promise<{ absorbed: boolean }> {
  if (args.fromAccountId === args.intoAccountId) return { absorbed: false };

  return prisma.$transaction(async (tx) => {
    const owned = await tx.customerAccount.count({
      where: {
        userId: args.userId,
        id: { in: [args.fromAccountId, args.intoAccountId] },
      },
    });
    // Both, or neither. A pair spanning two tenants is the merge this module
    // exists to make impossible.
    if (owned !== 2) return { absorbed: false };

    await tx.customer.updateMany({
      where: {
        customerAccountId: args.fromAccountId,
        integration: { userId: args.userId },
      },
      data: { customerAccountId: args.intoAccountId },
    });

    const [moving, existing] = await Promise.all([
      tx.customerAccountKey.findMany({
        where: { userId: args.userId, customerAccountId: args.fromAccountId },
      }),
      tx.customerAccountKey.findMany({
        where: { userId: args.userId, customerAccountId: args.intoAccountId },
        select: { kind: true, value: true },
      }),
    ]);

    const held = new Set(existing.map((key) => `${key.kind} ${key.value}`));
    const duplicated = moving.filter((k) => held.has(`${k.kind} ${k.value}`));
    const repointed = moving.filter((k) => !held.has(`${k.kind} ${k.value}`));

    // Two statements rather than one per key, and the plural forms rather than
    // `delete`/`update`: a single-record form whose row has gone raises P2025,
    // and any raise inside a Postgres transaction aborts every command after
    // it — the same trap `insertKeys` below documents at length.
    if (duplicated.length > 0) {
      await tx.customerAccountKey.deleteMany({
        where: { id: { in: duplicated.map((key) => key.id) } },
      });
    }
    if (repointed.length > 0) {
      await tx.customerAccountKey.updateMany({
        where: { id: { in: repointed.map((key) => key.id) } },
        data: { customerAccountId: args.intoAccountId },
      });
    }

    await tx.customerAccount.deleteMany({
      where: { id: args.fromAccountId, userId: args.userId },
    });

    return { absorbed: true };
  });
}

/**
 * Overwrite an account's resolved fields.
 *
 * Whole-record, never field by field. The resolved values are a pure function
 * of (members, precedence) and every pass recomputes all of them, so a partial
 * update is the one way they could drift from their inputs.
 */
export async function updateAccountFields(args: {
  userId: string;
  accountId: string;
  fields: AccountFields;
}): Promise<boolean> {
  const result = await prisma.customerAccount.updateMany({
    where: { id: args.accountId, userId: args.userId },
    data: toFieldData(args.fields),
  });
  return result.count === 1;
}

function toFieldData(fields: AccountFields) {
  return {
    name: fields.name,
    domain: fields.domain,
    email: fields.email,
    industry: fields.industry,
    createDate: fields.createDate,
    type: fields.type,
    customFields: writeJsonObject(fields.customFields),
    fieldProvenance: writeJsonObject(fields.fieldProvenance),
  };
}

interface InsertKeysResult {
  /** Keys a *different* account holds. The caller raises an issue and moves on. */
  contested: NewIdentityKey[];
  /** Rows actually written, so a no-op pass can report having written nothing. */
  inserted: number;
}

/**
 * Insert keys for an account, reporting the ones another account already holds.
 *
 * ## Why this asks first instead of inserting and catching
 *
 * The obvious shape — insert each key, catch `P2002`, look up who holds it —
 * cannot work here, and the reason is Postgres rather than Prisma. A statement
 * that raises inside a transaction aborts the *whole* transaction: every
 * subsequent command returns `25P02` until rollback, so the lookup in the catch
 * block fails too, and so does the rest of the customer's write. Recovering
 * mid-transaction needs a `SAVEPOINT`, which Prisma does not expose.
 *
 * So: one query establishing who holds what, then one insert of the keys that
 * are free. `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`, which does
 * *not* abort the transaction — it is what makes a key inserted by a concurrent
 * pass in the gap between the two statements benign rather than fatal. Such a
 * key goes unreported for this run, which is acceptable precisely because the
 * pass is idempotent: the next one asks again and sees it.
 *
 * @returns The keys held by a *different* account. A key this account already
 *   holds is ordinary — every re-run re-offers all of them — and reporting it
 *   would raise an issue on every pass forever.
 */
async function insertKeys(
  tx: Pick<typeof prisma, "customerAccountKey">,
  args: {
    userId: string;
    accountId: string;
    keys: readonly NewIdentityKey[];
  }
): Promise<InsertKeysResult> {
  if (args.keys.length === 0) return { contested: [], inserted: 0 };

  const held = await tx.customerAccountKey.findMany({
    where: {
      userId: args.userId,
      OR: args.keys.map((key) => ({ kind: key.kind, value: key.value })),
    },
    select: { kind: true, value: true, customerAccountId: true },
  });

  const holders = new Map(
    held.map((row) => [`${row.kind} ${row.value}`, row.customerAccountId])
  );

  const contested: NewIdentityKey[] = [];
  const free: NewIdentityKey[] = [];

  for (const key of args.keys) {
    const holder = holders.get(`${key.kind} ${key.value}`);
    if (holder === undefined) free.push(key);
    else if (holder !== args.accountId) contested.push(key);
  }

  if (free.length === 0) return { contested, inserted: 0 };

  const written = await tx.customerAccountKey.createMany({
    data: free.map((key) => ({
      userId: args.userId,
      customerAccountId: args.accountId,
      kind: key.kind,
      value: key.value,
      rawValue: key.rawValue,
      emailClass: key.emailClass,
      source: key.source,
      sourceIntegrationId: key.sourceIntegrationId,
    })),
    skipDuplicates: true,
  });

  // Rows written, not keys offered. Every pass re-offers every key it can
  // build, so counting offers would have a second, entirely idempotent pass
  // reporting a full run's worth of work — in the one field a human reads to
  // find out whether anything actually happened.
  return { contested, inserted: written.count };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export interface ResolutionRunRecord {
  id: string;
  status: SyncRunStatus;
  trigger: IdentityRunTrigger;
  startedAt: Date;
  completedAt: Date | null;
  counts: ResolutionRunCounts;
  issues: IdentityIssue[];
}

export async function startResolutionRun(
  userId: string,
  trigger: IdentityRunTrigger
): Promise<string> {
  const run = await prisma.identityResolutionRun.create({
    data: { userId, status: "running", trigger },
    select: { id: true },
  });
  return run.id;
}

/**
 * Close out a run.
 *
 * Scoped by userId for the same reason every other mutation here is, even
 * though the caller just created the row: the rule is only reviewable if it has
 * no exceptions.
 */
export async function finishResolutionRun(args: {
  userId: string;
  runId: string;
  status: SyncRunStatus;
  counts: ResolutionRunCounts;
  issues: readonly IdentityIssue[];
}): Promise<void> {
  await prisma.identityResolutionRun.updateMany({
    where: { id: args.runId, userId: args.userId },
    data: {
      status: args.status,
      completedAt: new Date(),
      ...args.counts,
      issuesJson: writeJsonArray(args.issues),
    },
  });
}

export async function listResolutionRuns(
  userId: string,
  take = 10
): Promise<ResolutionRunRecord[]> {
  const runs = await prisma.identityResolutionRun.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    take,
  });

  return runs.map((run) => ({
    id: run.id,
    status: run.status as SyncRunStatus,
    trigger: run.trigger as IdentityRunTrigger,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    counts: {
      accountsCreated: run.accountsCreated,
      accountsAbsorbed: run.accountsAbsorbed,
      accountsReaped: run.accountsReaped,
      customersLinked: run.customersLinked,
      keysIndexed: run.keysIndexed,
    },
    issues: readJsonArray<IdentityIssue>(run.issuesJson),
  }));
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Record a human's verdict on two customers.
 *
 * The pair is ordered here as well as by the caller. `assertions.ts` owns the
 * canonical ordering, but the unique constraint is what actually depends on it
 * — an unordered pair inserts as a second row and the constraint means nothing
 * — so the guarantee is repeated at the point where breaking it does damage.
 *
 * Upserts rather than inserts: asserting the opposite of a previous verdict on
 * the same pair is a correction, not a duplicate.
 */
export async function upsertAssertion(args: {
  userId: string;
  kind: IdentityAssertionKind;
  customerIdA: string;
  customerIdB: string;
  note?: string;
}): Promise<AssertionRow | undefined> {
  if (args.customerIdA === args.customerIdB) return undefined;

  const [leftCustomerId, rightCustomerId] = [
    args.customerIdA,
    args.customerIdB,
  ].sort() as [string, string];

  // Both customers must belong to this user. Without this an assertion is a
  // way to name someone else's customer and have the next pass merge it in.
  const owned = await prisma.customer.count({
    where: {
      id: { in: [leftCustomerId, rightCustomerId] },
      integration: { userId: args.userId },
    },
  });
  if (owned !== 2) return undefined;

  const row = await prisma.identityAssertion.upsert({
    where: { leftCustomerId_rightCustomerId: { leftCustomerId, rightCustomerId } },
    create: {
      userId: args.userId,
      kind: args.kind,
      leftCustomerId,
      rightCustomerId,
      ...(args.note === undefined ? {} : { note: args.note }),
    },
    update: {
      kind: args.kind,
      ...(args.note === undefined ? {} : { note: args.note }),
    },
  });

  return {
    id: row.id,
    kind: row.kind as IdentityAssertionKind,
    leftCustomerId: row.leftCustomerId,
    rightCustomerId: row.rightCustomerId,
    note: row.note,
  };
}

/**
 * Withdraw an assertion.
 *
 * The undo matters more here than elsewhere: an assertion is the one thing the
 * resolver will never revise on its own, so a wrong one is permanent until a
 * human removes it.
 */
export async function deleteAssertion(
  userId: string,
  assertionId: string
): Promise<boolean> {
  const result = await prisma.identityAssertion.deleteMany({
    where: { id: assertionId, userId },
  });
  return result.count === 1;
}

// ---------------------------------------------------------------------------
// Imported crosswalks
// ---------------------------------------------------------------------------

export interface CrosswalkImportResult {
  /** Pairs whose local id named a customer on this integration. */
  applied: number;
  /** Local ids that matched no customer, in input order and de-duplicated. */
  unmatched: string[];
}

/**
 * Record foreign ids a human supplied for this integration's customers.
 *
 * Merged into `importedCrossRefs` per customer rather than replacing it, so
 * importing a Stripe crosswalk does not silently drop a HubSpot one imported
 * last week. Within one provider the newest import wins, which is the only
 * reading of a re-import that lets a user fix a wrong id.
 *
 * An unmatched local id is reported rather than treated as an error. The whole
 * reason this route exists is that the foreign system's export is not in sync
 * with what we hold — a crosswalk covering a customer that has not been synced
 * yet is normal, and failing the import over it would mean the user has to
 * hand-filter the file before we will look at it.
 */
export async function importCrosswalk(args: {
  userId: string;
  integrationId: string;
  foreignProvider: string;
  pairs: readonly CrosswalkPair[];
}): Promise<CrosswalkImportResult | undefined> {
  // Ownership is checked here rather than trusted from the caller, for the
  // reason every other mutation in this file scopes by userId: an unscoped
  // write is a way to attach a cross-reference to someone else's customer and
  // have the next pass act on it.
  const owned = await prisma.integration.count({
    where: { id: args.integrationId, userId: args.userId },
  });
  if (owned !== 1) return undefined;

  // Last pair wins on a repeated local id, matching the within-provider rule
  // above — a file listing one customer twice is stating a correction, not a
  // conflict for a human to settle.
  const byLocalId = new Map<string, string>();
  for (const pair of args.pairs) byLocalId.set(pair.localExternalId, pair.foreignId);

  const rows = await prisma.customer.findMany({
    where: {
      integrationId: args.integrationId,
      externalSourceId: { in: [...byLocalId.keys()] },
    },
    select: { id: true, externalSourceId: true, importedCrossRefs: true },
  });

  const matched = new Set(rows.map((row) => row.externalSourceId));

  for (const row of rows) {
    const merged = readJsonObject(row.importedCrossRefs);
    merged[args.foreignProvider] = byLocalId.get(row.externalSourceId) ?? "";
    await prisma.customer.update({
      where: { id: row.id },
      data: { importedCrossRefs: writeJsonObject(merged) },
    });
  }

  return {
    applied: rows.length,
    unmatched: [...byLocalId.keys()].filter((localId) => !matched.has(localId)),
  };
}

/**
 * Forget every imported pair naming one provider, for one integration.
 *
 * The undo. A crosswalk is human-supplied evidence the resolver will never
 * revise on its own, so a file pasted against the wrong integration would
 * otherwise keep joining the wrong companies on every pass.
 */
export async function clearImportedCrossRefs(args: {
  userId: string;
  integrationId: string;
  foreignProvider: string;
}): Promise<number> {
  const owned = await prisma.integration.count({
    where: { id: args.integrationId, userId: args.userId },
  });
  if (owned !== 1) return 0;

  const rows = await prisma.customer.findMany({
    where: { integrationId: args.integrationId },
    select: { id: true, importedCrossRefs: true },
  });

  let cleared = 0;
  for (const row of rows) {
    const merged = readJsonObject(row.importedCrossRefs);
    if (!(args.foreignProvider in merged)) continue;
    delete merged[args.foreignProvider];
    await prisma.customer.update({
      where: { id: row.id },
      data: { importedCrossRefs: writeJsonObject(merged) },
    });
    cleared += 1;
  }
  return cleared;
}
