/**
 * A run records the mapping rules it actually used.
 *
 * The mapping editor replaces a function's rules in place, so "the current
 * mapping" cannot explain a run from yesterday. This checks the version is
 * written before the run and survives a later edit.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { prisma } from "@/lib/prisma";
import { bootstrap } from "@/core/bootstrap";
import { mappingVersionFor } from "@/core/field-mapper/mapping-version";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { readJsonObject } from "@/core/repositories/json-column";
import { listRecentRuns } from "@/core/repositories/sync-run-repository";
import {
  NON_EXPIRING_AT,
  saveToken,
} from "@/core/repositories/token-repository";
import { createFakeClock } from "@/core/sync/clock";
import { executeSync } from "@/core/sync/sync-engine";

const USER_ID = "user-sync-mapping-version";
const INTEGRATION_ID = "integration-sync-mapping-version";
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  bootstrap();

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "sync-mapping-version@example.test" },
    update: {},
  });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });

  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "mock",
      status: "active",
      instanceLabel: "Mapping version test",
      functions: { create: [{ functionName: "identity" }] },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "mock-test-token",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });
});

async function sync(clockMs: number) {
  return executeSync(INTEGRATION_ID, {
    clock: createFakeClock(clockMs),
  });
}

describe("sync run mapping versions", () => {
  it("records the version used and keeps it after the rules change", async () => {
    const firstRules = defaultMappingsFor("identity", "mock");
    await saveMappings(INTEGRATION_ID, "identity", firstRules);
    const firstVersion = mappingVersionFor(firstRules);

    const first = await sync(NOW);
    // The mock fixtures include deliberate per-record rejects, so a completed
    // run can be partial; what matters here is that it reached the writer.
    expect(first.status).toBe("partial");
    expect(first.syncRunId).not.toBeNull();

    const firstRun = await prisma.syncRun.findUniqueOrThrow({
      where: { id: first.syncRunId ?? "" },
    });
    expect(readJsonObject(firstRun.mappingVersionsJson)).toEqual({
      identity: firstVersion,
    });

    const secondRules = firstRules.filter(
      (rule) => rule.targetFieldPath !== "industry"
    );
    await saveMappings(INTEGRATION_ID, "identity", secondRules);
    const secondVersion = mappingVersionFor(secondRules);
    expect(secondVersion).not.toBe(firstVersion);

    const second = await sync(NOW + 60_000);
    expect(second.status).toBe("partial");

    const [latest, previous] = await listRecentRuns(INTEGRATION_ID);
    expect(latest?.mappingVersions).toEqual({ identity: secondVersion });
    expect(previous?.mappingVersions).toEqual({ identity: firstVersion });
  });

  it("records the empty rule set when a function has no mappings", async () => {
    // No rules means the function fails before any provider request. The run
    // still records the version it read, which is the hash of no rules — an
    // honest answer, not a version guessed from another function's config.
    const result = await sync(NOW);

    expect(result.status).toBe("failed");
    const run = await prisma.syncRun.findUniqueOrThrow({
      where: { id: result.syncRunId ?? "" },
    });
    expect(readJsonObject(run.mappingVersionsJson)).toEqual({
      identity: mappingVersionFor([]),
    });
  });
});
