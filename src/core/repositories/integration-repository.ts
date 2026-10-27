/**
 * Integration persistence, including the set of functions each one serves.
 */

import { prisma } from "@/lib/prisma";
import type { IntegrationStatus } from "../types/common";
import { writeJsonArray, writeJsonCounts } from "./json-column";

export interface IntegrationRecord {
  id: string;
  userId: string;
  providerName: string;
  /** Every function this integration serves, sorted for stable comparison. */
  functionNames: string[];
  status: IntegrationStatus;
  instanceLabel: string;
  syncIntervalHours: number;
  /**
   * Rank for field survivorship only, never for matching. Lower wins.
   *
   * Per-integration rather than per-provider so two HubSpot portals can be
   * ordered against each other.
   */
  identityPriority: number;
  authorizationTimestamp: Date | null;
  lastSyncTimestamp: Date | null;
  /**
   * Stable provider account/tenant scope, or null when unknown. `""` means the
   * provider's ids are global.
   */
  sourceAccountId: string | null;
  pendingTokenRevocation: boolean;
  createdAt: Date;
}

interface RowWithFunctions {
  id: string;
  userId: string;
  providerName: string;
  status: string;
  instanceLabel: string;
  syncIntervalHours: number;
  identityPriority: number;
  authorizationTimestamp: Date | null;
  lastSyncTimestamp: Date | null;
  sourceAccountId: string | null;
  pendingTokenRevocation: boolean;
  createdAt: Date;
  functions: Array<{ functionName: string }>;
}

function toRecord(row: RowWithFunctions): IntegrationRecord {
  return {
    id: row.id,
    userId: row.userId,
    providerName: row.providerName,
    functionNames: row.functions.map((f) => f.functionName).sort(),
    status: row.status as IntegrationStatus,
    instanceLabel: row.instanceLabel,
    syncIntervalHours: row.syncIntervalHours,
    identityPriority: row.identityPriority,
    authorizationTimestamp: row.authorizationTimestamp,
    lastSyncTimestamp: row.lastSyncTimestamp,
    sourceAccountId: row.sourceAccountId,
    pendingTokenRevocation: row.pendingTokenRevocation,
    createdAt: row.createdAt,
  };
}

const withFunctions = { functions: { select: { functionName: true } } } as const;

/**
 * Every relation that cascades from an integration, in the same words the
 * schema uses. Counting from this one list keeps the delete-audit totals, the
 * preview shown in the confirmation, and `recordCount` from drifting apart.
 */
const CASCADED_COUNT_SELECT = {
  functions: true,
  fieldMappings: true,
  discoveredFields: true,
  customers: true,
  contacts: true,
  products: true,
  offerings: true,
  prices: true,
  features: true,
  entitlements: true,
  agreements: true,
  subscriptions: true,
  agreementItems: true,
  agreementEntitlements: true,
  agreementDiscounts: true,
  invoices: true,
  invoiceLines: true,
  payments: true,
  syncRuns: true,
} as const;

export type CascadedCounts = {
  [K in keyof typeof CASCADED_COUNT_SELECT]: number;
};

/** Relations whose rows are business data; config and run history are not. */
const SYNCED_RECORD_RELATIONS = [
  "customers",
  "contacts",
  "products",
  "offerings",
  "prices",
  "features",
  "entitlements",
  "agreements",
  "subscriptions",
  "agreementItems",
  "agreementEntitlements",
  "agreementDiscounts",
  "invoices",
  "invoiceLines",
  "payments",
] as const satisfies ReadonlyArray<keyof CascadedCounts>;

function countSyncedRecords(counts: CascadedCounts): number {
  return SYNCED_RECORD_RELATIONS.reduce(
    (sum, relation) => sum + counts[relation],
    0
  );
}

type RemovalSnapshotClient = Pick<
  typeof prisma,
  "integration" | "customerAccountKey" | "customer"
>;

interface IntegrationRemovalSnapshot {
  integration: {
    id: string;
    userId: string;
    providerName: string;
    instanceLabel: string;
    sourceAccountId: string | null;
  };
  counts: CascadedCounts;
  retiredKeys: number;
  affectedAccountIds: string[];
}

