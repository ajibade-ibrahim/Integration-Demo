/**
 * What the Accounts tab is handed, and what the priority control does to it.
 *
 * Two things are being pinned here, and the second is the load-bearing one.
 *
 * **Provenance is complete.** Every non-null field on an account names the
 * source record, provider, evidence and observation time that supplied it, and
 * retains losing values with their reasons. Traceability is a stated
 * requirement, but the sharper reason is that the two correction actions are
 * unusable without it: a user cannot answer "is this the same company?" about a
 * merge they cannot see the evidence for.
 *
 * **Priority moves values, never membership.** This is the safety property the
 * whole design rests on. If reordering sources could repartition accounts, then
 * nudging a number to fix a company's displayed name would silently regroup
 * someone's customer list — so the test asserts the key set and the placements
 * are *identical*, not merely equivalent.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import {
  clampIdentityPriority,
  DEFAULT_IDENTITY_PRIORITY,
  updateIdentityPriority,
} from "@/core/repositories/integration-repository";
import { upsertAssertion } from "@/core/repositories/identity-repository";
import {
  loadAssertionsForDisplay,
  loadCustomerAccounts,
} from "@/core/repositories/synced-data-repository";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant, type IdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

/**
 * One company seen by two sources that carry different fields.
 *
 * Modelled on the real coverage gap: Stripe has an account-level email and no
 * domain, industry or type at all; a CRM has all three and no email. Neither
 * can be preferred wholesale without erasing something.
 */
async function oneCompanyTwoSources(): Promise<IdentityTenant> {
  const tenant = await makeIdentityTenant([
    { provider: "stripe", identityPriority: 100 },
    { provider: "mock", identityPriority: 100 },
  ]);

  await tenant.customer("stripe", "cus_1", {
    name: "Ridgeline Utilities Inc",
    email: "billing@ridgeline.example",
    createDate: new Date("2023-04-12T09:00:00.000Z"),
  });
  const crmCustomer = await tenant.customer("mock", "c-009", {
    name: "Ridgeline Utilities Group",
    domain: "ridgeline.example",
    industry: "Utilities",
    type: "customer",
    createDate: new Date("2021-10-04T08:30:00.000Z"),
  });
  // The mock has no account-level address, so this contact is what carries the
  // email key — exactly how a CRM reaches a payment processor in practice. It
  // has to be *linked*: a contact whose company did not resolve is deliberately
  // not evidence about any company, so an unlinked one would join nothing.
  await tenant.contact("mock", "p-022", {
    email: "billing@ridgeline.example",
    customerId: crmCustomer,
  });

  return tenant;
}

