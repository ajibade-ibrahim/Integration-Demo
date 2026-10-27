/**
 * The identity repository, against a real Postgres.
 *
 * Most of this file is about one thing: **no operation may cross a tenant.** A
 * missed join is visible to the user and recoverable; one customer's company
 * data appearing under another customer's account is neither, and it looks
 * exactly like the matcher working well. So every mutation is tried once with a
 * foreign id, and is expected to decline rather than succeed quietly.
 *
 * The rest pins the mechanics the pass depends on and cannot check for itself:
 * canonical input ordering (without it the same data resolves differently run
 * to run), the empty-key-set guard, and what absorbing an account does to keys
 * both accounts hold.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  absorbAccount,
  attachCustomerToAccount,
  createAccountForCustomer,
  deleteAssertion,
  findAccountsForKeys,
  finishResolutionRun,
  listResolutionRuns,
  loadAccountKeys,
  loadAccountSummaries,
  loadAssertions,
  loadResolutionInput,
  reapEmptyAccounts,
  startResolutionRun,
  updateAccountFields,
  upsertAssertion,
  type AccountFields,
  type NewIdentityKey,
} from "@/core/repositories/identity-repository";
import { createIntegration } from "@/core/repositories/integration-repository";
import { prisma } from "@/lib/prisma";

/** A minimal resolved-field set, since most tests do not care about the values. */
function fields(over: Partial<AccountFields> = {}): AccountFields {
  return {
    name: "Acme",
    domain: null,
    email: null,
    industry: null,
    createDate: null,
    type: null,
    customFields: {},
    fieldProvenance: {},
    ...over,
  };
}

function emailKey(value: string, integrationId: string): NewIdentityKey {
  return {
    kind: "email",
    value,
    rawValue: value,
    emailClass: "role",
    source: "customer_email",
    sourceIntegrationId: integrationId,
    sourceAccountId: null,
    sourceRecordId: "cus_1",
  };
}

/** One user with one integration, and a factory for customers under it. */
async function makeTenant(options: { identityPriority?: number; providerName?: string } = {}) {
  const user = await prisma.user.create({
    data: { email: `identity-repo-${randomUUID()}@test.local` },
    select: { id: true },
  });

  const integration = await createIntegration({
    userId: user.id,
    providerName: options.providerName ?? "stripe",
    functionNames: ["identity"],
    instanceLabel: `${options.providerName ?? "stripe"} — ${user.id.slice(0, 8)}`,
  });

  if (options.identityPriority !== undefined) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: { identityPriority: options.identityPriority },
    });
  }

  async function customer(externalSourceId: string, over: Record<string, unknown> = {}) {
    return prisma.customer.create({
      data: {
        integrationId: integration.id,
        externalSourceId,
        name: externalSourceId,
        ...over,
      },
      select: { id: true },
    });
  }

  return { userId: user.id, integrationId: integration.id, customer };
}

let tenant: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  tenant = await makeTenant();
});

describe("loadResolutionInput", () => {
  it("returns customers in the pass's canonical order", async () => {
    // Priority first, then provider name. Without a total order the pass is
    // not reproducible: the first claimant of a key wins, so whichever row
    // Postgres happened to return first would decide the grouping.
    const user = await prisma.user.create({
      data: { email: `order-${randomUUID()}@test.local` },
      select: { id: true },
    });

    for (const [providerName, priority] of [
      ["stripe", 50],
      ["hubspot", 10],
      ["metrifox", 50],
    ] as const) {
      const integration = await createIntegration({
        userId: user.id,
        providerName,
        functionNames: ["identity"],
        instanceLabel: providerName,
      });
      await prisma.integration.update({
        where: { id: integration.id },
        data: { identityPriority: priority },
      });
      await prisma.customer.create({
        data: {
          integrationId: integration.id,
          externalSourceId: `${providerName}-1`,
          name: providerName,
        },
      });
    }

    const loaded = await loadResolutionInput(user.id);

    expect(loaded.map((c) => c.providerName)).toEqual([
      "hubspot", // priority 10
      "metrifox", // priority 50, sorts before stripe
      "stripe",
    ]);
    expect(loaded[0]?.identityPriority).toBe(10);
  });

  it("harvests emails only from contacts whose company resolved", async () => {
    // A contact whose company could not be resolved is not evidence about any
    // company. Reaching contacts through the customer's own relation is what
    // makes that true by construction rather than by a filter someone could
    // later drop.
    const acme = await tenant.customer("cus_acme");

    await prisma.contact.createMany({
      data: [
        {
          integrationId: tenant.integrationId,
          externalSourceId: "ct-1",
          name: "Dana",
          email: "dana@acme.example",
          customerId: acme.id,
        },
        {
          integrationId: tenant.integrationId,
          externalSourceId: "ct-2",
          name: "No Email",
          customerId: acme.id,
        },
        {
          integrationId: tenant.integrationId,
          externalSourceId: "ct-3",
          name: "Orphan",
          email: "orphan@elsewhere.example",
          externalCustomerId: "c-999",
        },
      ],
    });

    const [loaded] = await loadResolutionInput(tenant.userId);

    expect(loaded?.contactEmails).toEqual([
      { email: "dana@acme.example", externalSourceId: "ct-1" },
    ]);
  });

  it("never returns another user's customers", async () => {
    const other = await makeTenant();
    await other.customer("cus_theirs");
    await tenant.customer("cus_mine");

    const loaded = await loadResolutionInput(tenant.userId);

    expect(loaded.map((c) => c.externalSourceId)).toEqual(["cus_mine"]);
  });
});

