/**
 * What one customer row can be matched on.
 *
 * Almost every assertion here is about something the module refuses to emit.
 * That is the right shape for the test file, because the two outcomes are not
 * equally bad: a missing key costs a join the user can make by hand, while a
 * wrong key merges two companies — and if the scope segment is wrong, possibly
 * two tenants' companies — while looking exactly like the matcher working.
 *
 * `bootstrap()` runs because scope is a property of the provider definition,
 * read from the registry rather than duplicated here.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import { buildEvidence, buildForeignScopes } from "@/core/identity/evidence";
import type { ResolutionCustomer } from "@/core/repositories/identity-repository";

function customer(
  overrides: Partial<ResolutionCustomer> & { id: string }
): ResolutionCustomer {
  return {
    integrationId: `int-${overrides.id}`,
    providerName: "stripe",
    identityPriority: 100,
    instanceLabel: "Stripe",
    externalSourceId: `cus_${overrides.id}`,
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

const NO_SCOPES = new Map<string, string>();

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("self-reference", () => {
  it("is emitted for a globally scoped provider with an empty scope segment", () => {
    const keys = buildEvidence(
      customer({ id: "a", providerName: "stripe", externalSourceId: "cus_123" }),
      NO_SCOPES
    );

    const self = keys.find((k) => k.source === "self_reference");
    expect(self?.kind).toBe("external_ref");
    expect(self?.value).toBe("stripe::cus_123");
    // The raw id is what a user recognises; the composed value never shows.
    expect(self?.rawValue).toBe("cus_123");
  });

  it("is NOT emitted for a tenant-scoped provider with no scope value", () => {
    // HubSpot's portal id is not in its token response, so it emits no
    // self-key. Correct rather than broken: `hubspot::12345` would merge
    // company 12345 in one portal with a different company 12345 in another.
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "hubspot",
        externalSourceId: "12345",
        providerMetadata: {},
      }),
      NO_SCOPES
    );

    expect(keys.filter((k) => k.kind === "external_ref")).toEqual([]);
  });

  it("is emitted for a tenant-scoped provider once the scope is available", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "hubspot",
        externalSourceId: "12345",
        providerMetadata: { hubId: "portal-9" },
      }),
      NO_SCOPES
    );

    expect(keys.find((k) => k.source === "self_reference")?.value).toBe(
      "hubspot:portal-9:12345"
    );
  });

  it("gives two portals holding the same id two different keys", () => {
    // The false merge the scope segment exists to prevent.
    const one = buildEvidence(
      customer({
        id: "a",
        providerName: "hubspot",
        externalSourceId: "12345",
        providerMetadata: { hubId: "portal-1" },
      }),
      NO_SCOPES
    );
    const two = buildEvidence(
      customer({
        id: "b",
        providerName: "hubspot",
        externalSourceId: "12345",
        providerMetadata: { hubId: "portal-2" },
      }),
      NO_SCOPES
    );

    expect(one[0]?.value).not.toBe(two[0]?.value);
  });

  it("is skipped for a provider that is not registered at all", () => {
    const keys = buildEvidence(
      customer({ id: "a", providerName: "gone", email: "a@acme.example" }),
      NO_SCOPES
    );

    expect(keys.map((k) => k.kind)).toEqual(["email"]);
  });
});

describe("buildForeignScopes", () => {
  it("maps a global provider to an empty scope, however many connections", () => {
    const scopes = buildForeignScopes([
      customer({ id: "a", providerName: "stripe", integrationId: "int-1" }),
      customer({ id: "b", providerName: "stripe", integrationId: "int-2" }),
    ]);

    expect(scopes.get("stripe")).toBe("");
  });

  it("maps a tenant provider with exactly one connection", () => {
    const scopes = buildForeignScopes([
      customer({
        id: "a",
        providerName: "hubspot",
        integrationId: "int-1",
        providerMetadata: { hubId: "portal-1" },
      }),
    ]);

    expect(scopes.get("hubspot")).toBe("portal-1");
  });

  it("refuses a tenant provider with two connections", () => {
    // "This company is 12345 in HubSpot" does not identify a company when two
    // portals are connected, and guessing one is the false merge again.
    const scopes = buildForeignScopes([
      customer({
        id: "a",
        providerName: "hubspot",
        integrationId: "int-1",
        providerMetadata: { hubId: "portal-1" },
      }),
      customer({
        id: "b",
        providerName: "hubspot",
        integrationId: "int-2",
        providerMetadata: { hubId: "portal-2" },
      }),
    ]);

    expect(scopes.has("hubspot")).toBe(false);
  });

  it("refuses a tenant provider whose scope value is unavailable", () => {
    const scopes = buildForeignScopes([
      customer({ id: "a", providerName: "hubspot", providerMetadata: {} }),
    ]);

    expect(scopes.has("hubspot")).toBe(false);
  });
});

describe("cross-references", () => {
  it("names the foreign provider's id, not its own", () => {
    // The `payments_stripe_customers` case: a Metrifox customer that knows its
    // Stripe id, with no email or domain overlap involved at all.
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "metrifox",
        externalSourceId: "mf-1",
        providerMetadata: {},
        crossRefs: { stripe: "cus_999" },
      }),
      new Map([["stripe", ""]])
    );

    const crossRef = keys.find((k) => k.source === "mapped_cross_ref");
    expect(crossRef?.value).toBe("stripe::cus_999");
    expect(crossRef?.rawValue).toBe("cus_999");
  });

  it("matches the self-key the Stripe customer itself emits", () => {
    const metrifox = buildEvidence(
      customer({
        id: "a",
        providerName: "metrifox",
        providerMetadata: {},
        crossRefs: { stripe: "cus_999" },
      }),
      new Map([["stripe", ""]])
    );
    const stripe = buildEvidence(
      customer({ id: "b", providerName: "stripe", externalSourceId: "cus_999" }),
      new Map([["stripe", ""]])
    );

    // Byte-identical values are the entire join.
    expect(metrifox.find((k) => k.source === "mapped_cross_ref")?.value).toBe(
      stripe.find((k) => k.source === "self_reference")?.value
    );
  });

  it("is dropped when the foreign provider's scope is ambiguous", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "metrifox",
        providerMetadata: {},
        crossRefs: { hubspot: "12345" },
      }),
      NO_SCOPES
    );

    expect(keys.filter((k) => k.source === "mapped_cross_ref")).toEqual([]);
  });

  it("emits in sorted provider order, not JSON key order", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "metrifox",
        providerMetadata: {},
        crossRefs: { stripe: "cus_1", mock: "c-003" },
      }),
      new Map([
        ["stripe", ""],
        ["mock", ""],
      ])
    );

    expect(
      keys.filter((k) => k.source === "mapped_cross_ref").map((k) => k.value)
    ).toEqual(["mock::c-003", "stripe::cus_1"]);
  });

  it("drops an empty foreign id", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "metrifox",
        providerMetadata: {},
        crossRefs: { stripe: "  " },
      }),
      new Map([["stripe", ""]])
    );

    expect(keys.filter((k) => k.source === "mapped_cross_ref")).toEqual([]);
  });
});

describe("email keys", () => {
  it("normalizes the account email and keeps the raw form", () => {
    const keys = buildEvidence(
      customer({ id: "a", email: "  Dana+stripe@Acme.Example  " }),
      NO_SCOPES
    );

    const email = keys.find((k) => k.kind === "email");
    expect(email?.value).toBe("dana@acme.example");
    expect(email?.rawValue).toBe("  Dana+stripe@Acme.Example  ");
    expect(email?.source).toBe("customer_email");
  });

  it("reads the legacy custom fields until the retarget script has run", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        customFields: { primary_email: "billing@acme.example" },
      }),
      NO_SCOPES
    );

    const email = keys.find((k) => k.kind === "email");
    expect(email?.value).toBe("billing@acme.example");
    expect(email?.source).toBe("customer_custom_field");
  });

  it("harvests contact addresses, the only universal source", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        contactEmails: ["dana@acme.example", "sam@acme.example"],
      }),
      NO_SCOPES
    );

    expect(keys.filter((k) => k.kind === "email").map((k) => k.value)).toEqual([
      "dana@acme.example",
      "sam@acme.example",
    ]);
  });

  it("keeps a role address, which is what the spec seeds from", () => {
    const keys = buildEvidence(
      customer({ id: "a", email: "billing@acme.example" }),
      NO_SCOPES
    );

    expect(keys.find((k) => k.kind === "email")?.emailClass).toBe("role");
  });

  it("keeps a freemail address as an email key", () => {
    // The class stops a consumer host becoming a *domain* key; it does not
    // filter the address, which for a sole trader is the only evidence there is.
    const keys = buildEvidence(
      customer({ id: "a", email: "dana@gmail.com" }),
      NO_SCOPES
    );

    const email = keys.find((k) => k.kind === "email");
    expect(email?.value).toBe("dana@gmail.com");
    expect(email?.emailClass).toBe("freemail");
  });

  it("drops an unusable address rather than failing the record", () => {
    // "not-an-email" is mock fixture p-018; the dotless one is Metrifox's.
    for (const bad of ["not-an-email", "sasha.brenner@harbour", ""]) {
      const keys = buildEvidence(customer({ id: "a", email: bad }), NO_SCOPES);
      expect(keys.filter((k) => k.kind === "email")).toEqual([]);
    }
  });

  it("de-duplicates Stripe's synthesized contact without a branch for it", () => {
    // `synthesizeContact` copies the customer's own address onto a contact, so
    // it arrives as a duplicate and falls out of the dedupe. A branch naming
    // Stripe would be a branch that does nothing.
    const keys = buildEvidence(
      customer({
        id: "a",
        email: "billing@acme.example",
        contactEmails: ["Billing@Acme.example"],
      }),
      NO_SCOPES
    );

    const emails = keys.filter((k) => k.kind === "email");
    expect(emails).toHaveLength(1);
    // The stronger source keeps the label.
    expect(emails[0]?.source).toBe("customer_email");
  });
});

describe("domain keys", () => {
  it("comes from the mapped column and is classed corporate", () => {
    const keys = buildEvidence(
      customer({ id: "a", domain: "https://www.acme.example/pricing" }),
      NO_SCOPES
    );

    const domain = keys.find((k) => k.kind === "domain");
    // `domainFromUrl` strips the scheme, the path and a leading `www.`.
    expect(domain?.value).toBe("acme.example");
    expect(domain?.emailClass).toBe("corporate");
    expect(domain?.source).toBe("customer_domain");
  });

  it("refuses a blocklisted host", () => {
    for (const bad of ["gmail.com", "example.com", "localhost"]) {
      const keys = buildEvidence(customer({ id: "a", domain: bad }), NO_SCOPES);
      expect(keys.filter((k) => k.kind === "domain")).toEqual([]);
    }
  });

  it("is never derived from an email address", () => {
    // The structural guarantee: a customer with an address and no domain column
    // contributes no domain key, however corporate the host looks.
    const keys = buildEvidence(
      customer({ id: "a", email: "dana@acme.example" }),
      NO_SCOPES
    );

    expect(keys.filter((k) => k.kind === "domain")).toEqual([]);
  });
});

describe("emission order and totality", () => {
  it("emits strongest kind first", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        providerName: "stripe",
        externalSourceId: "cus_1",
        email: "dana@acme.example",
        domain: "acme.example",
      }),
      NO_SCOPES
    );

    expect(keys.map((k) => k.kind)).toEqual(["external_ref", "email", "domain"]);
  });

  it("stamps every key with the contributing integration", () => {
    const keys = buildEvidence(
      customer({
        id: "a",
        integrationId: "int-7",
        email: "dana@acme.example",
        domain: "acme.example",
      }),
      NO_SCOPES
    );

    expect(keys.every((k) => k.sourceIntegrationId === "int-7")).toBe(true);
  });

  it("returns an empty list for a record with nothing usable", () => {
    // Not an error. The pass gives this customer a singleton account, which is
    // how every row ends up linked.
    const keys = buildEvidence(
      customer({ id: "a", providerName: "hubspot", providerMetadata: {} }),
      NO_SCOPES
    );

    expect(keys).toEqual([]);
  });

  it("is a pure function of its input", () => {
    const input = customer({
      id: "a",
      email: "dana@acme.example",
      domain: "acme.example",
    });

    expect(buildEvidence(input, NO_SCOPES)).toEqual(
      buildEvidence(input, NO_SCOPES)
    );
  });
});