describe("what the Accounts tab reads", () => {
  it("returns one account carrying both sources' fields", async () => {
    const tenant = await oneCompanyTwoSources();
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);

    expect(account?.members.map((member) => member.externalSourceId)).toEqual([
      "c-009",
      "cus_1",
    ]);
    // A null is not an opinion. Stripe carries no domain, industry or type, so
    // it cannot win them by being ranked equal — each field is contested only
    // among the members that actually supply it.
    expect(account?.email).toBe("billing@ridgeline.example");
    expect(account?.domain).toBe("ridgeline.example");
    expect(account?.industry).toBe("Utilities");
  });

  it("names the winning source record and evidence for every non-null field", async () => {
    const tenant = await oneCompanyTwoSources();
    const observedAt = new Date("2025-06-01T12:00:00.000Z");
    await prisma.integration.updateMany({
      where: { userId: tenant.userId },
      data: { lastSyncTimestamp: observedAt },
    });
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);
    const stripe = tenant.integrationId("stripe");
    const mock = tenant.integrationId("mock");

    expect(account?.fieldProvenance["email"]).toMatchObject({
      integrationId: stripe,
      providerName: "stripe",
      externalSourceId: "cus_1",
      evidenceKey: "email",
      value: "billing@ridgeline.example",
      observedAt: observedAt.toISOString(),
    });
    expect(account?.fieldProvenance["domain"]).toMatchObject({
      integrationId: mock,
      providerName: "mock",
      externalSourceId: "c-009",
      evidenceKey: "domain",
      value: "ridgeline.example",
    });
    expect(account?.fieldProvenance["industry"]?.integrationId).toBe(mock);

    // The equal-priority name conflict keeps the losing value and its reason.
    const name = account?.fieldProvenance["name"];
    expect(name?.integrationId).toBe(mock);
    expect(name?.value).toBe("Ridgeline Utilities Group");
    expect(name?.alternatives).toEqual([
      expect.objectContaining({
        integrationId: stripe,
        externalSourceId: "cus_1",
        value: "Ridgeline Utilities Inc",
        reason: expect.stringMatching(/equal priority/i),
      }),
    ]);

    // Every id in provenance is one of the members, which is what makes the
    // provider chip renderable at all — the page looks the label up from the
    // member list rather than fetching integrations separately.
    const memberIds = new Set(
      account?.members.map((member) => member.integrationId) ?? []
    );
    for (const provenance of Object.values(account?.fieldProvenance ?? {})) {
      expect(memberIds.has(provenance.integrationId)).toBe(true);
      expect(provenance.customerId).toBeDefined();
      expect(provenance.observedAt).toBe(observedAt.toISOString());
    }
  });

  it("carries the keys the grouping was made on", async () => {
    const tenant = await oneCompanyTwoSources();
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);

    // The answer to "why are these one company?". A merge nobody can explain is
    // one nobody can trust enough to correct.
    expect(
      account?.keys.filter((key) => key.kind === "email").map((key) => key.rawValue)
    ).toEqual(["billing@ridgeline.example"]);
    expect(account?.keys.some((key) => key.kind === "domain")).toBe(true);
  });

  it("stores per-key provenance for custom fields", async () => {
    const tenant = await makeIdentityTenant([{ provider: "mock" }]);
    await tenant.customer("mock", "c-1", {
      name: "Acme",
      customFields: { tier: "gold" },
    });
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);

    expect(account?.customFields).toEqual({ tier: "gold" });
    expect(account?.fieldProvenance["customFields.tier"]).toMatchObject({
      integrationId: tenant.integrationId("mock"),
      externalSourceId: "c-1",
      evidenceKey: "customFields.tier",
      evidenceValue: "gold",
      value: "gold",
    });
  });

  it("normalizes an account resolved before provenance carried evidence", async () => {
    const tenant = await makeIdentityTenant([{ provider: "mock" }]);
    await tenant.customer("mock", "c-legacy", { name: "Legacy Co" });
    await resolveIdentities(tenant.userId, "manual");

    await prisma.customerAccount.updateMany({
      where: { userId: tenant.userId },
      data: {
        fieldProvenance: JSON.stringify({
          name: tenant.integrationId("mock"),
        }),
      },
    });

    const [account] = await loadCustomerAccounts(tenant.userId);
    expect(account?.fieldProvenance["name"]).toEqual({
      integrationId: tenant.integrationId("mock"),
    });
  });

  it("sorts by name, then by id", async () => {
    const tenant = await makeIdentityTenant([{ provider: "stripe" }]);
    await tenant.customer("stripe", "cus_b", { name: "Beta" });
    await tenant.customer("stripe", "cus_a", { name: "Alpha" });
    await resolveIdentities(tenant.userId, "manual");

    const accounts = await loadCustomerAccounts(tenant.userId);

    // The id tiebreak is not cosmetic: two accounts can genuinely resolve to
    // the same name, and without it the page reorders between renders of
    // unchanged data.
    expect(accounts.map((account) => account.name)).toEqual(["Alpha", "Beta"]);
  });

  it("shows nothing belonging to another tenant", async () => {
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    await mine.customer("stripe", "cus_mine", { name: "Mine" });
    const theirs = await makeIdentityTenant([{ provider: "stripe" }]);
    await theirs.customer("stripe", "cus_theirs", { name: "Theirs" });
    await resolveIdentities(mine.userId, "manual");
    await resolveIdentities(theirs.userId, "manual");

    const accounts = await loadCustomerAccounts(mine.userId);

    expect(accounts.map((account) => account.name)).toEqual(["Mine"]);
  });
});

