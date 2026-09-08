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
import { executeSync } from "./sync-engine";
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
  customerCount: number;
  contactCount: number;
  error?: string;
}

export interface SchedulerResult {
  checked: number;
  due: number;
  runs: ScheduledRun[];
  expired: number;
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

  const expired = await expirePendingAuthorizations(now);

  const all = await listAllIntegrations();
  const due = all.filter((integration) => isDue(integration, now));
  const selected =
    options.maxIntegrations === undefined
      ? due
      : due.slice(0, options.maxIntegrations);

  const runs: ScheduledRun[] = [];

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
      customerCount: result.customerCount,
      contactCount: result.contactCount,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  }

  return { checked: all.length, due: due.length, runs, expired };
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
