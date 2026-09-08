import { describe, expect, it } from "vitest";
import { isDue } from "@/core/sync/scheduler";
import type { IntegrationRecord } from "@/core/repositories/integration-repository";
import type { IntegrationStatus } from "@/core/types/common";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function integration(
  overrides: Partial<IntegrationRecord> = {}
): IntegrationRecord {
  return {
    id: "int-1",
    userId: "user-1",
    providerName: "mock",
    functionNames: ["identity"],
    status: "active" as IntegrationStatus,
    instanceLabel: "Test",
    syncIntervalHours: 24,
    authorizationTimestamp: new Date(NOW - 48 * HOUR),
    lastSyncTimestamp: new Date(NOW - 1 * HOUR),
    pendingTokenRevocation: false,
    createdAt: new Date(NOW - 48 * HOUR),
    ...overrides,
  };
}

describe("isDue", () => {
  it("treats a connected but never-synced integration as due immediately", () => {
    // The most likely thing a user is actively waiting on.
    expect(isDue(integration({ lastSyncTimestamp: null }), NOW)).toBe(true);
  });

  it("is due exactly at the interval, not a moment later", () => {
    const at = integration({
      syncIntervalHours: 24,
      lastSyncTimestamp: new Date(NOW - 24 * HOUR),
    });
    expect(isDue(at, NOW)).toBe(true);

    const justBefore = integration({
      syncIntervalHours: 24,
      lastSyncTimestamp: new Date(NOW - 24 * HOUR + 1),
    });
    expect(isDue(justBefore, NOW)).toBe(false);
  });

  it("respects a per-integration interval", () => {
    const hourly = integration({
      syncIntervalHours: 1,
      lastSyncTimestamp: new Date(NOW - 90 * 60 * 1000),
    });
    expect(isDue(hourly, NOW)).toBe(true);

    const weekly = integration({
      syncIntervalHours: 168,
      lastSyncTimestamp: new Date(NOW - 90 * 60 * 1000),
    });
    expect(isDue(weekly, NOW)).toBe(false);
  });

  it.each([
    "pending_authorization",
    "expired",
    "requires_reauthorization",
    "error",
  ] as const)("never schedules a %s integration", (status) => {
    // Scheduling one would produce a failed run every tick and bury the real
    // signal — that it needs a human — under noise.
    expect(
      isDue(integration({ status, lastSyncTimestamp: null }), NOW)
    ).toBe(false);
  });
});
