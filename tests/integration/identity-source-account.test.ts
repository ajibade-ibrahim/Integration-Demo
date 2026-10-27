/**
 * Where a key came from, and when that source stops being allowed to claim it.
 *
 * The matcher used to know only "this key exists" and "some integration wrote
 * it". That is not enough once a connection can be re-keyed: the old account's
 * keys would keep matching after the credential moved, and an explicit
 * disconnect would leave them behind until an account happened to be reaped.
 * These tests pin the addressability (account + record), freshness
 * (`lastSeenAt`), and the two retirement paths.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { recordSourceAccount } from "@/core/identity/source-account";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { finalizeConnection } from "@/core/integrations/connection";
import {
  deleteIntegration,
  findIntegration,
} from "@/core/repositories/integration-repository";
import { retireIdentityKeys } from "@/core/repositories/identity-repository";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

async function keysFor(integrationId: string) {
  return prisma.customerAccountKey.findMany({
    where: { sourceIntegrationId: integrationId },
    orderBy: [{ kind: "asc" }, { value: "asc" }],
  });
}

describe("the source account on a key", () => {
  it("is addressable, and carries the record that offered it", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });

    await resolveIdentities(tenant.userId, "manual");

    const keys = await keysFor(tenant.integrationId("salesforce"));
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "email",
          value: "billing@acme.example",
          sourceAccountId: "org-a",
          sourceRecordId: "001A",
        }),
        expect.objectContaining({
          kind: "external_ref",
          value: "salesforce:org-a:001A",
          sourceAccountId: "org-a",
          sourceRecordId: "001A",
        }),
      ])
    );
  });

  it("uses the stored account even when token metadata is stale", async () => {
    const tenant = await makeIdentityTenant([
      {
        provider: "salesforce",
        sourceAccountId: "org-stored",
        metadata: { organizationId: "org-old" },
      },
    ]);
    await tenant.customer("salesforce", "001A");

    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.keyValues()).toEqual([
      "external_ref:salesforce:org-stored:001A",
    ]);
  });

  it("keeps a contact's own id on a harvested address", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "hubspot", sourceAccountId: "portal-1" },
    ]);
    const company = await tenant.customer("hubspot", "12345");
    await tenant.contact("hubspot", "ct-1", {
      email: "dana@acme.example",
      customerId: company,
    });

    await resolveIdentities(tenant.userId, "manual");

    const contactKey = await prisma.customerAccountKey.findFirstOrThrow({
      where: {
        userId: tenant.userId,
        kind: "email",
        value: "dana@acme.example",
      },
    });
    expect(contactKey.sourceIntegrationId).toBe(
      tenant.integrationId("hubspot")
    );
    expect(contactKey.sourceAccountId).toBe("portal-1");
    expect(contactKey.sourceRecordId).toBe("ct-1");
  });
});

describe("re-keying an integration", () => {
  it("retires the old account's keys and records the new account", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await keysFor(tenant.integrationId("salesforce"))).toHaveLength(2);

    const change = await recordSourceAccount({
      integrationId: tenant.integrationId("salesforce"),
      sourceAccountId: "org-b",
    });

    expect(change).toMatchObject({
      previous: "org-a",
      current: "org-b",
      changed: true,
    });
    expect(change.retiredKeys).toBe(2);
    expect(await keysFor(tenant.integrationId("salesforce"))).toEqual([]);

    const integration = await findIntegration(
      tenant.integrationId("salesforce")
    );
    expect(integration?.sourceAccountId).toBe("org-b");
  });

  it("does not retire anything when the account did not change", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");

    const change = await recordSourceAccount({
      integrationId: tenant.integrationId("salesforce"),
      sourceAccountId: "org-a",
    });

    expect(change).toMatchObject({ changed: false, retiredKeys: 0 });
    expect(await keysFor(tenant.integrationId("salesforce"))).toHaveLength(2);
  });

  it("detects a move from keys when the column was never populated", async () => {
    // Connections made before `sourceAccountId` existed have no previous value
    // to compare, but their keys do. A different account still retires them.
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    await prisma.integration.update({
      where: { id: tenant.integrationId("salesforce") },
      data: { sourceAccountId: null },
    });

    const change = await recordSourceAccount({
      integrationId: tenant.integrationId("salesforce"),
      sourceAccountId: "org-b",
    });

    expect(change).toMatchObject({
      previous: "org-a",
      current: "org-b",
      changed: true,
    });
    expect(change.retiredKeys).toBe(2);
  });

  it("retires unscoped keys when first recording an account", async () => {
    // Keys from before the column cannot be proven to belong to the account
    // being recorded. A missing join is recoverable; a stale claim is not.
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    await prisma.integration.update({
      where: { id: tenant.integrationId("salesforce") },
      data: { sourceAccountId: null },
    });
    await prisma.customerAccountKey.updateMany({
      where: { sourceIntegrationId: tenant.integrationId("salesforce") },
      data: { sourceAccountId: null },
    });

    const change = await recordSourceAccount({
      integrationId: tenant.integrationId("salesforce"),
      sourceAccountId: "org-a",
    });

    expect(change).toMatchObject({ changed: true, retiredKeys: 2 });
    expect(await keysFor(tenant.integrationId("salesforce"))).toEqual([]);
  });

  it("fills in a legacy key when the same account re-offers it", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");
    await prisma.customerAccountKey.updateMany({
      where: { sourceIntegrationId: tenant.integrationId("salesforce") },
      data: { sourceAccountId: null, sourceRecordId: null },
    });

    await resolveIdentities(tenant.userId, "manual");

    const keys = await keysFor(tenant.integrationId("salesforce"));
    expect(keys.every((key) => key.sourceAccountId === "org-a")).toBe(true);
    expect(keys.every((key) => key.sourceRecordId === "001A")).toBe(true);
  });
});

describe("freshness", () => {
  it("moves lastSeenAt when a key is re-offered", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", sourceAccountId: "" },
    ]);
    await tenant.customer("stripe", "cus_1", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");

    const old = new Date("2020-01-01T00:00:00Z");
    const [before] = await keysFor(tenant.integrationId("stripe"));
    if (before === undefined) throw new Error("no key");
    await prisma.customerAccountKey.update({
      where: { id: before.id },
      data: { lastSeenAt: old },
    });

    await resolveIdentities(tenant.userId, "manual");

    const after = await prisma.customerAccountKey.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    // Re-observation is not first observation.
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
  });
});

describe("retiring a source", () => {
  it("removes only the named record's claims", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "hubspot", sourceAccountId: "portal-1" },
    ]);
    const company = await tenant.customer("hubspot", "12345", {
      email: "billing@acme.example",
    });
    await tenant.contact("hubspot", "ct-1", {
      email: "dana@acme.example",
      customerId: company,
    });
    await resolveIdentities(tenant.userId, "manual");

    const retired = await retireIdentityKeys({
      userId: tenant.userId,
      sourceIntegrationId: tenant.integrationId("hubspot"),
      sourceRecordId: "ct-1",
    });

    expect(retired).toBe(1);
    const remaining = await keysFor(tenant.integrationId("hubspot"));
    expect(remaining.map((key) => `${key.kind}:${key.value}`)).toEqual([
      "email:billing@acme.example",
      "external_ref:hubspot:portal-1:12345",
    ]);
  });

  it("drops a deleted integration's keys before the account is reaped", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");

    await deleteIntegration(tenant.integrationId("salesforce"));

    expect(await keysFor(tenant.integrationId("salesforce"))).toEqual([]);
  });
});

describe("connection finalization", () => {
  it("records the credential's source account without a reconnect", async () => {
    const tenant = await makeIdentityTenant([{ provider: "mock" }]);
    const integration = await findIntegration(tenant.integrationId("mock"));
    if (integration === undefined) throw new Error("no integration");

    await finalizeConnection(integration, new Date(), "acct-1");

    const after = await findIntegration(integration.id);
    expect(after?.sourceAccountId).toBe("acct-1");
  });

  it("does not treat an unknown account as a move", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "salesforce", sourceAccountId: "org-a" },
    ]);
    await tenant.customer("salesforce", "001A", {
      email: "billing@acme.example",
    });
    await resolveIdentities(tenant.userId, "manual");

    const change = await recordSourceAccount({
      integrationId: tenant.integrationId("salesforce"),
      sourceAccountId: null,
    });

    expect(change).toMatchObject({
      previous: "org-a",
      current: "org-a",
      changed: false,
      retiredKeys: 0,
    });
    expect(await keysFor(tenant.integrationId("salesforce"))).toHaveLength(2);
  });
});

