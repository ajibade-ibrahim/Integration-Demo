/**
 * Human verdicts, through a whole pass.
 *
 * The unit tests pin the algebra — `same` is transitive, `distinct` is not.
 * What matters here is the property that makes either worth offering: an
 * assertion **sticks**. The pass recomputes accounts, keys and fields from
 * scratch every time it runs, and a verdict that survived one pass and not the
 * fourth would be worse than no feature at all, because the user would have
 * stopped checking.
 *
 * `distinct` carries the most weight. A false merge has no user-facing undo, so
 * the negative assertion is the only remedy — and a remedy that has to be
 * re-applied after every sync is not a remedy.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import {
  deleteAssertion,
  loadAssertions,
  upsertAssertion,
} from "@/core/repositories/identity-repository";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("same", () => {
  /** Two records with nothing whatsoever in common. */
  async function unrelated() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
    ]);

    const left = await tenant.customer("stripe", "cus_1", { name: "ACME" });
    const right = await tenant.customer("mock", "c-1", { name: "Acme Mfg" });

    await resolveIdentities(tenant.userId, "manual");
    return { tenant, left, right };
  }

  it("starts apart — no key connects them", async () => {
    const { tenant } = await unrelated();
    expect(await tenant.groups()).toEqual([["c-1"], ["cus_1"]]);
  });

  it("joins them on the user's word alone", async () => {
    const { tenant, left, right } = await unrelated();

    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: left,
      customerIdB: right,
      note: "Same company, different billing entity",
    });
    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["c-1", "cus_1"]]);
    // The older account survives and the singleton is absorbed, so the id the
    // user has been looking at is the one that persists.
    expect(outcome.counts.accountsAbsorbed).toBe(1);
  });

  it("survives every later pass", async () => {
    const { tenant, left, right } = await unrelated();
    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: left,
      customerIdB: right,
    });
    await resolveIdentities(tenant.userId, "manual");

    const settled = await tenant.placements();
    await resolveIdentities(tenant.userId, "manual");
    await resolveIdentities(tenant.userId, "manual");

    // Not just the same grouping — the same account. Nothing here has a key to
    // rebuild the group from, so this is the assertion doing the work each time.
    expect(await tenant.placements()).toEqual(settled);
  });
});

describe("distinct", () => {
  /** Two records a shared address would otherwise merge. */
  async function keptApart() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
    ]);

    const left = await tenant.customer("stripe", "cus_1", {
      email: "billing@agency.example",
    });
    const right = await tenant.customer("mock", "c-1", {
      email: "billing@agency.example",
    });

    // Asserted before the first pass: two firms whose books are kept by the
    // same bookkeeper, which is the case the free-mail blocklist cannot catch.
    const assertion = await upsertAssertion({
      userId: tenant.userId,
      kind: "distinct",
      customerIdA: left,
      customerIdB: right,
    });

    return { tenant, left, right, assertionId: assertion?.id ?? "" };
  }

  it("holds against a shared email", async () => {
    const { tenant } = await keptApart();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["c-1"], ["cus_1"]]);
    expect(outcome.status).toBe("partial");
  });

  it("explains itself once, not twice", async () => {
    const { tenant, left, right } = await keptApart();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    // One issue, and it is the one that names the reason. The shared key does
    // come back contested — the first record holds it and the second cannot —
    // but reporting that as an open conflict as well would ask the user, on
    // every pass forever, to settle a question they have already settled with
    // the very answer that produced this state.
    expect(outcome.issues).toHaveLength(1);

    const issue = outcome.issues[0];
    if (issue?.kind !== "blocked_by_assertion") {
      throw new Error(`expected the assertion issue, got ${issue?.kind}`);
    }
    expect(issue.customerId).toBe(right);
    expect(issue.otherCustomerId).toBe(left);
    expect(issue.keyKind).toBe("email");
    expect(issue.keyValue).toBe("billing@agency.example");
  });

  it("is never re-merged, however many passes run", async () => {
    const { tenant } = await keptApart();
    await resolveIdentities(tenant.userId, "manual");
    const settled = await tenant.placements();

    // The regression that would make the negative assertion worthless. Each
    // pass rebuilds the evidence from nothing and re-finds the shared address.
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await resolveIdentities(tenant.userId, "manual");
      expect(outcome.issues.map((issue) => issue.kind)).toEqual([
        "blocked_by_assertion",
      ]);
    }

    expect(await tenant.placements()).toEqual(settled);
    expect(await tenant.accounts()).toHaveLength(2);
  });

  it("lets them merge again once withdrawn", async () => {
    const { tenant, assertionId } = await keptApart();
    await resolveIdentities(tenant.userId, "manual");

    expect(await deleteAssertion(tenant.userId, assertionId)).toBe(true);
    const outcome = await resolveIdentities(tenant.userId, "manual");

    // The undo has to work, because a `distinct` made by mistake is otherwise
    // permanent — the resolver will never revise it on its own.
    expect(await tenant.groups()).toEqual([["c-1", "cus_1"]]);
    expect(outcome.issues).toEqual([]);
  });
});