describe("the assertion list", () => {
  it("names both records, so the undo is findable", async () => {
    const tenant = await oneCompanyTwoSources();
    await resolveIdentities(tenant.userId, "manual");
    const [account] = await loadCustomerAccounts(tenant.userId);
    const [first, second] = account?.members ?? [];

    await upsertAssertion({
      userId: tenant.userId,
      kind: "distinct",
      customerIdA: first?.id ?? "",
      customerIdB: second?.id ?? "",
      note: "Two subsidiaries, one billing address",
    });

    const [shown] = await loadAssertionsForDisplay(tenant.userId);

    // Nothing else on the page reveals that an assertion is in play — a `same`
    // group looks exactly like a successful match — so a verdict the user
    // cannot find is a grouping they cannot change.
    expect(shown?.kind).toBe("distinct");
    expect(shown?.note).toBe("Two subsidiaries, one billing address");
    expect([shown?.left.name, shown?.right.name].sort()).toEqual([
      "Ridgeline Utilities Group",
      "Ridgeline Utilities Inc",
    ]);
    expect(shown?.left.integrationLabel).not.toBe("");
  });
});

describe("the priority control", () => {
  it("clamps rather than rejecting, and defaults a non-number", () => {
    expect(clampIdentityPriority(1)).toBe(1);
    expect(clampIdentityPriority(0)).toBe(1);
    expect(clampIdentityPriority(5000)).toBe(1000);
    expect(clampIdentityPriority(12.4)).toBe(12);

    // The default, not 1. Falling back to the strongest rank would let a
    // malformed request quietly promote a source over every other.
    expect(clampIdentityPriority(Number.NaN)).toBe(DEFAULT_IDENTITY_PRIORITY);
  });

  it("changes which source wins a field", async () => {
    const tenant = await oneCompanyTwoSources();
    await resolveIdentities(tenant.userId, "manual");

    const before = (await loadCustomerAccounts(tenant.userId))[0];
    expect(before?.name).toBe("Ridgeline Utilities Group");

    await updateIdentityPriority(
      tenant.integrationId("stripe"),
      tenant.userId,
      1
    );
    await resolveIdentities(tenant.userId, "manual");

    const after = (await loadCustomerAccounts(tenant.userId))[0];
    expect(after?.name).toBe("Ridgeline Utilities Inc");
    expect(after?.fieldProvenance["name"]?.integrationId).toBe(
      tenant.integrationId("stripe")
    );
  });

  it("leaves membership and keys untouched when it does", async () => {
    const tenant = await oneCompanyTwoSources();
    await resolveIdentities(tenant.userId, "manual");
    const placements = await tenant.placements();
    const keys = await tenant.keyValues();

    await updateIdentityPriority(
      tenant.integrationId("stripe"),
      tenant.userId,
      1
    );
    await resolveIdentities(tenant.userId, "manual");

    // The safety property, asserted on identity rather than shape: the same
    // records on the same account, and the same key rows. If a rank could
    // repartition, then fixing a displayed name would silently regroup a
    // customer list — and nobody would connect the two.
    expect(await tenant.placements()).toEqual(placements);
    expect(await tenant.keyValues()).toEqual(keys);
  });

  it("still resolves a field the top-ranked source does not carry", async () => {
    const tenant = await oneCompanyTwoSources();
    await updateIdentityPriority(
      tenant.integrationId("stripe"),
      tenant.userId,
      1
    );
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);

    // The regression most worth pinning. Stripe now outranks everything and
    // carries no industry, domain or type — "the top source's row wins
    // wholesale" would blank all three on every account it touches.
    expect(account?.industry).toBe("Utilities");
    expect(account?.domain).toBe("ridgeline.example");
    expect(account?.type).toBe("customer");
  });

  it("takes the earliest createDate regardless of rank", async () => {
    const tenant = await oneCompanyTwoSources();
    await updateIdentityPriority(
      tenant.integrationId("stripe"),
      tenant.userId,
      1
    );
    await resolveIdentities(tenant.userId, "manual");

    const [account] = await loadCustomerAccounts(tenant.userId);

    // The one declared exception to precedence. If the CRM saw this company in
    // 2021 and Stripe in 2023, it existed in 2021 — whichever source is
    // trusted more for everything else.
    expect(account?.createDate?.toISOString()).toBe("2021-10-04T08:30:00.000Z");
  });

  it("refuses an integration belonging to someone else", async () => {
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    const theirs = await makeIdentityTenant([{ provider: "stripe" }]);

    expect(
      await updateIdentityPriority(
        theirs.integrationId("stripe"),
        mine.userId,
        1
      )
    ).toBe(false);
  });
});