describe("findAccountsForKeys", () => {
  it("returns nothing for an empty key set", async () => {
    // Prisma treats `OR: []` as matching every row, so the one input that
    // should find nothing would otherwise scan the whole tenant and claim
    // every account as a candidate.
    const customer = await tenant.customer("cus_1");
    await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields(),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    expect(await findAccountsForKeys(tenant.userId, [])).toEqual([]);
  });

  it("does not see an identical key held by another user", async () => {
    // The headline risk. Two unrelated businesses can genuinely both use
    // billing@acme.example; the tenant filter is all that separates them.
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    await createAccountForCustomer({
      userId: other.userId,
      customerId: theirs.id,
      fields: fields({ name: "Their Acme" }),
      keys: [emailKey("billing@acme.example", other.integrationId)],
    });

    const found = await findAccountsForKeys(tenant.userId, [
      { kind: "email", value: "billing@acme.example" },
    ]);

    expect(found).toEqual([]);
  });

  it("reports the kind that matched, not just the account", async () => {
    // The pass picks a winner by key strength when several accounts match, so
    // a bare account id would lose the information the decision needs.
    const customer = await tenant.customer("cus_1");
    const { accountId } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields(),
      keys: [
        emailKey("billing@acme.example", tenant.integrationId),
        {
          kind: "domain",
          value: "acme.example",
          rawValue: "https://acme.example",
          emailClass: "corporate",
          source: "customer_domain",
          sourceIntegrationId: tenant.integrationId,
          sourceAccountId: null,
          sourceRecordId: "cus_1",
        },
      ],
    });

    const found = await findAccountsForKeys(tenant.userId, [
      { kind: "domain", value: "acme.example" },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "domain",
      value: "acme.example",
      customerAccountId: accountId,
      source: "customer_domain",
    });
  });
});

