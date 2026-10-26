/**
 * Durable ownership for one sync run.
 *
 * The in-process Set in `sync-engine.ts` is a fast path: it stops two requests
 * in one process before either touches the provider. It cannot stop a second
 * instance, so the database row is the authority. A run is claimed in a
 * transaction that takes an advisory lock for the integration, checks whether
 * a live lease still exists, abandons expired `running` rows, and inserts the
 * new run with a monotonically increasing fencing token.
 *
 * A worker keeps the lease alive with a heartbeat. Each page, function, write
 * phase and reconciliation checks the lease first, and closing a run is a
 * conditional transaction that re-checks owner, token and expiry under the same
 * advisory lock. A paused worker that wakes after another worker has taken over
 * can therefore neither close the old run nor update the integration's sync
 * time or connection status.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { IntegrationStatus, SyncRunStatus } from "../types/common";
import type { Clock, SyncLeaseTiming } from "./clock";
import { coverageWithError } from "./coverage";
import { SyncLeaseLostError } from "./errors";

const ABANDONED_REASON =
  "Sync run was abandoned because its lease expired before completion.";

const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

export interface SyncLease {
  integrationId: string;
  runId: string;
  ownerId: string;
  fencingToken: number;
  /** Wall-clock expiry, updated locally by a successful heartbeat. */
  expiresAt: number;
}

export type SyncLeaseAcquisition =
  | { acquired: true; lease: SyncLease; activeRunId: null }
  | { acquired: false; lease: null; activeRunId: string | null };

interface AcquireSyncLeaseArgs {
  integrationId: string;
  trigger: "manual" | "scheduled";
  clock: Clock;
  timing: SyncLeaseTiming;
}

/**
 * Claim the integration's sync lease and create the run that owns it.
 *
 * Returns `acquired: false` when a live lease exists. The caller must not
 * create a run in that case; `activeRunId` identifies the run to report.
 */
export async function acquireSyncLease({
  integrationId,
  trigger,
  clock,
  timing,
}: AcquireSyncLeaseArgs): Promise<SyncLeaseAcquisition> {
  const nowMs = clock.now();
  const now = new Date(nowMs);
  const ownerId = randomUUID();

  return prisma.$transaction(async (tx) => {
    await lockIntegration(tx, integrationId);

    const running = await tx.syncRun.findMany({
      where: { integrationId, status: "running" },
      select: { id: true, leaseExpiresAt: true, coverageJson: true },
    });

    const active = running.find(
      (run) =>
        run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() > nowMs
    );

    for (const run of running) {
      if (run.id === active?.id) continue;

      if (!(await abandonRun(tx, run, now))) {
        // A heartbeat may have renewed this row between the read and the
        // conditional abandon. If it is live now, it owns the integration.
        const current = await tx.syncRun.findUnique({
          where: { id: run.id },
          select: { status: true, leaseExpiresAt: true },
        });
        if (
          current?.status === "running" &&
          current.leaseExpiresAt !== null &&
          current.leaseExpiresAt.getTime() > nowMs
        ) {
          return { acquired: false, lease: null, activeRunId: run.id };
        }
      }
    }

    if (active !== undefined) {
      return { acquired: false, lease: null, activeRunId: active.id };
    }

    // The token is per integration, not global, so a stale owner can be
    // rejected with a single row comparison. MAX also includes abandoned runs,
    // which is why a taken-over token never repeats.
    const highest = await tx.syncRun.aggregate({
      where: { integrationId },
      _max: { fencingToken: true },
    });
    const fencingToken = (highest._max.fencingToken ?? 0) + 1;
    const expiresAt = new Date(nowMs + timing.durationMs);

    const run = await tx.syncRun.create({
      data: {
        integrationId,
        status: "running",
        trigger,
        leaseOwner: ownerId,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        fencingToken,
      },
      select: { id: true },
    });

    return {
      acquired: true,
      activeRunId: null,
      lease: {
        integrationId,
        runId: run.id,
        ownerId,
        fencingToken,
        expiresAt: expiresAt.getTime(),
      },
    };
  }, TRANSACTION_OPTIONS);
}

