import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock, syncTiming } from "@/core/sync/clock";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("fake clock", () => {
  it("records sleeps without waiting and advances time", async () => {
    const clock = createFakeClock(1000);
    await clock.sleep(5000);
    await clock.sleep(250);

    expect(clock.sleeps).toEqual([5000, 250]);
    expect(clock.now()).toBe(6250);
  });
});

describe("syncTiming", () => {
  it("falls back to production-shaped defaults", () => {
    delete process.env["SYNC_MAX_ATTEMPTS"];
    delete process.env["SYNC_RETRY_DELAY_MS"];
    delete process.env["RATE_LIMIT_FALLBACK_MS"];

    expect(syncTiming()).toEqual({
      maxAttempts: 3,
      retryDelayMs: 300_000,
      rateLimitFallbackMs: 60_000,
    });
  });

  it("reads overrides from the environment", () => {
    process.env["SYNC_MAX_ATTEMPTS"] = "5";
    process.env["SYNC_RETRY_DELAY_MS"] = "10";
    process.env["RATE_LIMIT_FALLBACK_MS"] = "20";

    expect(syncTiming()).toEqual({
      maxAttempts: 5,
      retryDelayMs: 10,
      rateLimitFallbackMs: 20,
    });
  });

  it.each([
    ["nonsense", "abc"],
    ["negative", "-5"],
  ])("ignores a %s delay and uses the default", (_label, value) => {
    process.env["SYNC_RETRY_DELAY_MS"] = value;
    expect(syncTiming().retryDelayMs).toBe(300_000);
  });

  it("never allows fewer than one attempt", () => {
    process.env["SYNC_MAX_ATTEMPTS"] = "0";
    expect(syncTiming().maxAttempts).toBe(1);
  });
});