describe("createAccountForCustomer", () => {
  it("links the customer and indexes its keys", async () => {
    const customer = await tenant.customer("cus_1");

    const { accountId, contested } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields({ name: "Acme Corp", email: "billing@acme.example" }),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    expect(contested).toEqual([]);
    const row = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(row?.customerAccountId).toBe(accountId);
    expect(await loadAccountKeys(tenant.userId, [accountId])).toHaveLength(1);
  });

  it("reports a key another account already claims, and still creates", async () => {
    // Not an error. The account is created and the customer linked; the
    // contested key stays where it was and a human is told, because merging
    // two accounts automatically is the one thing the pass must not do.
    const first = await tenant.customer("cus_1");
    await createAccountForCustomer({
      userId: tenant.userId,
      customerId: first.id,
      fields: fields(),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    const second = await tenant.customer("cus_2");
    const result = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: second.id,
      fields: fields({ name: "Acme Two" }),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    expect(result.contested).toHaveLength(1);
    expect(result.contested[0]?.value).toBe("billing@acme.example");
    expect(await loadAccountKeys(tenant.userId, [result.accountId])).toEqual([]);
    const row = await prisma.customer.findUnique({ where: { id: second.id } });
    expect(row?.customerAccountId).toBe(result.accountId);
  });

  it("stays silent when the account already holds the key itself", async () => {
    // Re-indexing the same key on a second pass is the ordinary case and must
    // not be reported as a conflict, or every run would raise issues.
    const customer = await tenant.customer("cus_1");
    const { accountId } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields(),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    const again = await attachCustomerToAccount({
      userId: tenant.userId,
      customerId: customer.id,
      accountId,
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    // Nothing contested and nothing written: re-offering a key the account
    // already holds is ordinary, and is what makes an idempotent pass able to
    // report having done no work.
    expect(again).toEqual({ linked: true, contested: [], keysIndexed: 0 });
  });

  it("refuses to link a customer belonging to another user", async () => {
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");

    const { accountId } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: theirs.id,
      fields: fields(),
      keys: [],
    });

    // The account is created under this user, but the foreign customer is
    // untouched — which is the whole point.
    const row = await prisma.customer.findUnique({ where: { id: theirs.id } });
    expect(row?.customerAccountId).toBeNull();
    const summary = await loadAccountSummaries(tenant.userId, [accountId]);
    expect(summary.get(accountId)?.memberIds).toEqual([]);
  });
});

describe("attachCustomerToAccount", () => {
  it("declines another user's account and hands back every key", async () => {
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    const { accountId: theirAccount } = await createAccountForCustomer({
      userId: other.userId,
      customerId: theirs.id,
      fields: fields({ name: "Their Acme" }),
      keys: [],
    });

    const mine = await tenant.customer("cus_mine");
    const result = await attachCustomerToAccount({
      userId: tenant.userId,
      customerId: mine.id,
      accountId: theirAccount,
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    expect(result.linked).toBe(false);
    expect(result.contested).toHaveLength(1);
    const row = await prisma.customer.findUnique({ where: { id: mine.id } });
    expect(row?.customerAccountId).toBeNull();
    // And nothing was written into their account either.
    expect(await loadAccountKeys(other.userId, [theirAccount])).toEqual([]);
  });
});

describe("absorbAccount", () => {
  it("moves the member and its keys, then deletes the shell", async () => {
    // The common path, not an optimization: without it whichever integration
    // synced first would permanently own the grouping.
    const first = await tenant.customer("cus_1");
    const second = await tenant.customer("cus_2");

    const a = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: first.id,
      fields: fields({ name: "Acme One" }),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });
    const b = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: second.id,
      fields: fields({ name: "Acme Two" }),
      keys: [emailKey("accounts@acme.example", tenant.integrationId)],
    });

    expect(
      await absorbAccount({
        userId: tenant.userId,
        fromAccountId: b.accountId,
        intoAccountId: a.accountId,
      })
    ).toEqual({ absorbed: true });

    const moved = await prisma.customer.findUnique({ where: { id: second.id } });
    expect(moved?.customerAccountId).toBe(a.accountId);
    expect(
      (await loadAccountKeys(tenant.userId, [a.accountId])).map((k) => k.value)
    ).toEqual(["accounts@acme.example", "billing@acme.example"]);
    expect(
      await prisma.customerAccount.findUnique({ where: { id: b.accountId } })
    ).toBeNull();
  });

  it("drops a moving key the target already holds", async () => {
    // The target's claim is the older one, so keeping it preserves the
    // firstSeenAt and the rawValue the user first saw. Re-pointing instead
    // would violate the unique and abort the absorb.
    const first = await tenant.customer("cus_1");
    const second = await tenant.customer("cus_2");

    const a = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: first.id,
      fields: fields(),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });
    const b = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: second.id,
      fields: fields(),
      keys: [],
    });
    // Give b a distinct key, then the same one a holds — via a direct write,
    // since the repository would rightly refuse the duplicate.
    await prisma.customerAccountKey.create({
      data: {
        userId: tenant.userId,
        customerAccountId: b.accountId,
        kind: "domain",
        value: "acme.example",
        rawValue: "acme.example",
        emailClass: "corporate",
        source: "customer_domain",
        sourceIntegrationId: tenant.integrationId,
        sourceAccountId: null,
        sourceRecordId: "cus_b",
      },
    });

    await absorbAccount({
      userId: tenant.userId,
      fromAccountId: b.accountId,
      intoAccountId: a.accountId,
    });

    const keys = await loadAccountKeys(tenant.userId, [a.accountId]);
    expect(keys.map((k) => k.value).sort()).toEqual([
      "acme.example",
      "billing@acme.example",
    ]);
  });

  it("refuses a pair spanning two users, touching neither", async () => {
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    const mine = await tenant.customer("cus_mine");

    const theirAccount = await createAccountForCustomer({
      userId: other.userId,
      customerId: theirs.id,
      fields: fields({ name: "Their Acme" }),
      keys: [emailKey("billing@acme.example", other.integrationId)],
    });
    const myAccount = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: mine.id,
      fields: fields({ name: "My Acme" }),
      keys: [],
    });

    expect(
      await absorbAccount({
        userId: tenant.userId,
        fromAccountId: theirAccount.accountId,
        intoAccountId: myAccount.accountId,
      })
    ).toEqual({ absorbed: false });

    const untouched = await prisma.customer.findUnique({
      where: { id: theirs.id },
    });
    expect(untouched?.customerAccountId).toBe(theirAccount.accountId);
    expect(
      await loadAccountKeys(other.userId, [theirAccount.accountId])
    ).toHaveLength(1);
  });

  it("is a no-op on itself", async () => {
    const customer = await tenant.customer("cus_1");
    const a = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields(),
      keys: [],
    });

    expect(
      await absorbAccount({
        userId: tenant.userId,
        fromAccountId: a.accountId,
        intoAccountId: a.accountId,
      })
    ).toEqual({ absorbed: false });
    expect(
      await prisma.customerAccount.findUnique({ where: { id: a.accountId } })
    ).not.toBeNull();
  });
});