/**
 * Extend a live lease. Returns false if the run is no longer ours or the lease
 * had already expired, which is the signal to stop the run.
 */
export async function renewSyncLease(
  lease: SyncLease,
  clock: Clock,
  timing: SyncLeaseTiming
): Promise<boolean> {
  const nowMs = clock.now();
  if (nowMs >= lease.expiresAt) return false;

  const now = new Date(nowMs);
  const expiresAt = new Date(nowMs + timing.durationMs);

  const { count } = await prisma.syncRun.updateMany({
    where: {
      id: lease.runId,
      status: "running",
      leaseOwner: lease.ownerId,
      fencingToken: lease.fencingToken,
      leaseExpiresAt: { gt: now },
    },
    data: { heartbeatAt: now, leaseExpiresAt: expiresAt },
  });

  if (count === 0) return false;

  lease.expiresAt = expiresAt.getTime();
  return true;
}

/**
 * Confirm the row still belongs to this worker.
 *
 * The local expiry check is what makes the common path cheap; the database
 * read is what catches a takeover that happened after the last heartbeat.
 */
export async function verifySyncLease(
  lease: SyncLease,
  clock: Clock
): Promise<boolean> {
  const nowMs = clock.now();
  if (nowMs >= lease.expiresAt) return false;

  const run = await prisma.syncRun.findUnique({
    where: { id: lease.runId },
    select: {
      status: true,
      leaseOwner: true,
      fencingToken: true,
      leaseExpiresAt: true,
    },
  });

  if (
    run === null ||
    run.status !== "running" ||
    run.leaseOwner !== lease.ownerId ||
    run.fencingToken !== lease.fencingToken ||
    run.leaseExpiresAt === null ||
    run.leaseExpiresAt.getTime() <= nowMs
  ) {
    return false;
  }

  lease.expiresAt = run.leaseExpiresAt.getTime();
  return true;
}

export interface CloseSyncRunData {
  status: Extract<SyncRunStatus, "success" | "partial" | "failed">;
  completedAt: Date;
  recordCountsJson: string;
  errorsJson: string;
  coverageJson: string;
  attempt: number;
  /** Only a run that wrote rows advances the integration's sync timestamp. */
  markLastSync: boolean;
  /**
   * A connection-state change caused by this run, committed with the run so a
   * stale worker cannot flip the integration after losing its lease.
   */
  integrationStatus?: IntegrationStatus;
}

/**
 * Close the run only if its lease is still ours.
 *
 * The advisory lock is shared with acquisition, so a new worker cannot claim
 * the integration between the ownership check and the update. Returns false
 * when the caller lost the lease; it must not retry the close or touch the
 * integration.
 */
export async function closeSyncRun(
  lease: SyncLease,
  clock: Clock,
  data: CloseSyncRunData
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockIntegration(tx, lease.integrationId);

    const now = clock.now();
    const run = await tx.syncRun.findUnique({
      where: { id: lease.runId },
      select: {
        status: true,
        leaseOwner: true,
        fencingToken: true,
        leaseExpiresAt: true,
      },
    });

    if (
      run === null ||
      run.status !== "running" ||
      run.leaseOwner !== lease.ownerId ||
      run.fencingToken !== lease.fencingToken ||
      run.leaseExpiresAt === null ||
      run.leaseExpiresAt.getTime() <= now
    ) {
      return false;
    }

    await tx.syncRun.update({
      where: { id: lease.runId },
      data: {
        status: data.status,
        completedAt: data.completedAt,
        recordCountsJson: data.recordCountsJson,
        errorsJson: data.errorsJson,
        coverageJson: data.coverageJson,
        attempt: data.attempt,
        leaseExpiresAt: null,
      },
    });

    if (data.markLastSync) {
      await tx.integration.update({
        where: { id: lease.integrationId },
        data: { lastSyncTimestamp: data.completedAt },
      });
    }

    if (data.integrationStatus !== undefined) {
      await tx.integration.update({
        where: { id: lease.integrationId },
        data: { status: data.integrationStatus },
      });
    }

    return true;
  }, TRANSACTION_OPTIONS);
}