async function readIntegrationRemovalSnapshot(
  db: RemovalSnapshotClient,
  id: string
): Promise<IntegrationRemovalSnapshot | undefined> {
  const integration = await db.integration.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      providerName: true,
      instanceLabel: true,
      sourceAccountId: true,
      _count: { select: CASCADED_COUNT_SELECT },
    },
  });
  if (integration === null) return undefined;

  const [keyAccounts, customerAccounts, retiredKeys] = await Promise.all([
    db.customerAccountKey.findMany({
      where: { sourceIntegrationId: id },
      select: { customerAccountId: true },
      distinct: ["customerAccountId"],
    }),
    db.customer.findMany({
      where: { integrationId: id, customerAccountId: { not: null } },
      select: { customerAccountId: true },
      distinct: ["customerAccountId"],
    }),
    db.customerAccountKey.count({ where: { sourceIntegrationId: id } }),
  ]);

  const affectedAccountIds = [
    ...new Set([
      ...keyAccounts.map((row) => row.customerAccountId),
      ...customerAccounts.flatMap((row) =>
        row.customerAccountId === null ? [] : [row.customerAccountId]
      ),
    ]),
  ].sort();

  return {
    integration: {
      id: integration.id,
      userId: integration.userId,
      providerName: integration.providerName,
      instanceLabel: integration.instanceLabel,
      sourceAccountId: integration.sourceAccountId,
    },
    counts: integration._count as CascadedCounts,
    retiredKeys,
    affectedAccountIds,
  };
}

export interface IntegrationDeletionPreview {
  /** Business rows that will be removed. */
  recordCount: number;
  /** Identity keys currently sourced from this connection. */
  keyCount: number;
  /** Affected accounts that will keep at least one member from another source. */
  accountsRebuilt: number;
  /** Affected accounts that will be left empty and reaped. */
  accountsRemoved: number;
}

/**
 * What deleting this integration will remove, for the confirmation panel.
 *
 * `accountsRebuilt` is based on members, not keys: a key from a surviving
 * connection does not keep an account alive, because accounts with no customers
 * are shells and the resolution pass reaps them.
 */
export async function loadIntegrationDeletionPreview(
  id: string
): Promise<IntegrationDeletionPreview | undefined> {
  const snapshot = await readIntegrationRemovalSnapshot(prisma, id);
  if (snapshot === undefined) return undefined;

  const survivors =
    snapshot.affectedAccountIds.length === 0
      ? []
      : await prisma.customer.findMany({
          where: {
            integrationId: { not: id },
            customerAccountId: { in: snapshot.affectedAccountIds },
          },
          select: { customerAccountId: true },
          distinct: ["customerAccountId"],
        });

  return {
    recordCount: countSyncedRecords(snapshot.counts),
    keyCount: snapshot.retiredKeys,
    accountsRebuilt: survivors.length,
    accountsRemoved:
      snapshot.affectedAccountIds.length - survivors.length,
  };
}

export interface CreateIntegrationInput {
  userId: string;
  providerName: string;
  functionNames: readonly string[];
  instanceLabel: string;
  syncIntervalHours?: number;
}

/**
 * Create an integration in `pending_authorization` with its function set.
 *
 * @throws If no function is given — an integration with no functions has no
 *   scopes to request and nothing to sync, so it is never a valid record.
 */
export async function createIntegration(
  input: CreateIntegrationInput
): Promise<IntegrationRecord> {
  const functionNames = [...new Set(input.functionNames)].sort();
  if (functionNames.length === 0) {
    throw new Error("An integration must serve at least one function");
  }

  const row = await prisma.integration.create({
    data: {
      userId: input.userId,
      providerName: input.providerName,
      instanceLabel: input.instanceLabel,
      status: "pending_authorization" satisfies IntegrationStatus,
      syncIntervalHours: clampInterval(input.syncIntervalHours ?? 24),
      functions: { create: functionNames.map((functionName) => ({ functionName })) },
    },
    include: withFunctions,
  });

  return toRecord(row);
}

/** Sync intervals outside 1..168 hours are meaningless; clamp rather than reject. */
export function clampInterval(hours: number): number {
  if (!Number.isFinite(hours)) return 24;
  return Math.min(168, Math.max(1, Math.round(hours)));
}

/** The default every integration starts at, so most ranks begin tied. */
export const DEFAULT_IDENTITY_PRIORITY = 100;

/**
 * Clamp a survivorship rank to 1..1000, the way {@link clampInterval} does.
 *
 * Clamped rather than rejected because there is no wrong answer to reject —
 * only a total order, so a rank of 5000 means the same thing as 1000. A
 * validation error would be pedantry about a number whose absolute value never
 * mattered.
 *
 * The default is what a non-number becomes, not 1. Falling back to the
 * strongest rank would let a malformed request quietly promote an integration
 * over every other source of the same field.
 */
