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
