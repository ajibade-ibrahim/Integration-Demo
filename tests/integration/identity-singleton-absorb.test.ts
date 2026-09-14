/**
 * Moving a record that has already been placed.
 *
 * This is the file for the defect that would have made the whole feature
 * useless, and it is worth stating plainly because the property tests could not
 * see it. Every customer contributes an `external_ref` self-key, `external_ref`
 * is the strongest kind, and so a record's *own* account outranked the account
 * its newly-arrived email actually matched. Once placed, nothing could ever
 * move again: the genuine match came back as a key conflict, forever. A first
 * pass over generated data never exercises it, because nothing has an account
 * yet on a first pass.
 *
 * The underlying rule is that a self-key is a tautology — it says this record
 * is itself. It is evidence for *other* records naming that id, never for where
 * this one belongs.
 *
 * Absorbing the emptied singleton is the other half. Without it, whichever
 * integration synced first would permanently decide the grouping.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { upsertAssertion } from "@/core/repositories/identity-repository";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

/**
 * Stripe knows the address; Metrifox does not, yet.
 *
 * The staged arrival that any real deployment starts with — one integration is
 * connected and synced days before the next.
 */
async function stagedArrival() {
  const tenant = await makeIdentityTenant([
    { provider: "stripe", identityPriority: 10 },
    { provider: "metrifox", identityPriority: 20, metadata: { accountId: "acct-9" } },
  ]);

  await tenant.customer("stripe", "cus_1", {
    name: "Acme Corp",
    email: "billing@acme.example",
  });
  const later = await tenant.customer("metrifox", "m-1", { name: "Acme" });

  const first = await resolveIdentities(tenant.userId, "manual");
  return { tenant, later, first };
}

describe("a record that gains a key after it was placed", () => {
  it("starts apart, because there is nothing to join on yet", async () => {
    const { tenant, first } = await stagedArrival();

    expect(first.counts.accountsCreated).toBe(2);
    expect(await tenant.groups()).toEqual([["cus_1"], ["m-1"]]);
  });

  it("moves, and its empty account is absorbed", async () => {
    const { tenant, later } = await stagedArrival();
    const before = await tenant.placements();

    // The next Metrifox sync fills in the address it was missing.
    await tenant.updateCustomer(later, { email: "billing@acme.example" });
    const second = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["cus_1", "m-1"]]);
    expect(second.counts.accountsAbsorbed).toBe(1);

    // It joined the existing account rather than the reverse: the account the
    // user has been looking at keeps its id, and every row pointing at it.
    const after = await tenant.placements();
    expect(after.get("m-1")).toBe(before.get("cus_1"));

    // The merge is a merge, not a conflict report. A `key_claimed_elsewhere`
    // here would mean the pass had refused the join it exists to make.
    expect(second.issues.map((issue) => issue.kind)).not.toContain(
      "key_claimed_elsewhere"
    );
  });

  it("carries the absorbed account's keys onto the survivor", async () => {
    const { tenant, later } = await stagedArrival();
    await tenant.updateCustomer(later, { email: "billing@acme.example" });
    await resolveIdentities(tenant.userId, "manual");

    // Both self-keys, on one account. The absorbed shell's claim was moved, not
    // dropped — dropping it would leave the Metrifox id unjoinable by anything
    // that names it later.
    expect(await tenant.keyValues()).toEqual([
      "email:billing@acme.example",
      "external_ref:metrifox:acct-9:m-1",
      "external_ref:stripe::cus_1",
    ]);

    const [account] = await tenant.accounts();
    expect(account?.members).toEqual(["cus_1", "m-1"]);
  });

  it("settles, so the next pass has nothing left to do", async () => {
    const { tenant, later } = await stagedArrival();
    await tenant.updateCustomer(later, { email: "billing@acme.example" });
    await resolveIdentities(tenant.userId, "manual");

    const settled = await tenant.placements();
    const third = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.placements()).toEqual(settled);
    expect(third.counts).toEqual({
      accountsCreated: 0,
      accountsAbsorbed: 0,
      accountsReaped: 0,
      customersLinked: 0,
      keysIndexed: 0,
    });
  });
});

describe("the boundary: an account with someone else in it", () => {
  /**
   * A member of a shared account is *not* carried off by a new key, and this is
   * the declared limit of what the pass will do on its own.
   *
   * Its old account holds its self-key and the key it shares with the record
   * still sitting there, so the strength contest keeps it where it is and the
   * new match is reported instead. The pass will not split a group on inferred
   * evidence alone — that would silently re-parent a record on the strength of
   * one changed field, with no undo.
   */
  async function shared() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
      { provider: "metrifox", identityPriority: 30, metadata: { accountId: "a-1" } },
    ]);

    // Two records joined by one address.
    const moving = await tenant.customer("stripe", "cus_1", {
      email: "billing@acme.example",
    });
    await tenant.customer("mock", "c-1", { email: "billing@acme.example" });
    // A separate company entirely.
    const other = await tenant.customer("metrifox", "m-1", {
      email: "ap@northwind.example",
    });

    await resolveIdentities(tenant.userId, "manual");
    return { tenant, moving, other };
  }

  it("keeps it where it is and reports the new claim", async () => {
    const { tenant, moving } = await shared();
    const before = await tenant.placements();

    // Stripe now says this customer's address is Northwind's.
    await tenant.updateCustomer(moving, { email: "ap@northwind.example" });
    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.placements()).toEqual(before);
    expect(outcome.issues.map((issue) => issue.kind)).toEqual([
      "key_claimed_elsewhere",
    ]);
  });

  it("moves once a human says the two are the same company", async () => {
    const { tenant, moving, other } = await shared();
    await tenant.updateCustomer(moving, { email: "ap@northwind.example" });
    await resolveIdentities(tenant.userId, "manual");

    // The documented remedy, and the reason the limit above is a limit rather
    // than a dead end.
    const northwind = await tenant.placements();
    expect(northwind.get("cus_1")).not.toBe(northwind.get("m-1"));

    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: moving,
      customerIdB: other,
    });
    await resolveIdentities(tenant.userId, "manual");

    const joined = await tenant.placements();
    expect(joined.get("cus_1")).toBe(joined.get("m-1"));
  });
});