export function clampIdentityPriority(priority: number): number {
  if (!Number.isFinite(priority)) return DEFAULT_IDENTITY_PRIORITY;
  return Math.min(1000, Math.max(1, Math.round(priority)));
}

/**
 * Set an integration's survivorship rank.
 *
 * Scoped by `userId` and reporting whether it matched, so the route answers 404
 * for someone else's integration rather than silently succeeding.
 *
 * Changing this changes what an account *says*, never who is *in* it — matching
 * never reads the rank. Resolution still has to re-run before the change is
 * visible, which is what `/api/identity/resolve` is for.
 */
export async function updateIdentityPriority(
  id: string,
  userId: string,
  priority: number
): Promise<boolean> {
  const result = await prisma.integration.updateMany({
    where: { id, userId },
    data: { identityPriority: clampIdentityPriority(priority) },
  });
  return result.count === 1;
}

export async function findIntegration(
  id: string
): Promise<IntegrationRecord | undefined> {
  const row = await prisma.integration.findUnique({
    where: { id },
    include: withFunctions,
  });
  return row === null ? undefined : toRecord(row);
}

/**
 * Fetch an integration only if `userId` owns it.
 *
 * Separate from {@link findIntegration} rather than replacing it, because the
 * two callers are genuinely different. Anything serving a request must scope to
 * the caller; the scheduler must not, since `runScheduledSyncs` sweeps every
 * user's integrations through `listAllIntegrations` and has no user in scope at
 * all. Making `userId` mandatory on `findIntegration` would force the
 * background path to invent one.
 *
 * Returns `undefined` for "not yours" as well as "does not exist", so callers
 * answer 404 to both. A 403 would confirm the id names a real integration,
 * which is exactly what someone enumerating ids is trying to learn.
 */
export async function findIntegrationForUser(
  id: string,
  userId: string
): Promise<IntegrationRecord | undefined> {
  const row = await prisma.integration.findFirst({
    where: { id, userId },
    include: withFunctions,
  });
  return row === null ? undefined : toRecord(row);
}