describe("when the two kinds contradict each other", () => {
  it("lets same win, because it names the pair being grouped", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
      { provider: "metrifox", identityPriority: 30 },
    ]);

    const a = await tenant.customer("stripe", "cus_1", { name: "One" });
    const b = await tenant.customer("mock", "c-1", { name: "Two" });
    const c = await tenant.customer("metrifox", "m-1", { name: "Three" });

    // A = B, A = C, and B is not C. The user has contradicted themselves.
    await upsertAssertion({ userId: tenant.userId, kind: "same", customerIdA: a, customerIdB: b });
    await upsertAssertion({ userId: tenant.userId, kind: "same", customerIdA: a, customerIdB: c });
    await upsertAssertion({ userId: tenant.userId, kind: "distinct", customerIdA: b, customerIdB: c });

    await resolveIdentities(tenant.userId, "manual");

    // `same` is transitive by meaning, and the veto only ever applies to
    // *inferred* groupings — so all three land together rather than the pass
    // silently picking which of the user's three statements to honour.
    expect(await tenant.groups()).toEqual([["c-1", "cus_1", "m-1"]]);
  });
});

describe("what the resolver will not do", () => {
  it("never writes or withdraws an assertion", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
    ]);
    const left = await tenant.customer("stripe", "cus_1", {
      email: "billing@acme.example",
    });
    const right = await tenant.customer("mock", "c-1", {
      email: "billing@acme.example",
    });

    // Two records the pass is about to merge on its own. It must not record
    // that inference as a human verdict — an inferred merge has to stay
    // revisable, and only assertions are exempt from being recomputed.
    await resolveIdentities(tenant.userId, "manual");
    expect(await loadAssertions(tenant.userId)).toEqual([]);

    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: left,
      customerIdB: right,
    });
    await resolveIdentities(tenant.userId, "manual");

    expect(await loadAssertions(tenant.userId)).toHaveLength(1);
  });

  it("keeps assertions only as long as the customers they name", async () => {
    // Anchored to `Customer` rows rather than accounts, because account ids are
    // created, absorbed and reaped by every pass. A Customer survives re-sync
    // and cascades away with its integration, which is exactly the lifetime an
    // assertion should have — so disconnecting an integration retires the
    // verdicts about its records rather than leaving them to re-apply if the
    // same ids ever come back.
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "mock", identityPriority: 20 },
    ]);
    const left = await tenant.customer("stripe", "cus_1", { name: "One" });
    const right = await tenant.customer("mock", "c-1", { name: "Two" });

    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: left,
      customerIdB: right,
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.groups()).toEqual([["c-1", "cus_1"]]);

    await tenant.deleteConnection("mock");

    expect(await loadAssertions(tenant.userId)).toEqual([]);
    expect(
      await prisma.identityAssertion.count({ where: { userId: tenant.userId } })
    ).toBe(0);

    // And the pass carries on without it, rather than failing on a reference to
    // a customer that is gone.
    const outcome = await resolveIdentities(tenant.userId, "manual");
    expect(outcome.status).toBe("success");
    expect(await tenant.groups()).toEqual([["cus_1"]]);
  });
});
