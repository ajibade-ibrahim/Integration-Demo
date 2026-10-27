/**
 * What happens after identity evidence is explicitly removed.
 *
 * The failure this pins is quiet in the UI: a deleted connection's keys are
 * gone, but the accounts it helped build keep saying fields it supplied, and a
 * surviving account is never recomputed from its remaining members. The tombstone
 * has to explain the removal without turning into a copy of the customer data.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { deleteIntegrationAndReassess } from "@/core/integrations/deletion";
import { withdrawImportedCrosswalk } from "@/core/identity/withdrawal";
import {
  importCrosswalk,
  listResolutionRuns,
} from "@/core/repositories/identity-repository";
import { findIdentityWithdrawalForUser } from "@/core/repositories/identity-withdrawal-repository";
import { loadIntegrationDeletionPreview } from "@/core/repositories/integration-repository";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("deleting an integration", () => {
  async function twoMemberAccount() {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a", identityPriority: 10 },
      {
        provider: "metrifox",
        sourceAccountId: "acct-1",
        identityPriority: 20,
      },
    ]);

    await tenant.customer("salesforce", "001A", {
      name: "Hidden Customer Name",
      email: "secret-contact@hidden.example",
      domain: "hidden.example",
      industry: "Software",
    });
    await tenant.customer("metrifox", "m-1", {
      name: "Acme from Metrifox",
      email: "secret-contact@hidden.example",
      industry: "SaaS",
    });

    await resolveIdentities(tenant.userId, "manual");
    const accounts = await tenant.accounts();
    expect(accounts).toHaveLength(1);

    return { tenant, accountId: accounts[0]!.id };
  }

  it("describes what the confirmation will remove before anything is deleted", async () => {
    const { tenant } = await twoMemberAccount();

    const preview = await loadIntegrationDeletionPreview(
      tenant.integrationId("salesforce")
    );

    expect(preview).toEqual({
      recordCount: 1,
      keyCount: 3,
      accountsRebuilt: 1,
      accountsRemoved: 0,
    });
  });

  it("rebuilds a surviving account from its remaining members", async () => {
    const { tenant, accountId } = await twoMemberAccount();
    const salesforceId = tenant.integrationId("salesforce");

    const outcome = await deleteIntegrationAndReassess(salesforceId);

    expect(outcome).toBeDefined();
    expect(outcome?.reassessed).toBe(true);
    expect(outcome?.affectedAccountIds).toContain(accountId);

    const accounts = await tenant.accounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: accountId,
      name: "Acme from Metrifox",
      industry: "SaaS",
      domain: null,
      members: ["m-1"],
    });

    const cited = Object.values(accounts[0]!.fieldProvenance).flatMap(
      (entry) => [
        entry.integrationId,
        ...(entry.alternatives ?? []).map(
          (alternative) => alternative.integrationId
        ),
      ]
    );
    expect(cited).not.toContain(salesforceId);

    const keys = await prisma.customerAccountKey.findMany({
      where: { userId: tenant.userId },
      select: { sourceIntegrationId: true, value: true },
    });
    expect(
      keys.some((key) => key.sourceIntegrationId === salesforceId)
    ).toBe(false);
    // The shared email was originally indexed from Salesforce because it had
    // the stronger priority. The pass must re-index it from the survivor.
    expect(await tenant.keyValues()).toEqual([
      "email:secret-contact@hidden.example",
      "external_ref:metrifox:acct-1:m-1",
    ]);
  });

  it("removes the deleted source from keys and provenance, and audits why", async () => {
    const { tenant } = await twoMemberAccount();
    const salesforceId = tenant.integrationId("salesforce");

    const outcome = await deleteIntegrationAndReassess(salesforceId);
    if (outcome?.auditId === null || outcome?.auditId === undefined) {
      throw new Error("expected a deletion audit");
    }

    expect(outcome.retiredKeys).toBeGreaterThan(0);
    expect(outcome.recordCount).toBe(1);

    const audit = await findIdentityWithdrawalForUser(
      tenant.userId,
      outcome.auditId,
      "integration_deleted"
    );
    expect(audit).toMatchObject({
      kind: "integration_deleted",
      providerName: "salesforce",
      removedRecords: 1,
      retiredKeys: outcome.retiredKeys,
      affectedAccountCount: 1,
      accountsReassessed: 1,
      accountsReaped: 0,
      status: "reassessed",
    });
    expect(audit?.removed.customers).toBe(1);
    expect(audit?.completedAt).not.toBeNull();

    const runs = await listResolutionRuns(tenant.userId);
    expect(runs[0]?.trigger).toBe("deletion");

    const raw = await prisma.identityWithdrawal.findUniqueOrThrow({
      where: { id: outcome.auditId },
    });
    const serialized = JSON.stringify(raw);
    // A tombstone explains the removal; it is not a second copy of the data.
    expect(serialized).not.toContain("Hidden Customer Name");
    expect(serialized).not.toContain("secret-contact@hidden.example");
    expect(serialized).not.toContain("hidden.example");
  });

  it("repairs keys left behind by a deletion from before the cleanup existed", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", sourceAccountId: "" },
    ]);
    await tenant.customer("stripe", "cus_1", {
      email: "billing@legacy.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.keyValues()).toHaveLength(2);

    // Bypass `deleteIntegration` to model an older deployment: the records and
    // integration are gone, but the key rows were never retired.
    await prisma.integration.delete({
      where: { id: tenant.integrationId("stripe") },
    });
    expect(await tenant.keyValues()).toHaveLength(2);

    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.keyValues()).toEqual([]);
    expect(await tenant.accounts()).toHaveLength(0);
  });

  it("reaps an account whose only member was deleted", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", sourceAccountId: "" },
    ]);
    await tenant.customer("stripe", "cus_1", {
      name: "Only Stripe",
      email: "billing@only-stripe.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.accounts()).toHaveLength(1);
    expect(
      await loadIntegrationDeletionPreview(tenant.integrationId("stripe"))
    ).toMatchObject({ accountsRebuilt: 0, accountsRemoved: 1 });

    const outcome = await deleteIntegrationAndReassess(
      tenant.integrationId("stripe")
    );

    expect(outcome).toBeDefined();
    expect(await tenant.accounts()).toHaveLength(0);
    expect(await tenant.keyValues()).toEqual([]);

    if (outcome?.auditId === null || outcome?.auditId === undefined) {
      throw new Error("expected a deletion audit");
    }
    const audit = await findIdentityWithdrawalForUser(
      tenant.userId,
      outcome.auditId,
      "integration_deleted"
    );
    expect(audit).toMatchObject({
      affectedAccountCount: 1,
      accountsReassessed: 0,
      accountsReaped: 1,
      status: "reassessed",
    });
  });
});

describe("withdrawing imported evidence", () => {
  async function importedCrosswalk() {
    const tenant = await makeIdentityTenant([
      { provider: "stripe" },
      { provider: "metrifox", metadata: { accountId: "acct-1" } },
    ]);

    await tenant.customer("stripe", "cus_tess", {
      name: "Tessellate (Stripe)",
      email: "finance@tessellate-labs.example",
    });
    await tenant.customer("metrifox", "TESSELLATE-010", {
      name: "Tessellate (Metrifox)",
      email: "ap@tessellate.example",
    });

    await importCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);

    return tenant;
  }

  it("leaves another provider's imported pair supplying its key", async () => {
    const tenant = await makeIdentityTenant([
      // Metrifox first so the imported keys exist before the foreign providers'
      // own self-keys claim the same `(kind, value)`.
      { provider: "stripe", identityPriority: 30 },
      { provider: "metrifox", metadata: { accountId: "acct-1" }, identityPriority: 10 },
      { provider: "hubspot", sourceAccountId: "portal-1", identityPriority: 20 },
    ]);
    await tenant.customer("stripe", "cus_tess", {
      name: "Tessellate (Stripe)",
      email: "finance@tessellate-labs.example",
    });
    await tenant.customer("metrifox", "TESSELLATE-010", {
      name: "Tessellate (Metrifox)",
      email: "ap@tessellate.example",
    });
    await tenant.customer("hubspot", "h-1", { name: "HubSpot record" });

    const base = {
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
    };
    await importCrosswalk({
      ...base,
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await importCrosswalk({
      ...base,
      foreignProvider: "hubspot",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "h-1" }],
    });
    await resolveIdentities(tenant.userId, "manual");

    const withdrawal = await withdrawImportedCrosswalk({
      ...base,
      foreignProvider: "stripe",
    });

    expect(withdrawal.retiredKeys).toBe(1);
    expect(
      await prisma.customerAccountKey.count({
        where: {
          userId: tenant.userId,
          source: "imported_crosswalk",
          value: { startsWith: "stripe:" },
        },
      })
    ).toBe(0);
    expect(
      await prisma.customerAccountKey.count({
        where: {
          userId: tenant.userId,
          source: "imported_crosswalk",
          value: { startsWith: "hubspot:" },
        },
      })
    ).toBe(1);
  });

  it("retires the withdrawn key immediately and records the withdrawal", async () => {
    const tenant = await importedCrosswalk();

    const withdrawal = await withdrawImportedCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
    });

    expect(withdrawal).toMatchObject({
      cleared: 1,
      retiredKeys: 1,
      reassessed: true,
    });
    expect(
      await prisma.customerAccountKey.count({
        where: {
          userId: tenant.userId,
          source: "imported_crosswalk",
          value: { startsWith: "stripe:" },
        },
      })
    ).toBe(0);
    // The pass does not split accounts on absent evidence; the withdrawal is
    // about stopping future supply, not retroactively deciding they are apart.
    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);

    if (withdrawal.auditId === null) {
      throw new Error("expected a withdrawal audit");
    }
    const audit = await findIdentityWithdrawalForUser(
      tenant.userId,
      withdrawal.auditId,
      "crosswalk_withdrawn"
    );
    expect(audit).toMatchObject({
      kind: "crosswalk_withdrawn",
      providerName: "metrifox",
      foreignProvider: "stripe",
      removedRecords: 0,
      retiredKeys: 1,
      status: "reassessed",
    });
    expect(audit?.removed.importedPairs).toBe(1);
  });
});