export async function listIntegrations(
  userId: string
): Promise<IntegrationRecord[]> {
  const rows = await prisma.integration.findMany({
    where: { userId },
    include: withFunctions,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRecord);
}

export async function updateStatus(
  id: string,
  status: IntegrationStatus
): Promise<void> {
  await prisma.integration.update({ where: { id }, data: { status } });
}

/** Mark an integration authorized and record the timestamp. */
export async function markAuthorized(id: string, at: Date): Promise<void> {
  await prisma.integration.update({
    where: { id },
    data: {
      status: "active" satisfies IntegrationStatus,
      authorizationTimestamp: at,
    },
  });
}

export async function markPendingRevocation(id: string): Promise<void> {
  await prisma.integration.update({
    where: { id },
    data: { pendingTokenRevocation: true },
  });
}

/**
 * Add functions to an existing integration.
 *
 * Does not change status. Whether the widened scope set is still covered by the
 * stored grant is a separate question, answered by `scopesAreCovered` — see
 * `needsReauthorization` in the OAuth service.
 */
export async function addFunctions(
  id: string,
  functionNames: readonly string[]
): Promise<IntegrationRecord | undefined> {
  // Re-adding a function an integration already serves is a no-op, not an
  // error, and the database is what decides that: `skipDuplicates` compiles to
  // `INSERT ... ON CONFLICT DO NOTHING` against
  // @@unique([integrationId, functionName]).
  //
  // Reading the existing rows first and filtering in app code reaches the same
  // answer, and did until this ran on Postgres, but check-then-insert is not
  // atomic. Two requests adding the same function concurrently — a double
  // click is enough — both see it missing, and the second insert then fails
  // the constraint with P2002, which is precisely the error the filtering was
  // there to avoid. Resolving the conflict inside one statement is what makes
  // the no-op hold under concurrency rather than only in a quiet test.
  //
  // The Set dedupes within the argument itself; the constraint covers the rest.
  await prisma.integrationFunction.createMany({
    data: [...new Set(functionNames)].map((functionName) => ({
      integrationId: id,
      functionName,
    })),
    skipDuplicates: true,
  });

  return findIntegration(id);
}

/**
 * Remove a function from an integration.
 *
 * Its mappings and cached discovery go too — they are meaningless without the
 * function, and leaving them would resurrect stale rules if it were re-added.
 * The granted scopes are deliberately left alone: they describe what the user
 * consented to, which removing a function does not undo.
 */
export async function removeFunction(
  id: string,
  functionName: string
): Promise<IntegrationRecord | undefined> {
  const remaining = await prisma.integrationFunction.count({
    where: { integrationId: id, functionName: { not: functionName } },
  });
  if (remaining === 0) {
    throw new Error(
      "Cannot remove the last function from an integration; delete the integration instead"
    );
  }

  await prisma.$transaction([
    prisma.integrationFunction.deleteMany({
      where: { integrationId: id, functionName },
    }),
    prisma.fieldMapping.deleteMany({ where: { integrationId: id, functionName } }),
    prisma.discoveredField.deleteMany({ where: { integrationId: id, functionName } }),
  ]);

  return findIntegration(id);
}

/**
 * Every integration, across all users.
 *
 * For the scheduler, which is not acting on behalf of a signed-in user. UI
 * paths must keep using `listIntegrations` so one user never sees another's.
 */
export async function listAllIntegrations(): Promise<IntegrationRecord[]> {
  const rows = await prisma.integration.findMany({
    orderBy: { createdAt: "asc" },
    include: withFunctions,
  });
  return rows.map(toRecord);
}

/** Integrations stuck awaiting authorization past the cutoff. */
export async function findStalePendingAuthorizations(
  olderThan: Date
): Promise<IntegrationRecord[]> {
  const rows = await prisma.integration.findMany({
    where: {
      status: "pending_authorization" satisfies IntegrationStatus,
      createdAt: { lt: olderThan },
    },
    include: withFunctions,
  });
  return rows.map(toRecord);
}

export interface IntegrationDeletionResult {
  auditId: string | null;
  userId: string;
  providerName: string;
  instanceLabel: string;
  sourceAccountId: string | null;
  counts: CascadedCounts;
  recordCount: number;
  retiredKeys: number;
  affectedAccountIds: string[];
}

/**
 * Delete an integration, retire its keys, and write the tombstone.
 *
 * Every child relation cascades at the schema level, so the integration delete
 * removes functions, tokens, mappings, discovery cache, synced records, and
 * sync runs. Identity keys do **not** cascade: they belong to the account, not
 * the integration, and may be held on behalf of another survivor. Delete
 * precisely the keys this connection supplied (`sourceIntegrationId`), leaving
 * every other member's keys alone.
 *
 * The audit row is written in the same transaction as the removal, so there is
 * no state in which the data is gone and the explanation never arrived. It
 * records counts and affected account ids only — never synced values.
 *
 * Reassessment is deliberately **not** here. This function has callers that are
 * not user-visible deletions (the failed-connect rollback), and opening a
 * tenant-wide resolution run as a side effect of cleanup would be surprising.
 * The API deletion path uses `deleteIntegrationAndReassess`; pass
 * `{ audit: false }` only for a rollback that never produced user-visible data.
 */
export async function deleteIntegration(
  id: string,
  options: { audit?: boolean } = {}
): Promise<IntegrationDeletionResult | undefined> {
  return prisma.$transaction(
    async (tx) => {
      const snapshot = await readIntegrationRemovalSnapshot(tx, id);
      if (snapshot === undefined) return undefined;

      const deletedKeys = await tx.customerAccountKey.deleteMany({
        where: { sourceIntegrationId: id },
      });

      await tx.integration.delete({ where: { id } });

      const recordCount = countSyncedRecords(snapshot.counts);
      const audit =
        options.audit === false
          ? null
          : await tx.identityWithdrawal.create({
              data: {
                userId: snapshot.integration.userId,
                kind: "integration_deleted",
                integrationId: id,
                providerName: snapshot.integration.providerName,
                instanceLabel: snapshot.integration.instanceLabel,
                sourceAccountId: snapshot.integration.sourceAccountId,
                removedJson: writeJsonCounts(snapshot.counts),
                removedRecords: recordCount,
                retiredKeys: deletedKeys.count,
                affectedAccountIdsJson: writeJsonArray(
                  snapshot.affectedAccountIds
                ),
                status: "recorded",
              },
              select: { id: true },
            });

      return {
        auditId: audit?.id ?? null,
        userId: snapshot.integration.userId,
        providerName: snapshot.integration.providerName,
        instanceLabel: snapshot.integration.instanceLabel,
        sourceAccountId: snapshot.integration.sourceAccountId,
        counts: snapshot.counts,
        recordCount,
        retiredKeys: deletedKeys.count,
        affectedAccountIds: snapshot.affectedAccountIds,
      };
    },
    { timeout: 30_000 }
  );
}
