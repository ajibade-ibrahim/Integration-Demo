/**
 * Accounts with no members left, and why deleting them is step 0 rather than
 * housekeeping.
 *
 * A `Customer` cascades away when its integration is deleted, leaving its
 * account behind. The keys sourced from that integration are retired by
 * `deleteIntegration` now, so the shell no longer blocks a replacement from
 * claiming the same address — but the empty account itself is still a row with
 * no owner in the user interface, and reaping it is what keeps the account list
 * honest.
 *
 * The pass reaps twice, and the second one is not in the original plan. The
 * first clears shells left by a *previous* run; the second clears shells that
 * *this* run emptied by moving their last member out.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { upsertAssertion } from "@/core/repositories/identity-repository";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("a shell left by a deleted integration", () => {
  async function disconnected() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "metrifox", identityPriority: 20, metadata: { accountId: "a-1" } },
    ]);

    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });
    await resolveIdentities(tenant.userId, "manual");

    // The user disconnects Stripe. Its customer cascades away, and the keys it
    // supplied are retired with it; the empty account remains for the pass.
    await tenant.deleteConnection("stripe");

    // Then connects something else that knows the same company.
    await tenant.customer("metrifox", "m-1", { email: "billing@acme.example" });

    return tenant;
  }

  it("does not block the replacement from claiming the same address", async () => {
    const tenant = await disconnected();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(outcome.counts.accountsReaped).toBe(1);
    expect(outcome.counts.accountsCreated).toBe(1);
    // The whole point: no contest, because the rival ceased to exist before the
    // matching started.
    expect(outcome.issues).toEqual([]);
    expect(outcome.status).toBe("success");
  });

  it("leaves one account, holding the address in its own right", async () => {
    const tenant = await disconnected();
    await resolveIdentities(tenant.userId, "manual");

    const accounts = await tenant.accounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.members).toEqual(["m-1"]);
    expect(await tenant.keyValues()).toEqual([
      "email:billing@acme.example",
      "external_ref:metrifox:a-1:m-1",
    ]);
  });

  it("reaps nothing when every account still has a member", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_1", { email: "billing@acme.example" });

    await resolveIdentities(tenant.userId, "manual");
    const second = await resolveIdentities(tenant.userId, "manual");

    expect(second.counts.accountsReaped).toBe(0);
  });
});

describe("a shell this very pass emptied", () => {
  /**
   * A `same` group whose members all sit on one account, and which then gains a
   * cross-reference pointing the whole group at a different one.
   *
   * The only way to empty a *multi-member* account in a single pass, and
   * therefore the only way to reach the second reap: a singleton is absorbed
   * and deleted on the spot, so it never becomes a shell.
   */
  async function vacated() {
    const tenant = await makeIdentityTenant([
      { provider: "mock", identityPriority: 10 },
      // No metadata, so this one contributes no self-key of its own.
      { provider: "metrifox", identityPriority: 20 },
      { provider: "stripe", identityPriority: 30 },
    ]);

    const first = await tenant.customer("mock", "c-1", {
      email: "billing@acme.example",
    });
    const second = await tenant.customer("metrifox", "m-1", {
      email: "billing@acme.example",
    });
    // A third record with nothing in common with the other two.
    await tenant.customer("stripe", "cus_p", { name: "Acme, billed" });

    await resolveIdentities(tenant.userId, "manual");

    // The user confirms the first two are one company, then a sync brings in a
    // mapped `crossRef.stripe` naming the third.
    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: first,
      customerIdB: second,
    });
    await tenant.updateCustomer(first, { crossRefs: { stripe: "cus_p" } });

    return tenant;
  }

  it("is gone by the end of the pass, not the next one", async () => {
    const tenant = await vacated();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(outcome.counts.accountsReaped).toBe(1);
    // A singleton would have been absorbed instead; this account had two
    // members, so it was vacated rather than merged.
    expect(outcome.counts.accountsAbsorbed).toBe(0);

    const accounts = await tenant.accounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.members).toEqual(["c-1", "cus_p", "m-1"]);
  });

  it("reports no conflict against the account it just deleted", async () => {
    const tenant = await vacated();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    // The keys were genuinely contested while the group was moving — the old
    // account still held them at the moment of the write. Reporting that would
    // end the pass telling the user two accounts disagree over an address when
    // one of the two was deleted seconds later: a conflict with nothing behind
    // it, and no action available that could clear it.
    expect(outcome.issues).toEqual([]);
  });

  it("re-indexes the keys that went with the shell on the next pass", async () => {
    const tenant = await vacated();
    await resolveIdentities(tenant.userId, "manual");

    // The honest cost of reaping rather than absorbing: the vacated account's
    // keys are cascade-deleted with it, so for one pass the group's address is
    // indexed nowhere. Self-healing, and in the safe direction — an unindexed
    // key costs a join, where a stale one causes a false merge.
    expect(await tenant.keyValues()).toEqual(["external_ref:stripe::cus_p"]);

    const settled = await tenant.placements();
    const next = await resolveIdentities(tenant.userId, "manual");

    expect(next.counts.keysIndexed).toBe(2);
    expect(await tenant.keyValues()).toEqual([
      "email:billing@acme.example",
      "external_ref:mock::c-1",
      "external_ref:stripe::cus_p",
    ]);
    // And the grouping never wavered while that was happening.
    expect(await tenant.placements()).toEqual(settled);
  });
});
