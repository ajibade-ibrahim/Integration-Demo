/**
 * `addFunctions` is idempotent: re-adding a function is a no-op, not an error.
 *
 * It used to read the existing rows and filter in application code, because
 * SQLite has no `skipDuplicates`. That is correct sequentially and wrong under
 * concurrency: check-then-insert is not atomic, so two callers adding the same
 * function can both see it missing and the second violates
 * `@@unique([integrationId, functionName])` with P2002 — the exact error the
 * filtering existed to prevent, and one nothing in `src/` catches.
 *
 * That window was confirmed directly against Postgres: issue both reads, then
 * both inserts, and the second insert is rejected with P2002. What could not
 * be done is provoke it through this seam. Two `addFunctions` calls started
 * together complete one after the other rather than interleaving their phases,
 * so the concurrent case below passes against the old implementation too, and
 * none of these tests would have caught the bug. They pin the behaviour; the
 * case for `skipDuplicates` rests on the constraint doing the work inside a
 * single statement, which a test at this level cannot observe.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addFunctions,
  createIntegration,
} from "@/core/repositories/integration-repository";
import { prisma } from "@/lib/prisma";

let integrationId: string;

beforeEach(async () => {
  const user = await prisma.user.create({
    data: { email: `add-functions-${randomUUID()}@test.local` },
    select: { id: true },
  });

  const integration = await createIntegration({
    userId: user.id,
    providerName: "metrifox",
    functionNames: ["identity"],
    instanceLabel: "Metrifox — functions",
  });
  integrationId = integration.id;
});

/** Rows as stored, so a duplicate cannot hide behind the record's sorting. */
async function storedFunctions(): Promise<string[]> {
  const rows = await prisma.integrationFunction.findMany({
    where: { integrationId },
    select: { functionName: true },
  });
  return rows.map((row) => row.functionName).sort();
}

describe("addFunctions", () => {
  it("adds a function the integration does not serve yet", async () => {
    const updated = await addFunctions(integrationId, ["support"]);

    expect(updated?.functionNames).toEqual(["identity", "support"]);
    expect(await storedFunctions()).toEqual(["identity", "support"]);
  });

  it("treats re-adding an existing function as a no-op", async () => {
    await addFunctions(integrationId, ["support"]);
    const updated = await addFunctions(integrationId, ["support"]);

    expect(updated?.functionNames).toEqual(["identity", "support"]);
    expect(await storedFunctions()).toEqual(["identity", "support"]);
  });

  it("adds the new ones and ignores the rest in a mixed call", async () => {
    const updated = await addFunctions(integrationId, ["identity", "support"]);

    expect(updated?.functionNames).toEqual(["identity", "support"]);
    expect(await storedFunctions()).toEqual(["identity", "support"]);
  });

  it("ignores duplicates within a single call", async () => {
    await addFunctions(integrationId, ["support", "support"]);

    expect(await storedFunctions()).toEqual(["identity", "support"]);
  });

  it("accepts an empty list without touching anything", async () => {
    const updated = await addFunctions(integrationId, []);

    expect(updated?.functionNames).toEqual(["identity"]);
    expect(await storedFunctions()).toEqual(["identity"]);
  });

  it("does not throw when two callers add the same function at once", async () => {
    // Not a regression test — see the file header. This passes against the
    // old implementation too, because these two calls serialise rather than
    // interleave. Kept as a smoke test on the shape callers actually use.
    const results = await Promise.allSettled([
      addFunctions(integrationId, ["support"]),
      addFunctions(integrationId, ["support"]),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    expect(await storedFunctions()).toEqual(["identity", "support"]);
  });

  /*
   * What the `| undefined` in the return type actually covers, which is less
   * than it looks: only the path where nothing is inserted. Naming a missing
   * integration and asking for a function hits the foreign key first. That is
   * unchanged by the move to `skipDuplicates` — the old implementation failed
   * the same way — and it is fine while every caller holds an integration it
   * has already loaded. It is pinned here so that stops being a surprise if
   * this ever gets wired to a route that takes an id from the URL.
   */
  it("rejects when the integration does not exist", async () => {
    await expect(addFunctions(randomUUID(), ["support"])).rejects.toThrow(
      /[Ff]oreign key/
    );
  });

  it("returns undefined for a missing integration when there is nothing to add", async () => {
    expect(await addFunctions(randomUUID(), [])).toBeUndefined();
  });
});
