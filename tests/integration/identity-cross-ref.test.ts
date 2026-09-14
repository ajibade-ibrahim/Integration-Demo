/**
 * The deterministic join, and the false merge the scope segment prevents.
 *
 * `external_ref` exists for one case the spec names outright: a Metrifox
 * customer that knows its Stripe customer id. Two records with no shared
 * address and no shared domain are still, provably, one company — and no
 * heuristic could ever tell.
 *
 * The other half of this file is the reason that key kind is dangerous. HubSpot
 * object ids are portal-scoped: company `12345` exists in most portals and they
 * are unrelated businesses. An unscoped `hubspot:12345` would merge them, which
 * is the worst outcome the whole feature can produce, so the scoping is pinned
 * here in both of its forms — a scope that is available, and a scope that is
 * not.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";

import { makeIdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

describe("a customer naming another system's id", () => {
  it("joins it with no email or domain overlap at all", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "metrifox", identityPriority: 20, metadata: { accountId: "a-1" } },
    ]);

    // Nothing in common. Different names, no address on either, no website.
    await tenant.customer("stripe", "cus_p", { name: "ACME (billing)" });
    await tenant.customer("metrifox", "m-1", {
      name: "Acme Manufacturing",
      crossRefs: { stripe: "cus_p" },
    });

    const outcome = await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["cus_p", "m-1"]]);
    expect(outcome.issues).toEqual([]);
    // Two external references and not one inferred key between them.
    expect(await tenant.keyValues()).toEqual([
      "external_ref:metrifox:a-1:m-1",
      "external_ref:stripe::cus_p",
    ]);
  });

  it("joins in either arrival order", async () => {
    // The reference is indexed on the naming record's own account, so the
    // record it names joins when it turns up — which matters, because the whole
    // point of a cross-reference is that the other side may not be synced yet.
    const tenant = await makeIdentityTenant([
      { provider: "metrifox", identityPriority: 10, metadata: { accountId: "a-1" } },
      { provider: "stripe", identityPriority: 20 },
    ]);

    await tenant.customer("metrifox", "m-1", {
      name: "Acme Manufacturing",
      crossRefs: { stripe: "cus_p" },
    });
    await resolveIdentities(tenant.userId, "manual");

    // Stripe is connected later and brings in the customer being named.
    await tenant.customer("stripe", "cus_p", { name: "ACME (billing)" });
    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["cus_p", "m-1"]]);
  });

  it("outranks a conflicting email match", async () => {
    const tenant = await makeIdentityTenant([
      { provider: "stripe", identityPriority: 10 },
      { provider: "metrifox", identityPriority: 20, metadata: { accountId: "a-1" } },
      { provider: "mock", identityPriority: 30 },
    ]);

    await tenant.customer("stripe", "cus_p", { name: "ACME (billing)" });
    await tenant.customer("metrifox", "m-1", { email: "ap@shared.example" });
    await resolveIdentities(tenant.userId, "manual");

    // Names the Stripe customer *and* carries the address the Metrifox record
    // already claimed. A hard foreign id beats an inferred address.
    await tenant.customer("mock", "c-1", {
      email: "ap@shared.example",
      crossRefs: { stripe: "cus_p" },
    });

    const outcome = await resolveIdentities(tenant.userId, "manual");
    const placements = await tenant.placements();

    expect(placements.get("c-1")).toBe(placements.get("cus_p"));
    expect(placements.get("c-1")).not.toBe(placements.get("m-1"));

    const issue = outcome.issues[0];
    if (issue?.kind !== "key_claimed_elsewhere") {
      throw new Error(`expected a key conflict, got ${issue?.kind}`);
    }
    expect(issue.keyKind).toBe("email");
    expect(issue.losingAccountIds).toEqual([placements.get("m-1")]);
  });
});

describe("two portals of the same provider", () => {
  it("does not merge two companies that share an object id", async () => {
    // The highest-value assertion in the suite. HubSpot company ids are
    // per-portal integers, so `12345` in two portals is two unrelated
    // businesses — and merging them would compose their names, addresses and
    // industries into one record with no undo.
    const tenant = await makeIdentityTenant([
      { provider: "hubspot", key: "hs1", metadata: { hubId: "portal-1" } },
      { provider: "hubspot", key: "hs2", metadata: { hubId: "portal-2" } },
    ]);

    await tenant.customer("hs1", "12345", { name: "Acme Manufacturing" });
    await tenant.customer("hs2", "12345", { name: "Ridgeline Freight" });

    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.accounts()).toHaveLength(2);
    expect(await tenant.keyValues()).toEqual([
      "external_ref:hubspot:portal-1:12345",
      "external_ref:hubspot:portal-2:12345",
    ]);
  });

  it("emits no self-key at all when the scope is unavailable", async () => {
    // HubSpot's token response carries no `hub_id`, so today this is the real
    // case rather than a hypothetical one. Fail closed: no key beats a key that
    // would have been `hubspot::12345` for both of these.
    const tenant = await makeIdentityTenant([
      { provider: "hubspot", key: "hs1" },
      { provider: "hubspot", key: "hs2" },
    ]);

    await tenant.customer("hs1", "12345", { name: "Acme Manufacturing" });
    await tenant.customer("hs2", "12345", { name: "Ridgeline Freight" });

    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.accounts()).toHaveLength(2);
    expect(await tenant.keyValues()).toEqual([]);
  });

  it("refuses a cross-reference it cannot scope", async () => {
    // "This company is 12345 in HubSpot" does not identify a company when two
    // portals are connected. Guessing one would be the same false merge by
    // another route, so the reference contributes nothing.
    //
    // Ambiguity is judged from the customers in the tenant, which is what the
    // pass can see: a second portal that is connected but has synced nothing
    // yet does not make a reference ambiguous, and the reference will stay
    // pointed at the portal it resolved to.
    const tenant = await makeIdentityTenant([
      { provider: "hubspot", key: "hs1", metadata: { hubId: "portal-1" } },
      { provider: "hubspot", key: "hs2", metadata: { hubId: "portal-2" } },
      { provider: "mock", key: "mock" },
    ]);

    await tenant.customer("hs1", "12345", { name: "Acme Manufacturing" });
    await tenant.customer("hs2", "67890", { name: "Ridgeline Freight" });
    await tenant.customer("mock", "c-1", {
      name: "Acme",
      crossRefs: { hubspot: "12345" },
    });

    await resolveIdentities(tenant.userId, "manual");
    const placements = await tenant.placements();

    expect(placements.get("c-1")).not.toBe(placements.get("12345"));
    expect(await tenant.accounts()).toHaveLength(3);
    // Only the two portals' own self-keys, plus the mock's. Nothing derived
    // from the unscopeable reference.
    expect(await tenant.keyValues()).toEqual([
      "external_ref:hubspot:portal-1:12345",
      "external_ref:hubspot:portal-2:67890",
      "external_ref:mock::c-1",
    ]);
  });
});