/**
 * Mark every run whose lease has lapsed as abandoned.
 *
 * Called by the scheduler tick so a crash is visible even if the integration
 * is not due again for hours. Acquisition also performs the same recovery for
 * its own integration; this is the sweep for everything else.
 */
export async function recoverExpiredSyncRuns(
  nowMs: number = Date.now()
): Promise<number> {
  const now = new Date(nowMs);
  const expired = await prisma.syncRun.findMany({
    where: {
      status: "running",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    select: { id: true, coverageJson: true },
  });

  let recovered = 0;
  for (const run of expired) {
    const { count } = await prisma.syncRun.updateMany({
      where: {
        id: run.id,
        status: "running",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: "abandoned",
        completedAt: now,
        leaseExpiresAt: null,
        coverageJson: coverageWithError(run.coverageJson, ABANDONED_REASON),
      },
    });
    recovered += count;
  }

  return recovered;
}

export interface SyncLeaseHeartbeat {
  stop(): void;
  /** True once a renewal failed; the next guard check will stop the run. */
  lost(): boolean;
}

/**
 * Keep a live lease from expiring while a long fetch or backoff is running.
 *
 * The timer is real wall time, while `clock.now()` may be injected for tests;
 * the two agree in production. `unref` keeps a forgotten heartbeat from holding
 * a short-lived script open.
 */
export function startSyncLeaseHeartbeat(
  lease: SyncLease,
  clock: Clock,
  timing: SyncLeaseTiming
): SyncLeaseHeartbeat {
  let stopped = false;
  let lost = false;
  let renewing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || renewing) return;
    renewing = true;

    try {
      const renewed = await renewSyncLease(lease, clock, timing);
      if (!renewed) {
        lost = true;
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
      }
    } catch {
      // A transient database failure is not proof that the lease was lost, but
      // continuing to write without a renewed lease would be. Treat it as lost
      // and let the run's next guard check stop it.
      lost = true;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    } finally {
      renewing = false;
    }
  };

  timer = setInterval(() => void tick(), timing.heartbeatMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    lost() {
      return lost;
    },
  };
}

/** Throw if this worker is not allowed to continue. */
export function assertLeaseHeld(
  lease: SyncLease,
  heartbeat: SyncLeaseHeartbeat,
  clock: Clock
): void {
  if (heartbeat.lost() || clock.now() >= lease.expiresAt) {
    throw new SyncLeaseLostError();
  }
}

/** Check the in-memory lease and then the database row. */
export async function verifyLeaseHeld(
  lease: SyncLease,
  heartbeat: SyncLeaseHeartbeat,
  clock: Clock
): Promise<void> {
  assertLeaseHeld(lease, heartbeat, clock);
  if (!(await verifySyncLease(lease, clock))) {
    throw new SyncLeaseLostError();
  }
}

async function lockIntegration(
  tx: Prisma.TransactionClient,
  integrationId: string
): Promise<void> {
  // xact-scoped: released on commit, rollback or connection loss. Every claim
  // and close that changes ownership takes the same lock. The recovery sweep
  // uses a conditional update instead, so it cannot revive or steal a lease that
  // a heartbeat renewed between the read and the write. A hash collision can
  // only serialize two unrelated integrations, never allow two owners for one.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sync:${integrationId}`}))`;
}

async function abandonRun(
  tx: Prisma.TransactionClient,
  run: { id: string; coverageJson: string },
  now: Date
): Promise<boolean> {
  const { count } = await tx.syncRun.updateMany({
    where: {
      id: run.id,
      status: "running",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      status: "abandoned",
      completedAt: now,
      leaseExpiresAt: null,
      coverageJson: coverageWithError(run.coverageJson, ABANDONED_REASON),
    },
  });
  return count === 1;
}
