/**
 * Sync orchestration: guard, fetch, map, write, record.
 *
 * Provider specifics live in handlers; this module owns the invariants that
 * hold regardless of provider — one run at a time per integration, parents
 * before children, per-record failures that do not abort the run, and a durable
 * account of what happened.
 *
 * What it deliberately does *not* own is which objects a function writes, or in
 * what order. That is `objectsForFunction` in `object-schema.ts` and the switch
 * in `record-writer.ts`, so adding a function is a change in those two places
 * rather than another branch in this loop.
 */

import { applyMappings, requestedSourcePaths } from "../field-mapper/field-mapper";
import { mappingVersionFor } from "../field-mapper/mapping-version";
import { functionsInWriteOrder } from "../object-schema";
import { getValidToken, refreshToken } from "../oauth/oauth-service";
import { requireSyncHandler } from "../registries/handler-registry";
import { canRefresh } from "../registries/provider-registry";
import {
  findIntegration,
  type IntegrationRecord,
} from "../repositories/integration-repository";
import { findMappings } from "../repositories/mapping-repository";
import {
  writeJsonArray,
  writeJsonCounts,
  writeJsonObject,
} from "../repositories/json-column";
import type {
  RecordIssue,
  SyncRunCoverage,
  TargetObject,
} from "../types/common";
import type { FieldMappingRule } from "../types/mapping";
import {
  syncLeaseTiming,
  syncTiming,
  systemClock,
  type Clock,
} from "./clock";
import {
  createFunctionCoverage,
  emptyRunCoverage,
  finishFunctionCoverage,
  recordCoverageIssues,
  recordCoveragePage,
  recordCoverageWrites,
  recordFunctionError,
} from "./coverage";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
  SyncLeaseLostError,
} from "./errors";