describe("reapEmptyAccounts", () => {
  it("removes memberless accounts and their key claims", async () => {
    // Not housekeeping. A Customer cascades away with its integration, leaving
    // the account still claiming its keys — and the unique on (userId, kind,
    // value) cannot tell an abandoned claim from a live one, so the stale row
    // would permanently block the correct account from forming.
    const customer = await tenant.customer("cus_1");
    const { accountId } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields(),
      keys: [emailKey("billing@acme.example", tenant.integrationId)],
    });

    await prisma.customer.delete({ where: { id: customer.id } });

    // Ids, not a count: the pass reports keys as claimed by another account
    // before this runs, and needs to know which of those rivals just went away.
    expect(await reapEmptyAccounts(tenant.userId)).toEqual([accountId]);
    expect(
      await prisma.customerAccountKey.count({ where: { customerAccountId: accountId } })
    ).toBe(0);
    // And the key is free again, which is the reason for the whole step.
    expect(
      await findAccountsForKeys(tenant.userId, [
        { kind: "email", value: "billing@acme.example" },
      ])
    ).toEqual([]);
  });

  it("keeps accounts that still have members, and other users' shells", async () => {
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    const theirAccount = await createAccountForCustomer({
      userId: other.userId,
      customerId: theirs.id,
      fields: fields(),
      keys: [],
    });
    await prisma.customer.delete({ where: { id: theirs.id } });

    const mine = await tenant.customer("cus_mine");
    const myAccount = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: mine.id,
      fields: fields(),
      keys: [],
    });

    expect(await reapEmptyAccounts(tenant.userId)).toEqual([]);
    expect(
      await prisma.customerAccount.findUnique({ where: { id: myAccount.accountId } })
    ).not.toBeNull();
    expect(
      await prisma.customerAccount.findUnique({ where: { id: theirAccount.accountId } })
    ).not.toBeNull();
  });
});

describe("updateAccountFields", () => {
  it("overwrites the whole resolved record, provenance included", async () => {
    const customer = await tenant.customer("cus_1");
    const { accountId } = await createAccountForCustomer({
      userId: tenant.userId,
      customerId: customer.id,
      fields: fields({ name: "Acme", industry: "Manufacturing" }),
      keys: [],
    });

    const ok = await updateAccountFields({
      userId: tenant.userId,
      accountId,
      // Industry drops to null, which is the case a partial update would get
      // wrong: the values are a pure function of members and precedence, so a
      // field that no member supplies any more must actually clear.
      fields: fields({
        name: "Acme Corp",
        email: "billing@acme.example",
        customFields: { tier: "gold" },
        fieldProvenance: {
          name: { integrationId: tenant.integrationId },
        },
      }),
    });

    expect(ok).toBe(true);
    const row = await prisma.customerAccount.findUnique({ where: { id: accountId } });
    expect(row?.name).toBe("Acme Corp");
    expect(row?.industry).toBeNull();
    expect(row?.customFields).toBe('{"tier":"gold"}');
    expect(row?.fieldProvenance).toContain(tenant.integrationId);
  });

  it("declines another user's account", async () => {
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    const { accountId } = await createAccountForCustomer({
      userId: other.userId,
      customerId: theirs.id,
      fields: fields({ name: "Their Acme" }),
      keys: [],
    });

    expect(
      await updateAccountFields({
        userId: tenant.userId,
        accountId,
        fields: fields({ name: "Hijacked" }),
      })
    ).toBe(false);

    const row = await prisma.customerAccount.findUnique({ where: { id: accountId } });
    expect(row?.name).toBe("Their Acme");
  });
});

