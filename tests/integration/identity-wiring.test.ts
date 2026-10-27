/**
 * How resolution gets called: the guard, the swallow, and once per user.
 *
 * The pass itself is tested elsewhere. What is easy to get wrong is the wiring
 * around it, and each failure here is quiet:
 *
 * - a sync reported as failed because the grouping afterwards hiccuped, sending
 *   the user to re-run a sync that had nothing wrong with it;
 * - two of one user's integrations finishing together and running the same
 *   whole-tenant pass twice, racing each other over the same keys.
 *
 * The third failure — a tick that syncs three of one user's connections and
 * resolves three times, the first two against a half-synced tenant — is pinned
 * in `tests/unit/scheduler.test.ts` instead. Driving a whole tick from here
 * would sweep every integration in the shared test schema, including tenants
 * another test file is asserting against at that moment.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { resolveAfterSync } from "@/core/identity/resolve-after-sync";
import { listResolutionRuns } from "@/core/repositories/identity-repository";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("the per-user concurrency guard", () => {
  it("discards the second of two overlapping passes", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    const [first, second] = await Promise.all([
      resolveIdentities(tenant.userId, "manual"),
      resolveIdentities(tenant.userId, "manual"),
    ]);

    // Told, rather than left believing it did the work. Not queued either: the
    // pass it would wait for reads exactly the rows it would have read.
    expect([first.status, second.status].sort()).toEqual([
      "discarded",
      "success",
    ]);

    const discarded = first.status === "discarded" ? first : second;
    expect(discarded.runId).toBeNull();
    expect(discarded.counts.accountsCreated).toBe(0);
    expect(discarded.issues).toEqual([]);
  });

  it("queues a deletion pass when the caller must observe removed rows", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    const first = resolveIdentities(tenant.userId, "manual");
    const second = resolveIdentities(tenant.userId, "deletion", {
      waitForInFlight: true,
    });
    const [running, queued] = await Promise.all([first, second]);

    // Ordinary overlap is discarded; a deletion cannot be, because the pass it
    // would wait on may have loaded records that the deletion then removed.
    expect([running.status, queued.status]).toEqual(["success", "success"]);
    const runs = await listResolutionRuns(tenant.userId);
    expect(runs.map((run) => run.trigger).sort()).toEqual([
      "deletion",
      "manual",
    ]);
  });

  it("writes no run row for the discarded caller", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    await Promise.all([
      resolveIdentities(tenant.userId, "manual"),
      resolveIdentities(tenant.userId, "manual"),
    ]);

    // A discard is contention, not an execution. One row per overlapping caller
    // would fill the user's history with records of nothing having happened.
    expect(await listResolutionRuns(tenant.userId)).toHaveLength(1);
  });

  it("holds one user's pass without blocking another's", async () => {
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    await mine.customer("stripe", "cus_1", { email: "billing@acme.example" });
    const theirs = await makeIdentityTenant([{ provider: "stripe" }]);
    await theirs.customer("stripe", "cus_2", { email: "ap@northwind.example" });

    const [a, b] = await Promise.all([
      resolveIdentities(mine.userId, "manual"),
      resolveIdentities(theirs.userId, "manual"),
    ]);

    // Keyed by user, so two tenants resolving at once is not contention.
    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
  });

  it("releases, so a later pass runs normally", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    await Promise.all([
      resolveIdentities(tenant.userId, "manual"),
      resolveIdentities(tenant.userId, "manual"),
    ]);
    const after = await resolveIdentities(tenant.userId, "manual");

    // The guard is released in a `finally`. Without that a single throw would
    // wedge this user's resolution until the process restarted.
    expect(after.status).toBe("success");
  });
});

describe("resolveAfterSync", () => {
  it("returns undefined instead of throwing", async () => {
    // A user id that cannot exist, so opening the run row fails on its foreign
    // key. Stands in for any failure inside the pass: the point is that the
    // sync which called this is not affected by it.
    const outcome = await resolveAfterSync(`missing-${randomUUID()}`, "sync");

    expect(outcome).toBeUndefined();
  });

  it("returns the outcome when the pass succeeds", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    const outcome = await resolveAfterSync(tenant.userId, "sync");

    expect(outcome?.status).toBe("success");
    expect(outcome?.counts.accountsCreated).toBe(1);
  });
});

describe("what a sync leaves behind", () => {
  it("links every customer the sync wrote", async () => {
    // The outcome both sync call sites exist for: after the sync, nothing is
    // left with a null `customerAccountId`, so everything downstream can hang
    // off it without a null check.
    const tenant = await makeIdentityTenant([
      { provider: "stripe", key: "s1" },
      { provider: "mock", key: "m1" },
    ]);
    await tenant.customer("s1", "cus_1", { email: "billing@acme.example" });
    await tenant.customer("m1", "c-1", { email: "billing@acme.example" });

    await resolveAfterSync(tenant.userId, "scheduled");

    expect(
      await prisma.customer.count({
        where: {
          integration: { userId: tenant.userId },
          customerAccountId: null,
        },
      })
    ).toBe(0);
    expect(await tenant.groups()).toEqual([["c-1", "cus_1"]]);
  });
});
