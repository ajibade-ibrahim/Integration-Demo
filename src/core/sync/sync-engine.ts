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

import { prisma } from "@/lib/prisma";
import { applyMappings, requestedSourcePaths } from "../field-mapper/field-mapper";
import { functionsInWriteOrder } from "../object-schema";
import { getValidToken, refreshToken } from "../oauth/oauth-service";
import { requireSyncHandler } from "../registries/handler-registry";
import { canRefresh } from "../registries/provider-registry";
import {
  findIntegration,
  markLastSync,
  updateStatus,
  type IntegrationRecord,
} from "../repositories/integration-repository";
import { findMappings } from "../repositories/mapping-repository";
import { writeJsonArray, writeJsonCounts } from "../repositories/json-column";
import type {
  RecordIssue,
  SyncRunCoverage,
  TargetObject,
} from "../types/common";
import { syncTiming, systemClock, type Clock } from "./clock";
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
} from "./errors";

// Re-exported so provider handlers and the engine name the same errors.
export {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "./errors";
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
 * Integrations with a run in flight.
 *
 * On globalThis for the same reason as the OAuth state store: route modules are
 * compiled separately and reloaded in dev, and a per-module Set would let two
 * concurrent requests each believe they hold the lock.
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

/**
 * Run a sync for every function the integration serves.
 *
 * @returns A `discarded` result if a run is already in flight — the second
 *   caller is told, rather than silently doing nothing.
 */
export async function executeSync(
  integrationId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const clock = options.clock ?? systemClock;
  const timing = syncTiming();

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

  const syncRun = await prisma.syncRun.create({
    data: {
      integrationId,
      status: "running",
      trigger: options.trigger ?? "manual",
    },
    select: { id: true },
  });

  try {
    return await runWithRetries(integration, syncRun.id, clock, timing);
  } finally {
    // Must release even if something throws, or the integration is wedged
    // until the process restarts.
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
  syncRunId: string,
  clock: Clock,
  timing: ReturnType<typeof syncTiming>
): Promise<SyncResult> {
  let lastError = "";
  let lastAttempt = 0;
  let state = emptyRunState();

  for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {
    lastAttempt = attempt;
    // A retry starts a fresh attempt. Keeping the previous attempt's counts
    // would double-count writes that idempotent upserts repeated; the counts
    // retained for a failed run are the writes from the attempt that failed.
    state = emptyRunState();

    try {
      const outcome = await runOnce(integration, clock, state);

      const status = outcome.issues.some((i) => i.severity === "rejected")
        ? "partial"
        : "success";

      await prisma.syncRun.update({
        where: { id: syncRunId },
        data: {
          status,
          completedAt: new Date(clock.now()),
          recordCountsJson: writeJsonCounts(outcome.recordCounts),
          attempt,
          errorsJson: writeJsonArray(outcome.issues),
          coverageJson: JSON.stringify(outcome.coverage),
        },
      });
      await markLastSync(integration.id, new Date(clock.now()));

      return { syncRunId, status, attempts: attempt, ...outcome };
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Unknown sync failure";

      // A grant that survived a refresh and still 401s is dead. Retrying only
      // delays telling the user, so stop and flag it for reconnection.
      if (error instanceof ReauthorizationRequiredError) {
        await updateStatus(integration.id, "requires_reauthorization");
        console.error(
          `[sync] Integration ${integration.id} needs re-authorization: ${lastError}`
        );
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

      // Exponential backoff, unless the provider told us how long to wait.
      const wait =
        error instanceof RetryableSyncError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : timing.retryDelayMs * 2 ** (attempt - 1);
      await clock.sleep(wait);
    }
  }

  state.coverage.error = lastError;

  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: {
      status: "failed",
      completedAt: new Date(clock.now()),
      attempt: lastAttempt,
      // Keep issues from the attempt that failed, and put the run-level error
      // in coverage as well. A failed run can have written records first; those
      // counts and pages are evidence, not noise to discard.
      recordCountsJson: writeJsonCounts(state.recordCounts),
      errorsJson: writeJsonArray(state.issues),
      coverageJson: JSON.stringify(state.coverage),
    },
  });

  // The integration stays active: one failed run must not block the schedule.
  return {
    syncRunId,
    status: "failed",
    recordCounts: state.recordCounts,
    issues: state.issues,
    coverage: state.coverage,
    error: lastError,
    attempts: lastAttempt,
  };
}

async function runOnce(
  integration: IntegrationRecord,
  clock: Clock,
  state: RunState
): Promise<RunState> {
  const token = await getValidToken(integration.id, clock.now());

  // Ordered, not as stored: an agreement's parents are written by `identity`
  // and `catalog`, and `IntegrationFunction` rows come back in whatever order
  // Postgres likes. See `functionsInWriteOrder`.
  for (const functionName of functionsInWriteOrder(integration.functionNames)) {
    const handler = requireSyncHandler(functionName, integration.providerName);
    const coverage = createFunctionCoverage({
      functionName,
      supportedObjects: handler.objects,
      mappedObjects: new Set(),
    });
    state.coverage.functions.push(coverage);

    try {
      const rules = await findMappings(integration.id, functionName);
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
                const refreshed = await refreshToken(integration.id);
                return {
                  accessToken: refreshed.accessToken,
                  metadata: refreshed.metadata,
                };
              },
            }
          : {}),
      })) {
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
  error: string
): SyncResult {
  return {
    syncRunId: null,
    status,
    recordCounts: {},
    issues: [],
    coverage: emptyRunCoverage(),
    error,
    attempts: 0,
  };
}