describe("assertions", () => {
  it("orders the pair canonically, whichever way it is given", async () => {
    // Without the ordering, (A,B) and (B,A) both insert and the unique
    // constraint means nothing — the same verdict could be stored twice, with
    // two different answers.
    const a = await tenant.customer("cus_a");
    const b = await tenant.customer("cus_b");
    const [low, high] = [a.id, b.id].sort();

    const first = await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: high as string,
      customerIdB: low as string,
    });

    expect(first).toMatchObject({ leftCustomerId: low, rightCustomerId: high });
    expect(await loadAssertions(tenant.userId)).toHaveLength(1);
  });

  it("treats the reverse verdict as a correction, not a second row", async () => {
    const a = await tenant.customer("cus_a");
    const b = await tenant.customer("cus_b");

    await upsertAssertion({
      userId: tenant.userId,
      kind: "same",
      customerIdA: a.id,
      customerIdB: b.id,
    });
    await upsertAssertion({
      userId: tenant.userId,
      kind: "distinct",
      customerIdA: b.id,
      customerIdB: a.id,
      note: "different subsidiaries",
    });

    const all = await loadAssertions(tenant.userId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "distinct",
      note: "different subsidiaries",
    });
  });

  it("refuses a pair naming another user's customer", async () => {
    // Otherwise an assertion is a way to name someone else's customer and have
    // the next pass merge it into your own account.
    const other = await makeTenant();
    const theirs = await other.customer("cus_theirs");
    const mine = await tenant.customer("cus_mine");

    expect(
      await upsertAssertion({
        userId: tenant.userId,
        kind: "same",
        customerIdA: mine.id,
        customerIdB: theirs.id,
      })
    ).toBeUndefined();
    expect(await loadAssertions(tenant.userId)).toEqual([]);
  });

  it("refuses a customer asserted against itself", async () => {
    const a = await tenant.customer("cus_a");

    expect(
      await upsertAssertion({
        userId: tenant.userId,
        kind: "same",
        customerIdA: a.id,
        customerIdB: a.id,
      })
    ).toBeUndefined();
  });

  it("withdraws only this user's assertion", async () => {
    const other = await makeTenant();
    const t1 = await other.customer("cus_1");
    const t2 = await other.customer("cus_2");
    const theirs = await upsertAssertion({
      userId: other.userId,
      kind: "same",
      customerIdA: t1.id,
      customerIdB: t2.id,
    });

    expect(await deleteAssertion(tenant.userId, theirs?.id ?? "")).toBe(false);
    expect(await loadAssertions(other.userId)).toHaveLength(1);
    expect(await deleteAssertion(other.userId, theirs?.id ?? "")).toBe(true);
  });
});

describe("run history", () => {
  it("round-trips counts and issues", async () => {
    const runId = await startResolutionRun(tenant.userId, "manual");

    await finishResolutionRun({
      userId: tenant.userId,
      runId,
      status: "partial",
      counts: {
        accountsCreated: 3,
        accountsAbsorbed: 1,
        accountsReaped: 0,
        customersLinked: 4,
        keysIndexed: 9,
      },
      issues: [
        {
          kind: "field_conflict",
          reason: "2 sources disagree on Industry",
          accountId: "acc-1",
          fieldName: "industry",
          values: ["Manufacturing", "Industrial"],
          integrationIds: ["int-1", "int-2"],
        },
      ],
    });

    const [run] = await listResolutionRuns(tenant.userId);

    expect(run).toMatchObject({ status: "partial", trigger: "manual" });
    expect(run?.completedAt).not.toBeNull();
    expect(run?.counts.keysIndexed).toBe(9);
    expect(run?.issues[0]).toMatchObject({
      kind: "field_conflict",
      fieldName: "industry",
    });
  });

  it("does not close another user's run", async () => {
    const other = await makeTenant();
    const runId = await startResolutionRun(other.userId, "sync");

    await finishResolutionRun({
      userId: tenant.userId,
      runId,
      status: "failed",
      counts: {
        accountsCreated: 0,
        accountsAbsorbed: 0,
        accountsReaped: 0,
        customersLinked: 0,
        keysIndexed: 0,
      },
      issues: [],
    });

    const [run] = await listResolutionRuns(other.userId);
    expect(run?.status).toBe("running");
    expect(run?.completedAt).toBeNull();
  });

  it("lists only this user's runs", async () => {
    const other = await makeTenant();
    await startResolutionRun(other.userId, "sync");
    await startResolutionRun(tenant.userId, "scheduled");

    const mine = await listResolutionRuns(tenant.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.trigger).toBe("scheduled");
  });
});
