/**
 * Scheduled work: syncing integrations that are due, and expiring integrations
 * abandoned mid-authorization.
 *
 * Next.js has no scheduler, so this is a plain function driven by an HTTP route
 * that something external pokes — cron, a platform scheduler, or `npm run
 * worker` locally. Keeping the policy here rather than in the route means it is
 * testable and callable from a script without going through HTTP.
 */

import {
  findStalePendingAuthorizations,
  listAllIntegrations,
  updateStatus,
} from "../repositories/integration-repository";
import { resolveAfterSync } from "../identity/resolve-after-sync";
import { recoverExpiredSyncRuns } from "./lease";
import { executeSync, totalRecordsWritten } from "./sync-engine";
import type { TargetObject } from "../types/common";
import { systemClock, type Clock } from "./clock";
import type { IntegrationRecord } from "../repositories/integration-repository";

/** How long an unauthorized integration lingers before being marked expired. */
const PENDING_AUTHORIZATION_TTL_MINUTES = 30;

/**
 * Is this integration due for a scheduled sync?
 *
 * Never-synced active integrations are due immediately — an integration that
 * was connected but never synced is the most likely thing a user is waiting on.
 */
export function isDue(integration: IntegrationRecord, now: number): boolean {
  if (integration.status !== "active") return false;
  if (integration.lastSyncTimestamp === null) return true;

  const intervalMs = integration.syncIntervalHours * 60 * 60 * 1000;
  return now - integration.lastSyncTimestamp.getTime() >= intervalMs;
}

export interface ScheduledRun {
  integrationId: string;
  label: string;
  status: string;
  /** Rows written per target object; objects this run did not touch are absent. */
  recordCounts: Partial<Record<TargetObject, number>>;
  /** Total across every object, so a caller can log one number. */
  recordsWritten: number;
  error?: string;
}

/** One per distinct owner of the integrations a tick synced, not one per run. */
export interface ScheduledResolution {
  userId: string;
  status: string;
  accountsCreated: number;
  customersLinked: number;
}

export interface SchedulerResult {
  checked: number;
  due: number;
  runs: ScheduledRun[];
  expired: number;
  /** Runs whose lease expired and were marked abandoned before selection. */
  recovered: number;
  resolutions: ScheduledResolution[];
}

export interface SchedulerOptions {
  clock?: Clock;
  /** Cap the work one tick will take on, so a backlog cannot stall the tick. */
  maxIntegrations?: number;
}

export async function runScheduledSyncs(
  options: SchedulerOptions = {}
): Promise<SchedulerResult> {
  const clock = options.clock ?? systemClock;
  const now = clock.now();

  // A crashed process leaves its run `running` until someone reclaims that
  // integration. Sweeping here makes the failure visible on the next tick even
  // when the integration is not due for hours. Acquisition repeats the same
  // recovery under an integration lock for a manual sync.
  const recovered = await recoverExpiredSyncRuns(now);

  const expired = await expirePendingAuthorizations(now);

  const all = await listAllIntegrations();
  const due = all.filter((integration) => isDue(integration, now));
  const selected =
    options.maxIntegrations === undefined
      ? due
      : due.slice(0, options.maxIntegrations);

  const runs: ScheduledRun[] = [];
  const synced: IntegrationRecord[] = [];

  // Sequential on purpose. Running every integration at once would multiply our
  // request rate against every provider simultaneously, which is the fastest
  // way to earn a 429 across the board.
  for (const integration of selected) {
    const result = await executeSync(integration.id, {
      trigger: "scheduled",
      clock,
    });

    runs.push({
      integrationId: integration.id,
      label: integration.instanceLabel,
      status: result.status,
      recordCounts: result.recordCounts,
      recordsWritten: totalRecordsWritten(result.recordCounts),
      ...(result.error === undefined ? {} : { error: result.error }),
    });

    // The worker that owns a discarded run resolves after its own work. A
    // second whole-tenant pass here would duplicate the matching pass against
    // data that is still being written.
    if (result.status !== "discarded") synced.push(integration);
  }

  return {
    checked: all.length,
    due: due.length,
    runs,
    expired,
    recovered,
    resolutions: await resolveTouchedUsers(synced),
  };
}

/**
 * Resolve identities once per distinct owner of the integrations just synced.
 *
 * Once per *user* is the point. Resolution is a cross-integration, whole-tenant
 * pass, so a tick covering three of one user's connections would otherwise run
 * the same pass three times — and the first two would run against a tenant that
 * is still half-synced, reaching groupings the third pass then has to revise.
 * After the loop rather than interleaved with it, for the same reason.
 *
 * A user whose sync failed is still resolved. The pass is over every customer
 * the tenant has, not over what this tick fetched, so there is usually
 * something to group even when today's fetch got nothing — and skipping it
 * would mean a provider outage also froze the grouping of every other
 * integration the user owns.
 */
async function resolveTouchedUsers(
  synced: readonly IntegrationRecord[]
): Promise<ScheduledResolution[]> {
  const resolutions: ScheduledResolution[] = [];
  for (const userId of distinctOwners(synced)) {
    const outcome = await resolveAfterSync(userId, "scheduled");
    resolutions.push({
      userId,
      // `undefined` means resolution threw and `resolveAfterSync` swallowed it
      // to protect the syncs. Naming it here keeps the tick's report honest
      // without failing the tick.
      status: outcome?.status ?? "failed",
      accountsCreated: outcome?.counts.accountsCreated ?? 0,
      customersLinked: outcome?.counts.customersLinked ?? 0,
    });
  }
  return resolutions;
}

/**
 * The distinct owners of a set of integrations, sorted.
 *
 * Sorted so that a tick's report does not depend on the order integrations were
 * selected in.
 *
 * Exported for its own test rather than tested through a whole tick.
 * `runScheduledSyncs` sweeps every integration in the database by design, so a
 * test that drove one would also sync and resolve whatever other tenants
 * happened to be live at that moment — including ones another test file is
 * concurrently asserting against.
 */
export function distinctOwners(
  integrations: readonly IntegrationRecord[]
): string[] {
  return [...new Set(integrations.map((integration) => integration.userId))].sort();
}

/**
 * Mark integrations abandoned mid-authorization as expired.
 *
 * Much narrower than it used to be. An abandoned *connect* no longer leaves a
 * row at all — the configuration is held as a draft and the integration is
 * created only once a credential is proven, so there is nothing here to sweep
 * in the ordinary case.
 *
 * What is left is the rollback window in `createIntegrationFromDraft`: a row is
 * created, then its credential is stored, then it is marked authorized. A crash
 * between the first and last of those, where even the compensating delete did
 * not run, leaves a row in `pending_authorization` with no token. This is what
 * eventually retires it, rather than leaving an integration that can never sync
 * and offers an "Authorize" button whose OAuth state expired long ago.
 */
export async function expirePendingAuthorizations(
  now = Date.now()
): Promise<number> {
  const cutoff = new Date(now - PENDING_AUTHORIZATION_TTL_MINUTES * 60 * 1000);
  const stale = await findStalePendingAuthorizations(cutoff);

  for (const integration of stale) {
    await updateStatus(integration.id, "expired");
  }
  return stale.length;
}
