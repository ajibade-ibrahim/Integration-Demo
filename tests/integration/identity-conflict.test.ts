/**
 * Two accounts claiming one key.
 *
 * The pass never merges them. A false merge has no user-facing undo — the two
 * companies' fields are already composed into one golden record by the time
 * anyone notices — whereas an unmade merge is one `same` assertion away. So the
 * customer is given a home deterministically, every losing account keeps its
 * claim and its members, and the contest is reported for a human.
 *
 * What is asserted here is mostly the *stability* of that outcome: the same
 * winner every pass, the same issue every pass, and no drift in the partition.
 * A conflict a user has not resolved yet must look the same tomorrow, or the
 * banner in the Accounts view becomes noise.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("a customer whose keys match two accounts", () => {
  /**
   * Account A holds an email; account B holds a domain; then a third record
   * arrives carrying both.
   */
  async function contended() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
      { provider: "metrifox", identityPriority: 30 },
    ]);

    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });
    await tenant.customer("mock", "c-1", { domain: "acme.example" });

    // Two accounts, with nothing in common yet.
    await resolveIdentities(tenant.userId, "manual");

    await tenant.customer("metrifox", "m-1", {
      email: "billing@acme.example",
      domain: "acme.example",
    });

    return tenant;
  }

  it("joins the account matched by the stronger key kind", async () => {
    const tenant = await contended();
    await resolveIdentities(tenant.userId, "manual");

    const placements = await tenant.placements();
    // Email beats domain: an address identifies a billing relationship, while a
    // shared domain can be three subsidiaries of one parent.
    expect(placements.get("m-1")).toBe(placements.get("cus_1"));
    expect(placements.get("m-1")).not.toBe(placements.get("c-1"));
  });

  it("leaves the losing account with its member and its key", async () => {
    const tenant = await contended();
    const before = await tenant.placements();

    await resolveIdentities(tenant.userId, "manual");

    const after = await tenant.placements();
    expect(after.get("c-1")).toBe(before.get("c-1"));
    // The losing claim stays put. Re-pointing it would be the merge the pass
    // has just declined to make, arrived at one key at a time.
    expect(await tenant.keyValues()).toContain("domain:acme.example");
  });

  it("reports the contested key, naming winner and loser", async () => {
    const tenant = await contended();
    const outcome = await resolveIdentities(tenant.userId, "manual");
    const placements = await tenant.placements();

    expect(outcome.status).toBe("partial");
    expect(outcome.issues).toHaveLength(1);

    const issue = outcome.issues[0];
    if (issue?.kind !== "key_claimed_elsewhere") {
      throw new Error(`expected a key conflict, got ${issue?.kind}`);
    }
    expect(issue.keyKind).toBe("domain");
    expect(issue.keyValue).toBe("acme.example");
    expect(issue.winningAccountId).toBe(placements.get("cus_1"));
    expect(issue.losingAccountIds).toEqual([placements.get("c-1")]);
  });

  it("reports it again, identically, on every later pass", async () => {
    const tenant = await contended();
    await resolveIdentities(tenant.userId, "manual");
    const settled = await tenant.placements();

    const third = await resolveIdentities(tenant.userId, "manual");

    // Unresolved means unresolved: the conflict recurs until a human acts, and
    // nothing about the grouping drifts in the meantime.
    expect(third.issues.map((issue) => issue.kind)).toEqual([
      "key_claimed_elsewhere",
    ]);
    expect(await tenant.placements()).toEqual(settled);
    expect(third.counts.accountsCreated).toBe(0);
    expect(third.counts.accountsAbsorbed).toBe(0);
  });
});

describe("two accounts matched by keys of the same kind", () => {
  it("gives the customer to the older account", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
    ]);

    // Resolved in separate passes so the two accounts have distinct ages. The
    // rule is oldest-first, and two accounts created inside one pass could land
    // in the same millisecond, which would make this assert the id tiebreak
    // instead of the one it is about.
    await tenant.customer("stripe", "cus_old", { email: "ap@acme.example" });
    await resolveIdentities(tenant.userId, "manual");

    await tenant.customer("stripe", "cus_new", { email: "ar@acme.example" });
    await resolveIdentities(tenant.userId, "manual");

    // Carries both addresses — its own, and one on a contact — so both matches
    // are `email` and the strength step cannot decide between them.
    const contender = await tenant.customer("mock", "c-1", {
      email: "ap@acme.example",
    });
    await tenant.contact("mock", "c-1-contact", {
      email: "ar@acme.example",
      customerId: contender,
    });

    const outcome = await resolveIdentities(tenant.userId, "manual");
    const placements = await tenant.placements();

    expect(placements.get("c-1")).toBe(placements.get("cus_old"));
    expect(outcome.issues.map((issue) => issue.kind)).toEqual([
      "key_claimed_elsewhere",
    ]);
  });
});
