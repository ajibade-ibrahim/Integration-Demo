/**
 * The pass end to end: three connections, one company, one account.
 *
 * This is the outcome the whole feature is for — "the customers view shows one
 * Acme instead of three" — and the one test that asserts it as a whole rather
 * than a mechanism at a time. It is also where the three keys are exercised
 * together: Stripe joins on its account-level email, HubSpot has no such field
 * and joins through a *contact's* email, and the resolved record then draws its
 * industry from HubSpot and its name from Stripe.
 *
 * The exact key list is asserted rather than a count. A key that quietly stops
 * being emitted costs a join, and a count would still pass.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { listResolutionRuns } from "@/core/repositories/identity-repository";

import { makeIdentityTenant, type IdentityTenant } from "./identity-helpers";

beforeAll(() => {
  // The pass reads `externalIdScope` and each provider's scope hook off the
  // registry, so it has to be populated before anything resolves.
  bootstrap();
});

/**
 * One company as three systems see it, plus a second company that must not be
 * swept in with it.
 *
 * Priorities are deliberately all different, so every field has an unambiguous
 * winner and the run can be asserted to raise no issues at all. Equal priority
 * is a `field_conflict`, and that belongs in its own test.
 */
async function converged(): Promise<IdentityTenant> {
  const tenant = await makeIdentityTenant([
    { provider: "stripe", identityPriority: 10 },
    { provider: "hubspot", identityPriority: 50, metadata: { hubId: "portal-1" } },
    { provider: "metrifox", identityPriority: 100, metadata: { accountId: "acct-9" } },
  ]);

  await tenant.customer("stripe", "cus_1", {
    name: "Acme Corp",
    email: "billing@acme.example",
    createDate: new Date("2023-04-01T00:00:00Z"),
  });

  const hubspotCompany = await tenant.customer("hubspot", "12345", {
    name: "Acme Manufacturing Inc",
    domain: "acme.example",
    industry: "Manufacturing",
    type: "customer",
    createDate: new Date("2019-01-15T00:00:00Z"),
  });

  // HubSpot has no account-level email field at all, which is exactly why
  // contact harvesting exists. Mixed case on purpose: normalization is what
  // makes this the *same* key as Stripe's, and without it HubSpot would sit in
  // its own account holding an address that looks different only to a computer.
  await tenant.contact("hubspot", "hs-c-1", {
    email: "Billing@Acme.example",
    customerId: hubspotCompany,
  });

  await tenant.customer("metrifox", "m-1", { name: "Acme", email: "billing@acme.example" });

  // A second company, so "one account" is a grouping rather than a floor.
  await tenant.customer("stripe", "cus_2", {
    name: "Northwind",
    email: "ap@northwind.example",
  });

  return tenant;
}

describe("three connections, one company", () => {
  it("groups all three members and leaves the other company alone", async () => {
    const tenant = await converged();

    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(outcome.status).toBe("success");
    expect(outcome.issues).toEqual([]);
    expect(await tenant.groups()).toEqual([
      ["12345", "cus_1", "m-1"],
      ["cus_2"],
    ]);
  });

  it("resolves each field from the source that actually supplies it", async () => {
    const tenant = await converged();
    await resolveIdentities(tenant.userId, "manual");

    const [acme] = await tenant.accounts();
    if (acme === undefined) throw new Error("no account");

    // Stripe outranks everything and wins the name and the email. It carries
    // no industry, domain or type, and does not blank them.
    expect(acme.name).toBe("Acme Corp");
    expect(acme.email).toBe("billing@acme.example");
    expect(acme.industry).toBe("Manufacturing");
    expect(acme.domain).toBe("acme.example");

    expect(acme.fieldProvenance["name"]?.integrationId).toBe(
      tenant.integrationId("stripe")
    );
    expect(acme.fieldProvenance["industry"]?.integrationId).toBe(
      tenant.integrationId("hubspot")
    );
    expect(acme.fieldProvenance["email"]?.integrationId).toBe(
      tenant.integrationId("stripe")
    );
  });

  it("indexes exactly the keys the three members can supply", async () => {
    const tenant = await converged();
    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.keyValues()).toEqual([
      // From HubSpot's mapped `domain` column, never derived from an address.
      "domain:acme.example",
      "email:ap@northwind.example",
      // One key, though three records supplied it — Stripe's own field, the
      // HubSpot contact's, and Metrifox's.
      "email:billing@acme.example",
      // Self-keys, each scoped by its connection. HubSpot's portal id and
      // Metrifox's account id come from the token metadata; Stripe's segment is
      // empty because Stripe ids are globally unique.
      "external_ref:hubspot:portal-1:12345",
      "external_ref:metrifox:acct-9:m-1",
      "external_ref:stripe::cus_1",
      "external_ref:stripe::cus_2",
    ]);
  });

  it("counts what it did, and reports the run", async () => {
    const tenant = await converged();
    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(outcome.counts).toEqual({
      accountsCreated: 2,
      accountsAbsorbed: 0,
      accountsReaped: 0,
      customersLinked: 4,
      keysIndexed: 7,
    });

    const runs = await listResolutionRuns(tenant.userId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(outcome.runId);
    expect(runs[0]?.status).toBe("success");
    expect(runs[0]?.trigger).toBe("manual");
    expect(runs[0]?.completedAt).not.toBeNull();
  });
});

