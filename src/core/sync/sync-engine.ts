/**
 * Sync orchestration: guard, fetch, map, write, record.
 *
 * Provider specifics live in handlers; this module owns the invariants that
 * hold regardless of provider — one run at a time per integration, customers
 * before contacts, per-record failures that do not abort the run, and a
 * durable account of what happened.
 */

import { prisma } from "@/lib/prisma";
import { applyMappings, requestedSourcePaths } from "../field-mapper/field-mapper";
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
import { writeJsonArray } from "../repositories/json-column";
import type { RecordIssue, TargetObject } from "../types/common";
import type { MappedRecord } from "../types/mapping";
import { syncTiming, systemClock, type Clock } from "./clock";
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
  relinkOrphanedContacts,
  writeContacts,
  writeCustomers,
} from "./record-writer";

export interface SyncResult {
  syncRunId: string | null;
  status: "success" | "partial" | "failed" | "discarded";
  customerCount: number;
  contactCount: number;
  issues: RecordIssue[];
  error?: string;
  attempts: number;
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

async function runWithRetries(
  integration: IntegrationRecord,
  syncRunId: string,
  clock: Clock,
  timing: ReturnType<typeof syncTiming>
): Promise<SyncResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {
    try {
      const outcome = await runOnce(integration, clock);

      const status = outcome.issues.some((i) => i.severity === "rejected")
        ? "partial"
        : "success";

      await prisma.syncRun.update({
        where: { id: syncRunId },
        data: {
          status,
          completedAt: new Date(clock.now()),
          customerCount: outcome.customerCount,
          contactCount: outcome.contactCount,
          attempt,
          errorsJson: writeJsonArray(outcome.issues),
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

  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: {
      status: "failed",
      completedAt: new Date(clock.now()),
      attempt: timing.maxAttempts,
      errorsJson: writeJsonArray([{ reason: lastError }]),
    },
  });

  // The integration stays active: one failed run must not block the schedule.
  return {
    syncRunId,
    status: "failed",
    customerCount: 0,
    contactCount: 0,
    issues: [],
    error: lastError,
    attempts: timing.maxAttempts,
  };
}

interface RunOutcome {
  customerCount: number;
  contactCount: number;
  issues: RecordIssue[];
}

async function runOnce(
  integration: IntegrationRecord,
  clock: Clock
): Promise<RunOutcome> {
  const token = await getValidToken(integration.id, clock.now());

  let customerCount = 0;
  let contactCount = 0;
  const issues: RecordIssue[] = [];

  for (const functionName of integration.functionNames) {
    const handler = requireSyncHandler(functionName, integration.providerName);
    const rules = await findMappings(integration.id, functionName);

    // Nothing mapped means nothing to write; say so rather than reporting a
    // successful run that produced no rows.
    if (rules.length === 0) {
      throw new Error(
        `No field mappings configured for '${functionName}'; set them up before syncing`
      );
    }

    const collected = new Map<TargetObject, CollectedRecord[]>();

    for await (const page of handler.fetchPages({
      integrationId: integration.id,
      accessToken: token.accessToken,
      metadata: token.metadata,
      requestedSourcePaths: requestedSourcePaths(rules),
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
          externalCustomerId:
            page.object === "contact"
              ? handler.externalCustomerIdOf(raw)
              : undefined,
          mapped: applyMappings(rules, page.object, raw),
        });
      }
      collected.set(page.object, bucket);
    }

    // Customers first — contacts resolve their association against the index
    // this produces.
    const customers = collected.get("customer") ?? [];
    const customerResult = await writeCustomers(integration.id, customers);
    customerCount += customerResult.written;
    issues.push(...customerResult.issues);

    const contacts = collected.get("contact") ?? [];
    const contactResult = await writeContacts(
      integration.id,
      contacts,
      customerResult.externalToInternal
    );
    contactCount += contactResult.written;
    issues.push(...contactResult.issues);
  }

  // Contacts stranded by earlier runs may now be linkable.
  await relinkOrphanedContacts(integration.id);

  return { customerCount, contactCount, issues };
}

interface CollectedRecord {
  externalSourceId: string | undefined;
  externalCustomerId: string | undefined;
  mapped: MappedRecord;
}

function emptyResult(
  status: SyncResult["status"],
  error: string
): SyncResult {
  return {
    syncRunId: null,
    status,
    customerCount: 0,
    contactCount: 0,
    issues: [],
    error,
    attempts: 0,
  };
}