// Re-exported so provider handlers and the engine name the same errors.
export {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "./errors";
import {
  acquireSyncLease,
  assertLeaseHeld,
  closeSyncRun,
  recordSyncRunMappingVersions,
  startSyncLeaseHeartbeat,
  verifyLeaseHeld,
  type SyncLease,
  type SyncLeaseHeartbeat,
} from "./lease";
import {
  relinkOrphansForFunction,
  writeRecordsForFunction,
  type CollectedRecord,
} from "./record-writer";

export interface SyncResult {
  syncRunId: string | null;
  status: "success" | "partial" | "failed" | "discarded";
  /**
   * Rows written per target object. Objects the run did not touch are absent,
   * so a catalog sync reports products and offerings without claiming a
   * customer count of zero.
   */
  recordCounts: Partial<Record<TargetObject, number>>;
  issues: RecordIssue[];
  /** What was acquired, per function and object; separate from write success. */
  coverage: SyncRunCoverage;
  error?: string;
  attempts: number;
}

/** Total rows written across every object, for callers that want one number. */
export function totalRecordsWritten(
  counts: Partial<Record<TargetObject, number>>
): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

/**
 * Integrations with a run in flight in *this process*.
 *
 * This is only a fast path. It stops the common double-click without a database
 * round trip, but it cannot see another app instance; the lease on `SyncRun` is
 * the cross-instance authority. On globalThis for the same reason as the OAuth
 * state store: route modules are compiled separately and reloaded in dev, and
 * a per-module Set would let two concurrent requests each believe they hold
 * the lock.
 */
const globalForSync = globalThis as unknown as {
  syncInFlight: Set<string> | undefined;
};
const inFlight: Set<string> = globalForSync.syncInFlight ?? new Set<string>();
globalForSync.syncInFlight = inFlight;

export interface SyncOptions {
  clock?: Clock;
  trigger?: "manual" | "scheduled";
}

interface FunctionMappingSnapshot {
  rules: readonly FieldMappingRule[];
  version: string;
}

/**
 * Read every function's rules once, before the first provider request.
 *
 * The snapshot is the run's configuration. It is what gets hashed onto the run
 * and what `runOnce` applies on every retry, so a save that lands mid-run
 * changes the next run rather than half of this one.
 */
async function loadMappingSnapshots(
  integration: IntegrationRecord
): Promise<Map<string, FunctionMappingSnapshot>> {
  const snapshots = new Map<string, FunctionMappingSnapshot>();

  for (const functionName of integration.functionNames) {
    const rules = await findMappings(integration.id, functionName);
    snapshots.set(functionName, {
      rules,
      version: mappingVersionFor(rules),
    });
  }

  return snapshots;
}

/**
 * Run a sync for every function the integration serves.
 *
 * @returns A `discarded` result if a run is already in flight in this process
 *   or another one owns the durable lease. The second caller is told, rather
 *   than silently doing nothing.
 */
export async function executeSync(
  integrationId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const clock = options.clock ?? systemClock;
  const timing = syncTiming();
  const leaseTiming = syncLeaseTiming();

  const integration = await findIntegration(integrationId);
  if (integration === undefined) {
    return emptyResult("failed", "Integration not found");
  }
  if (integration.status !== "active") {
    return emptyResult(
      "failed",
      `Integration is ${integration.status}; connect it before syncing`
    );
  }

  if (inFlight.has(integrationId)) {
    return emptyResult("discarded", "A sync is already running");
  }
  inFlight.add(integrationId);

  try {
    const acquisition = await acquireSyncLease({
      integrationId,
      trigger: options.trigger ?? "manual",
      clock,
      timing: leaseTiming,
    });

    if (!acquisition.acquired) {
      return emptyResult(
        "discarded",
        "Another worker owns this integration's sync",
        acquisition.activeRunId
      );
    }

    const heartbeat = startSyncLeaseHeartbeat(
      acquisition.lease,
      clock,
      leaseTiming
    );

    try {
      return await runWithRetries(
        integration,
        acquisition.lease,
        heartbeat,
        clock,
        timing
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    // Must release even if something throws, or the integration is wedged
    // in this process until it restarts. The database lease has its own expiry
    // if this process stops here without closing the run.
    inFlight.delete(integrationId);
  }
}

interface RunState {
  recordCounts: Partial<Record<TargetObject, number>>;
  issues: RecordIssue[];
  coverage: SyncRunCoverage;
}

function emptyRunState(): RunState {
  return {
    recordCounts: {},
    issues: [],
    coverage: emptyRunCoverage(),
  };
}

async function runWithRetries(
  integration: IntegrationRecord,
  lease: SyncLease,
  heartbeat: SyncLeaseHeartbeat,
  clock: Clock,
  timing: ReturnType<typeof syncTiming>
): Promise<SyncResult> {
  let lastError = "";
  let lastAttempt = 0;
  let requiresReauthorization = false;
  let state = emptyRunState();
  let snapshots: Map<string, FunctionMappingSnapshot> | undefined;

  for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {
    lastAttempt = attempt;
    // A retry starts a fresh attempt. Keeping the previous attempt's counts
    // would double-count writes that idempotent upserts repeated; the counts
    // retained for a failed run are the writes from the attempt that failed.
    state = emptyRunState();

    try {
      await verifyLeaseHeld(lease, heartbeat, clock);

      if (snapshots === undefined) {
        snapshots = await loadMappingSnapshots(integration);

        const versions = Object.fromEntries(
          [...snapshots].map(([functionName, snapshot]) => [
            functionName,
            snapshot.version,
          ])
        );
        const recorded = await recordSyncRunMappingVersions(
          lease,
          clock,
          writeJsonObject(versions)
        );
        if (!recorded) return leaseLostResult(lease);
      }

      const outcome = await runOnce(
        integration,
        lease,
        heartbeat,
        clock,
        state,
        snapshots
      );

      const status = outcome.issues.some((i) => i.severity === "rejected")
        ? "partial"
        : "success";

      const closed = await closeSyncRun(lease, clock, {
        status,
        completedAt: new Date(clock.now()),
        recordCountsJson: writeJsonCounts(outcome.recordCounts),
        attempt,
        errorsJson: writeJsonArray(outcome.issues),
        coverageJson: JSON.stringify(outcome.coverage),
        markLastSync: true,
      });

      if (!closed) return leaseLostResult(lease);

      return { syncRunId: lease.runId, status, attempts: attempt, ...outcome };
    } catch (error) {
      // Losing the lease is not a provider failure: another worker owns the
      // run now, so retrying or closing this row would overwrite its work.
      if (error instanceof SyncLeaseLostError) {
        return leaseLostResult(lease);
      }

      lastError =
        error instanceof Error ? error.message : "Unknown sync failure";

      // A grant that survived a refresh and still 401s is dead. Retrying only
      // delays telling the user, so stop and flag it for reconnection. The flag
      // is applied inside the fenced close below, not here: a paused worker
      // must not change the connection after another worker has taken over.
      if (error instanceof ReauthorizationRequiredError) {
        requiresReauthorization = true;
        break;
      }

      const retryable =
        error instanceof RetryableSyncError ||
        (error instanceof ProviderHttpError && error.status >= 500);
      const attemptsLeft = attempt < timing.maxAttempts;

      console.error(
        `[sync] Integration ${integration.id} attempt ${attempt}/${timing.maxAttempts} failed: ${lastError}`
      );

      if (!retryable || !attemptsLeft) break;

      // Do not sleep through a takeover. The heartbeat should keep this lease
      // alive; if it could not, stop before the next provider request.
      try {
        assertLeaseHeld(lease, heartbeat, clock);
      } catch {
        return leaseLostResult(lease);
      }

      // Exponential backoff, unless the provider told us how long to wait.
      const wait =
        error instanceof RetryableSyncError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : timing.retryDelayMs * 2 ** (attempt - 1);
      await clock.sleep(wait);
    }
  }

  state.coverage.error = lastError;

  const closed = await closeSyncRun(lease, clock, {
    status: "failed",
    completedAt: new Date(clock.now()),
    attempt: lastAttempt,
    // Keep issues from the attempt that failed, and put the run-level error
    // in coverage as well. A failed run can have written records first; those
    // counts and pages are evidence, not noise to discard.
    recordCountsJson: writeJsonCounts(state.recordCounts),
    errorsJson: writeJsonArray(state.issues),
    coverageJson: JSON.stringify(state.coverage),
    markLastSync: false,
    ...(requiresReauthorization
      ? { integrationStatus: "requires_reauthorization" as const }
      : {}),
  });

  if (!closed) return leaseLostResult(lease);

  if (requiresReauthorization) {
    console.error(
      `[sync] Integration ${integration.id} needs re-authorization: ${lastError}`
    );
  }

  // The integration stays active: one failed run must not block the schedule.
  return {
    syncRunId: lease.runId,
    status: "failed",
    recordCounts: state.recordCounts,
    issues: state.issues,
    coverage: state.coverage,
    error: lastError,
    attempts: lastAttempt,
  };
}

function leaseLostResult(lease: SyncLease): SyncResult {
  return {
    syncRunId: lease.runId,
    status: "discarded",
    recordCounts: {},
    issues: [],
    coverage: emptyRunCoverage(),
    error: "Another worker took over this sync after its lease expired",
    attempts: 0,
  };
}

async function runOnce(
  integration: IntegrationRecord,
  lease: SyncLease,
  heartbeat: SyncLeaseHeartbeat,
  clock: Clock,
  state: RunState,
  snapshots: ReadonlyMap<string, FunctionMappingSnapshot>
): Promise<RunState> {
  const token = await getValidToken(integration.id, clock.now());
  await verifyLeaseHeld(lease, heartbeat, clock);

  // Ordered, not as stored: an agreement's parents are written by `identity`
  // and `catalog`, and `IntegrationFunction` rows come back in whatever order
  // Postgres likes. See `functionsInWriteOrder`.
  for (const functionName of functionsInWriteOrder(integration.functionNames)) {
    await verifyLeaseHeld(lease, heartbeat, clock);
    const handler = requireSyncHandler(functionName, integration.providerName);
    const coverage = createFunctionCoverage({
      functionName,
      supportedObjects: handler.objects,
      mappedObjects: new Set(),
    });
    state.coverage.functions.push(coverage);

    try {
      const snapshot = snapshots.get(functionName);
      if (snapshot === undefined) {
        throw new Error(
          `No mapping snapshot was recorded for '${functionName}'`
        );
      }
      const rules = snapshot.rules;
      const sourcePaths = requestedSourcePaths(rules);
      const mappedObjects = new Set(sourcePaths.keys());

      for (const entry of coverage.objects) {
        entry.mapped = mappedObjects.has(entry.object);
      }

      // Nothing mapped means nothing to write; say so rather than reporting a
      // successful run that produced no rows.
      if (rules.length === 0) {
        throw new Error(
          `No field mappings configured for '${functionName}'; set them up before syncing`
        );
      }

      const collected = new Map<TargetObject, CollectedRecord[]>();

      // Per-object `SourcePage.complete`, ANDed across pages. An object the
      // handler never yielded simply has no entry, which the writer reads as
      // "never yielded" and refuses to reconcile — as it must, since that is
      // also how an object with no mapping rule looks from here.
      const complete = new Map<TargetObject, boolean>();

      for await (const page of handler.fetchPages({
        integrationId: integration.id,
        accessToken: token.accessToken,
        metadata: token.metadata,
        requestedSourcePaths: sourcePaths,
        clock,
        // A long sync can outlive its access token. Handing handlers a way to
        // refresh mid-run means a 401 on page 40 costs one extra request rather
        // than the whole run's worth of pagination.
        //
        // Withheld entirely for credential kinds that cannot refresh — an API key
        // has nothing to exchange. `HandlerContext` reads an absent callback as
        // "a 401 is terminal", which turns a revoked key into a clean reconnect
        // prompt instead of a failed refresh wearing a confusing error.
        ...(canRefresh(integration.providerName)
          ? {
              refreshAccessToken: async () => {
                assertLeaseHeld(lease, heartbeat, clock);
                const refreshed = await refreshToken(integration.id);
                return {
                  accessToken: refreshed.accessToken,
                  metadata: refreshed.metadata,
                };
              },
            }
          : {}),
      })) {
        assertLeaseHeld(lease, heartbeat, clock);

        const bucket = collected.get(page.object) ?? [];
        for (const raw of page.records) {
          bucket.push({
            externalSourceId: handler.externalIdOf(raw),
            externalRefs: handler.externalRefsOf(raw, page.object),
            mapped: applyMappings(rules, page.object, raw),
          });
        }
        collected.set(page.object, bucket);

        recordCoveragePage(
          coverage,
          page.object,
          page.records.length,
          page.complete
        );

        const previous = complete.get(page.object);
        const thisPage = page.complete === true;
        complete.set(
          page.object,
          previous === undefined ? thisPage : previous && thisPage
        );
      }

      // Parents before children, in the order the function declares. Which
      // writers run, and in what sequence, is the writer module's business —
      // this loop knows only that a function produced records and that someone
      // has to persist them.
      //
      // `mappedObjects` and `complete` are passed rather than re-derived in the
      // writer: the engine already holds the mapping rules and has just seen the
      // pages, and a second derivation is a second thing that can disagree with
      // the first — which here would mean deleting rows a run never covered.
      //
      // This is the last point before the write phase where a takeover can be
      // detected without money already spent. A writer that loses the lease
      // midway cannot finish the run, but it must not start a new function or
      // reconciliation while another owner might be running.
      await verifyLeaseHeld(lease, heartbeat, clock);

      const result = await writeRecordsForFunction(integration.id, functionName, {
        collected,
        mappedObjects,
        complete,
      });

      for (const [object, count] of Object.entries(result.counts)) {
        const key = object as TargetObject;
        state.recordCounts[key] = (state.recordCounts[key] ?? 0) + count;
      }
      state.issues.push(...result.issues);

      recordCoverageWrites(coverage, result.counts);
      recordCoverageIssues(coverage, result.issues);

      await verifyLeaseHeld(lease, heartbeat, clock);

      // Children stranded by earlier runs may now be linkable.
      await relinkOrphansForFunction(integration.id, functionName);

      finishFunctionCoverage(coverage);
    } catch (error) {
      recordFunctionError(
        coverage,
        error instanceof Error ? error.message : "Unknown function failure"
      );
      finishFunctionCoverage(coverage);
      throw error;
    }
  }

  return state;
}

function emptyResult(
  status: SyncResult["status"],
  error: string,
  syncRunId: string | null = null
): SyncResult {
  return {
    syncRunId,
    status,
    recordCounts: {},
    issues: [],
    coverage: emptyRunCoverage(),
    error,
    attempts: 0,
  };
}
