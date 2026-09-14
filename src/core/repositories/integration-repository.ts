/**
 * Integration persistence, including the set of functions each one serves.
 */

import { prisma } from "@/lib/prisma";
import type { IntegrationStatus } from "../types/common";

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
    pendingTokenRevocation: row.pendingTokenRevocation,
    createdAt: row.createdAt,
  };
}

const withFunctions = { functions: { select: { functionName: true } } } as const;

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

export async function markLastSync(id: string, at: Date): Promise<void> {
  await prisma.integration.update({
    where: { id },
    data: { lastSyncTimestamp: at },
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

/**
 * Delete an integration and everything hanging off it.
 *
 * Every child relation cascades at the schema level, so this one delete removes
 * functions, tokens, mappings, discovery cache, synced records, and sync runs.
 */
export async function deleteIntegration(id: string): Promise<void> {
  await prisma.integration.delete({ where: { id } });
}
