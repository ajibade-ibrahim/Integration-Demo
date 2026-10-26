/**
 * Durable sync ownership.
 *
 * The in-process lock is easy to test by calling `executeSync` twice. The
 * interesting case is a second instance: it has its own Set, so the lease row
 * is the only thing that can stop it. These tests exercise the lease directly
 * and then hold a real sync open while a second worker takes it over.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { prisma } from "@/lib/prisma";
import { bootstrap } from "@/core/bootstrap";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { NON_EXPIRING_AT, saveToken } from "@/core/repositories/token-repository";
import { createFakeClock, syncLeaseTiming } from "@/core/sync/clock";
import {
  acquireSyncLease,
  closeSyncRun,
  recoverExpiredSyncRuns,
  renewSyncLease,
  verifySyncLease,
  type SyncLease,
} from "@/core/sync/lease";
import { executeSync } from "@/core/sync/sync-engine";

const USER_ID = "user-sync-lease";
const INTEGRATION_ID = "integration-sync-lease";
const CUSTOMERS = "https://api.stripe.com/v1/customers";
const NOW = 1_700_000_000_000;

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "sync-lease@example.test" },
    update: {},
  });
});

afterEach(() => server.resetHandlers());

afterAll(async () => {
  server.close();
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });
});

async function connect(): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Lease test",
      functions: { create: [{ functionName: "identity" }] },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "sk_test_fake",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });

  await saveMappings(
    INTEGRATION_ID,
    "identity",
    defaultMappingsFor("identity", "stripe")
  );
}

function customerListing() {
  return HttpResponse.json({
    object: "list",
    has_more: false,
    data: [
      {
        id: "cus_lease",
        object: "customer",
        name: "Lease Customer",
        email: "lease@example.test",
        created: 1_680_893_993,
        metadata: {},
      },
    ],
  });
}

function closeData(
  clock: ReturnType<typeof createFakeClock>,
  status: "success" | "failed"
) {
  return {
    status,
    completedAt: new Date(clock.now()),
    recordCountsJson: "{}",
    errorsJson: "[]",
    coverageJson: JSON.stringify({ functions: [] }),
    attempt: 1,
    markLastSync: false,
  };
}

async function closeLease(
  lease: SyncLease,
  clock: ReturnType<typeof createFakeClock>
): Promise<void> {
  await closeSyncRun(lease, clock, closeData(clock, "failed"));
}

describe("sync leases", () => {
  it("discards a second request in the same process before it starts", async () => {
    let releaseResponse: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    server.use(
      http.get(CUSTOMERS, async () => {
        markStarted?.();
        await responseGate;
        return customerListing();
      })
    );
    await connect();

    const clock = createFakeClock(NOW);
    const first = executeSync(INTEGRATION_ID, { clock });
    await started;

    const second = await executeSync(INTEGRATION_ID, { clock });
    expect(second.status).toBe("discarded");
    // The fast path deliberately creates no run row for the loser.
    expect(second.syncRunId).toBeNull();
    expect(
      await prisma.syncRun.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);

    releaseResponse?.();
    const result = await first;
    expect(result.status).toBe("success");
    expect(result.recordCounts).toEqual({ customer: 1, contact: 1 });

    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: INTEGRATION_ID },
    });
    expect(integration.lastSyncTimestamp?.getTime()).toBe(NOW);
  });

  it("lets only one database worker claim an integration", async () => {
    await connect();
    const clock = createFakeClock(NOW);
    const timing = syncLeaseTiming();

    const first = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "manual",
      clock,
      timing,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected the first claim to win");

    const second = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "scheduled",
      clock,
      timing,
    });
    expect(second.acquired).toBe(false);
    expect(second.activeRunId).toBe(first.lease.runId);

    await closeLease(first.lease, clock);
  });

  it("abandons an expired run, fences the old owner, and gives the new one a fresh token", async () => {
    await connect();
    const clock = createFakeClock(NOW);
    const timing = syncLeaseTiming();

    const first = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "manual",
      clock,
      timing,
    });
    if (!first.acquired) throw new Error("expected the first claim to win");

    await prisma.syncRun.update({
      where: { id: first.lease.runId },
      data: { leaseExpiresAt: new Date(NOW - 1) },
    });

    const second = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "scheduled",
      clock,
      timing,
    });
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error("expected the takeover to win");

    expect(second.lease.fencingToken).toBe(first.lease.fencingToken + 1);

    const abandoned = await prisma.syncRun.findUniqueOrThrow({
      where: { id: first.lease.runId },
    });
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.completedAt).not.toBeNull();
    expect(abandoned.coverageJson).toMatch(/lease expired/i);

    // The old worker's clock and token still look plausible; the row does not.
    expect(await verifySyncLease(first.lease, clock)).toBe(false);
    expect(
      await closeSyncRun(first.lease, clock, {
        ...closeData(clock, "success"),
        markLastSync: true,
      })
    ).toBe(false);
    expect(
      await renewSyncLease(first.lease, clock, timing)
    ).toBe(false);

    const stillCurrent = await prisma.syncRun.findUniqueOrThrow({
      where: { id: second.lease.runId },
    });
    expect(stillCurrent.status).toBe("running");
    expect(stillCurrent.leaseOwner).toBe(second.lease.ownerId);

    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: INTEGRATION_ID },
    });
    expect(integration.lastSyncTimestamp).toBeNull();

    await closeLease(second.lease, clock);
  });

  it("renews a live lease and records the heartbeat", async () => {
    await connect();
    const clock = createFakeClock(NOW);
    const timing = syncLeaseTiming();

    const claim = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "manual",
      clock,
      timing,
    });
    if (!claim.acquired) throw new Error("expected the claim to win");

    clock.advance(1_000);
    expect(await renewSyncLease(claim.lease, clock, timing)).toBe(true);
    expect(claim.lease.expiresAt).toBe(
      NOW + 1_000 + timing.durationMs
    );

    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: claim.lease.runId },
    });
    expect(run.heartbeatAt?.getTime()).toBe(NOW + 1_000);
    expect(run.leaseExpiresAt?.getTime()).toBe(
      NOW + 1_000 + timing.durationMs
    );

    await closeLease(claim.lease, clock);
  });

  it("sweeps expired running runs even when the integration is not due", async () => {
    await connect();
    const clock = createFakeClock(NOW);

    const claim = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "manual",
      clock,
      timing: syncLeaseTiming(),
    });
    if (!claim.acquired) throw new Error("expected the claim to win");

    await prisma.syncRun.update({
      where: { id: claim.lease.runId },
      data: { leaseExpiresAt: new Date(NOW - 1) },
    });

    const recovered = await recoverExpiredSyncRuns(clock.now());
    expect(recovered).toBeGreaterThanOrEqual(1);

    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: claim.lease.runId },
    });
    expect(run.status).toBe("abandoned");
    expect(run.leaseExpiresAt).toBeNull();
  });

  it("commits a re-authorization flag with the fenced close", async () => {
    server.use(
      http.get(CUSTOMERS, () =>
        HttpResponse.json({ error: { message: "revoked" } }, { status: 401 })
      )
    );
    await connect();

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(NOW),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/rejected the credentials|401/i);

    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: INTEGRATION_ID },
    });
    expect(integration.status).toBe("requires_reauthorization");

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(run.status).toBe("failed");
    expect(run.leaseExpiresAt).toBeNull();
  });

  it("stops a paused owner before it writes after another worker takes over", async () => {
    let releaseResponse: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    server.use(
      http.get(CUSTOMERS, async () => {
        markStarted?.();
        await responseGate;
        return customerListing();
      })
    );
    await connect();

    const clock = createFakeClock(NOW);
    const first = executeSync(INTEGRATION_ID, { clock });
    await started;

    const firstRun = await prisma.syncRun.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, status: "running" },
    });
    await prisma.syncRun.update({
      where: { id: firstRun.id },
      data: { leaseExpiresAt: new Date(NOW - 1) },
    });

    const takeover = await acquireSyncLease({
      integrationId: INTEGRATION_ID,
      trigger: "scheduled",
      clock,
      timing: syncLeaseTiming(),
    });
    if (!takeover.acquired) throw new Error("expected the takeover to win");

    releaseResponse?.();
    const result = await first;

    expect(result.status).toBe("discarded");
    expect(result.error).toMatch(/lease/i);
    expect(
      await prisma.customer.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);

    const abandoned = await prisma.syncRun.findUniqueOrThrow({
      where: { id: firstRun.id },
    });
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.recordCountsJson).toBe("{}");

    await closeLease(takeover.lease, clock);
  });
});