describe("a second pass over unchanged data", () => {
  it("inserts nothing, and says it inserted nothing", async () => {
    const tenant = await converged();
    await resolveIdentities(tenant.userId, "manual");

    const before = await tenant.placements();
    const second = await resolveIdentities(tenant.userId, "manual");

    // Account ids, not just the shape of the grouping. A pass that reaped and
    // recreated the same partition would satisfy a shape check while orphaning
    // every row that references an account id.
    expect(await tenant.placements()).toEqual(before);

    expect(second.counts).toEqual({
      accountsCreated: 0,
      accountsAbsorbed: 0,
      accountsReaped: 0,
      customersLinked: 0,
      keysIndexed: 0,
    });
    expect(second.issues).toEqual([]);
    expect(second.status).toBe("success");
  });

  it("keeps both runs in the history, newest first", async () => {
    const tenant = await converged();
    await resolveIdentities(tenant.userId, "sync");
    await resolveIdentities(tenant.userId, "manual");

    const runs = await listResolutionRuns(tenant.userId);
    expect(runs.map((run) => run.trigger)).toEqual(["manual", "sync"]);
  });
});

describe("totality", () => {
  it("gives an account to a customer with nothing usable on it", async () => {
    const tenant = await makeIdentityTenant([
      // Tenant-scoped with no metadata, so not even a self-key is available.
      { provider: "hubspot" },
    ]);
    await tenant.customer("hubspot", "12345", { name: "Nameless Co" });

    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["12345"]]);
    // A singleton with no keys at all. The account exists so that everything
    // downstream can hang off `customerAccountId` without a null check.
    expect(await tenant.keyValues()).toEqual([]);
  });

  it("does not re-create that singleton on every pass", async () => {
    const tenant = await makeIdentityTenant([{ provider: "hubspot" }]);
    await tenant.customer("hubspot", "12345", { name: "Nameless Co" });

    await resolveIdentities(tenant.userId, "manual");
    const before = await tenant.placements();
    const second = await resolveIdentities(tenant.userId, "manual");

    // The keyless cluster matches nothing, so without a reuse rule it would be
    // handed a fresh account every pass and the old one reaped behind it,
    // churning ids that other tables are about to reference.
    expect(await tenant.placements()).toEqual(before);
    expect(second.counts.accountsCreated).toBe(0);
    expect(second.counts.accountsReaped).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("never joins two users' customers on a shared address", async () => {
    // The severe failure mode: not a missed join, which is visible and
    // recoverable, but one user's company data appearing under another's.
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    await mine.customer("stripe", "cus_mine", { email: "billing@shared.example" });

    const theirs = await makeIdentityTenant([{ provider: "stripe" }]);
    await theirs.customer("stripe", "cus_theirs", { email: "billing@shared.example" });

    await resolveIdentities(mine.userId, "manual");
    const outcome = await resolveIdentities(theirs.userId, "manual");

    expect(await mine.groups()).toEqual([["cus_mine"]]);
    expect(await theirs.groups()).toEqual([["cus_theirs"]]);
    // Each holds the address in its own right. Not a conflict — the unique is
    // per user, so neither claim is contesting the other.
    expect(await theirs.keyValues()).toContain("email:billing@shared.example");
    expect(outcome.issues).toEqual([]);
  });
});
