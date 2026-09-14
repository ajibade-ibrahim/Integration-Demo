/**
 * Survivorship decides what an account *says about itself*. These tests are
 * mostly about the two ways that can go wrong destructively.
 *
 * The first is the one the plan calls the regression most worth pinning: a null
 * must never win. Stripe carries no industry, domain or type at all, so a
 * "top-ranked source's row wins wholesale" implementation would let a user rank
 * Stripe up and watch three fields empty out across every account it touches.
 *
 * The second is the safety property the whole design rests on: precedence
 * settles values and never membership. That half is asserted in the property
 * test, where the partition is actually observable; here we pin the fields.
 */

import { describe, expect, it } from "vitest";

import { rankMembers, resolveAccountFields } from "@/core/identity/survivorship";
import type { ResolutionCustomer } from "@/core/repositories/identity-repository";

/**
 * A member with everything null but a name — each test then fills in only the
 * fields it is actually about, which is also how the real providers behave.
 */
function member(
  overrides: Partial<ResolutionCustomer> & { id: string }
): ResolutionCustomer {
  return {
    integrationId: `int-${overrides.id}`,
    providerName: "mock",
    identityPriority: 100,
    instanceLabel: "Mock",
    externalSourceId: `ext-${overrides.id}`,
    name: "Acme",
    domain: null,
    email: null,
    industry: null,
    createDate: null,
    type: null,
    customFields: {},
    crossRefs: {},
    importedCrossRefs: {},
    providerMetadata: {},
    customerAccountId: null,
    contactEmails: [],
    ...overrides,
  };
}

const stripe = member({
  id: "c-stripe",
  integrationId: "int-stripe",
  providerName: "stripe",
  instanceLabel: "Stripe",
  identityPriority: 1,
  name: "Acme Corp",
  email: "billing@acme.example",
  createDate: new Date("2023-04-01T00:00:00Z"),
  type: null,
});

const hubspot = member({
  id: "c-hubspot",
  integrationId: "int-hubspot",
  providerName: "hubspot",
  instanceLabel: "HubSpot",
  identityPriority: 50,
  name: "Acme Manufacturing Inc",
  domain: "acme.example",
  industry: "Manufacturing",
  createDate: new Date("2019-01-15T00:00:00Z"),
  type: "customer",
});

