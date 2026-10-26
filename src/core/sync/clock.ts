/**
 * Injectable time.
 *
 * Retry backoff and rate-limit waits are policy, not physics. Hardcoding real
 * sleeps makes a failing sync take fifteen minutes to observe and makes the
 * retry logic effectively untestable — the sibling project's schedule (3 tries,
 * 5 minutes apart) could only be verified by waiting. Injecting the clock lets
 * tests assert the schedule instantly and lets dev shorten it.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * A clock that never really waits but records what it was asked to wait for.
 *
 * Asserting on `sleeps` is how the retry and backoff schedules get verified.
 */
export function createFakeClock(startMs = 0): Clock & {
  sleeps: number[];
  advance(ms: number): void;
} {
  let current = startMs;
  const sleeps: number[] = [];

  return {
    sleeps,
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface SyncTiming {
  /** Attempts in total, not retries after the first. */
  maxAttempts: number;
  /** Base delay between attempts; doubles each time. */
  retryDelayMs: number;
  /** Wait after a 429 that carried no Retry-After header. */
  rateLimitFallbackMs: number;
}

export function syncTiming(): SyncTiming {
  return {
    maxAttempts: Math.max(1, envInt("SYNC_MAX_ATTEMPTS", 3)),
    retryDelayMs: envInt("SYNC_RETRY_DELAY_MS", 5 * 60 * 1000),
    rateLimitFallbackMs: envInt("RATE_LIMIT_FALLBACK_MS", 60 * 1000),
  };
}

export interface SyncLeaseTiming {
  /** How long a worker owns a run without renewing it. */
  durationMs: number;
  /** How often a live worker extends its lease. Always less than duration. */
  heartbeatMs: number;
}

export function syncLeaseTiming(): SyncLeaseTiming {
  const durationMs = Math.max(
    10_000,
    envInt("SYNC_LEASE_DURATION_MS", 5 * 60 * 1000)
  );
  const requestedHeartbeat = envInt("SYNC_LEASE_HEARTBEAT_MS", 60 * 1000);

  return {
    durationMs,
    // A heartbeat at or after the expiry would let a healthy worker lose the
    // run it is still using. Two renewals per lease is the minimum useful rate.
    heartbeatMs: Math.max(
      1_000,
      Math.min(requestedHeartbeat, Math.floor(durationMs / 2))
    ),
  };
}