describe("rankMembers", () => {
  it("orders by priority, then provider, then label, then id", () => {
    const a = member({ id: "a", providerName: "zeta", identityPriority: 5 });
    const b = member({ id: "b", providerName: "alpha", identityPriority: 5 });
    const c = member({ id: "c", providerName: "alpha", identityPriority: 1 });

    expect(rankMembers([a, b, c]).map((m) => m.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks a total tie on id, so the order cannot depend on input order", () => {
    const a = member({ id: "aaa" });
    const b = member({ id: "bbb" });

    expect(rankMembers([b, a]).map((m) => m.id)).toEqual(["aaa", "bbb"]);
    expect(rankMembers([a, b]).map((m) => m.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate its input", () => {
    const input = [member({ id: "b" }), member({ id: "a" })];
    rankMembers(input);
    expect(input.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("a null never wins", () => {
  it("resolves industry and type from HubSpot even with Stripe ranked first", () => {
    const { fields } = resolveAccountFields("acct-1", [stripe, hubspot]);

    // Stripe is priority 1 and carries neither field. If rank picked a whole
    // row, both of these would be null and the user would have destroyed their
    // own data by expressing a preference.
    expect(fields.industry).toBe("Manufacturing");
    expect(fields.type).toBe("customer");
    expect(fields.domain).toBe("acme.example");
  });

  it("composes per field: Stripe wins email, HubSpot wins industry", () => {
    const { fields } = resolveAccountFields("acct-1", [stripe, hubspot]);

    expect(fields.email).toBe("billing@acme.example");
    expect(fields.name).toBe("Acme Corp");
    expect(fields.industry).toBe("Manufacturing");
    expect(fields.fieldProvenance["email"]).toBe("int-stripe");
    expect(fields.fieldProvenance["industry"]).toBe("int-hubspot");
    expect(fields.fieldProvenance["name"]).toBe("int-stripe");
  });

  it("treats an empty string as no opinion, not as a value", () => {
    const blank = member({
      id: "c-blank",
      integrationId: "int-blank",
      identityPriority: 1,
      industry: "   ",
    });

    const { fields } = resolveAccountFields("acct-1", [blank, hubspot]);
    expect(fields.industry).toBe("Manufacturing");
    expect(fields.fieldProvenance["industry"]).toBe("int-hubspot");
  });

  it("leaves a field null when no member supplies it", () => {
    const { fields } = resolveAccountFields("acct-1", [stripe]);

    expect(fields.industry).toBeNull();
    expect(fields.domain).toBeNull();
    expect(fields.type).toBeNull();
    // And provenance names nothing, rather than crediting a source with a null.
    expect(fields.fieldProvenance["industry"]).toBeUndefined();
    expect(Object.keys(fields.fieldProvenance).sort()).toEqual([
      "createDate",
      "email",
      "name",
    ]);
  });
});

describe("createDate is the declared exception", () => {
  it("takes the earliest value, not the highest-priority one", () => {
    const { fields } = resolveAccountFields("acct-1", [stripe, hubspot]);

    // Stripe outranks HubSpot and saw the company in 2023, but it demonstrably
    // existed in 2019.
    expect(fields.createDate?.toISOString()).toBe("2019-01-15T00:00:00.000Z");
    expect(fields.fieldProvenance["createDate"]).toBe("int-hubspot");
  });

  it("raises no conflict issue when equal-priority dates differ", () => {
    const early = member({
      id: "a",
      integrationId: "int-a",
      createDate: new Date("2019-01-01T00:00:00Z"),
    });
    const late = member({
      id: "b",
      integrationId: "int-b",
      createDate: new Date("2024-01-01T00:00:00Z"),
    });

    const { fields, issues } = resolveAccountFields("acct-1", [late, early]);
    expect(fields.createDate?.toISOString()).toBe("2019-01-01T00:00:00.000Z");
    // Nothing for a human to prefer when the rule is "the oldest one".
    expect(issues).toEqual([]);
  });

  it("applies `earliest` to no other field", () => {
    const alphabeticallyFirst = member({
      id: "b",
      integrationId: "int-b",
      identityPriority: 50,
      industry: "Aerospace",
    });
    const higherRanked = member({
      id: "a",
      integrationId: "int-a",
      identityPriority: 10,
      industry: "Zoology",
    });

    const { fields } = resolveAccountFields("acct-1", [
      alphabeticallyFirst,
      higherRanked,
    ]);
    expect(fields.industry).toBe("Zoology");
  });
});

describe("equal priority is reported, not silently coin-flipped", () => {
  const a = member({
    id: "a",
    integrationId: "int-a",
    providerName: "alpha",
    industry: "Manufacturing",
  });
  const b = member({
    id: "b",
    integrationId: "int-b",
    providerName: "beta",
    industry: "Logistics",
  });

  it("raises exactly one field_conflict carrying both values and both sources", () => {
    const { issues } = resolveAccountFields("acct-1", [a, b]);

    const conflicts = issues.filter((i) => i.kind === "field_conflict");
    expect(conflicts).toHaveLength(1);

    const conflict = conflicts[0];
    if (conflict?.kind !== "field_conflict") throw new Error("wrong kind");
    expect(conflict.fieldName).toBe("industry");
    expect(conflict.accountId).toBe("acct-1");
    expect(conflict.values).toEqual(["Manufacturing", "Logistics"]);
    expect(conflict.integrationIds).toEqual(["int-a", "int-b"]);
  });

  it("still resolves deterministically, whatever the input order", () => {
    expect(resolveAccountFields("acct-1", [a, b]).fields.industry).toBe(
      "Manufacturing"
    );
    expect(resolveAccountFields("acct-1", [b, a]).fields.industry).toBe(
      "Manufacturing"
    );
  });

  it("raises nothing when equally ranked sources agree", () => {
    const agrees = member({
      id: "b",
      integrationId: "int-b",
      providerName: "beta",
      industry: "Manufacturing",
    });

    const { issues } = resolveAccountFields("acct-1", [a, agrees]);
    expect(issues).toEqual([]);
  });

  it("raises nothing when the disagreeing source is ranked lower", () => {
    const lower = member({
      id: "b",
      integrationId: "int-b",
      identityPriority: 500,
      industry: "Logistics",
    });

    const { issues } = resolveAccountFields("acct-1", [a, lower]);
    expect(issues).toEqual([]);
  });

  it("does not count a null as a disagreement", () => {
    const silent = member({ id: "b", integrationId: "int-b", industry: null });

    const { fields, issues } = resolveAccountFields("acct-1", [a, silent]);
    expect(fields.industry).toBe("Manufacturing");
    expect(issues).toEqual([]);
  });
});

describe("custom fields", () => {
  it("unions across members, higher priority winning a shared key", () => {
    const high = member({
      id: "a",
      identityPriority: 1,
      customFields: { tier: "gold", region: "emea" },
    });
    const low = member({
      id: "b",
      identityPriority: 50,
      customFields: { tier: "silver", segment: "smb" },
    });

    const { fields } = resolveAccountFields("acct-1", [low, high]);
    expect(fields.customFields).toEqual({
      region: "emea",
      segment: "smb",
      tier: "gold",
    });
  });

  it("ignores an empty value rather than letting it win a key", () => {
    const high = member({ id: "a", identityPriority: 1, customFields: { tier: "" } });
    const low = member({ id: "b", identityPriority: 50, customFields: { tier: "silver" } });

    expect(resolveAccountFields("acct-1", [high, low]).fields.customFields).toEqual({
      tier: "silver",
    });
  });

  it("caps at MAX_CUSTOM_FIELDS by key order, not by member order", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${String(i).padStart(2, "0")}`, "v"])
    );
    const { fields } = resolveAccountFields("acct-1", [
      member({ id: "a", customFields: many }),
    ]);

    const keys = Object.keys(fields.customFields);
    expect(keys).toHaveLength(50);
    expect(keys[0]).toBe("k00");
    expect(keys[49]).toBe("k49");
  });
});

describe("changing priority changes values only", () => {
  it("flips the resolved name without touching which fields exist", () => {
    const stripeFirst = resolveAccountFields("acct-1", [stripe, hubspot]).fields;
    const hubspotFirst = resolveAccountFields("acct-1", [
      { ...stripe, identityPriority: 900 },
      hubspot,
    ]).fields;

    expect(stripeFirst.name).toBe("Acme Corp");
    expect(hubspotFirst.name).toBe("Acme Manufacturing Inc");

    // Everything only one source supplies is unmoved by the reordering — the
    // hierarchy composes per field rather than swapping a winning row.
    expect(hubspotFirst.email).toBe(stripeFirst.email);
    expect(hubspotFirst.industry).toBe(stripeFirst.industry);
    expect(hubspotFirst.createDate).toEqual(stripeFirst.createDate);
  });
});

describe("an account with no members", () => {
  it("throws rather than inventing a golden record", () => {
    // The pass reaps these instead of asking, so reaching here is a bug in the
    // caller and a silent empty account would be worse than a stack trace.
    expect(() => resolveAccountFields("acct-1", [])).toThrow(/no members/);
  });
});
