/**
 * Multi-function integrations: one connection serving several functions.
 *
 * Exercises the real registered providers rather than generated ones, because
 * the interesting behaviour is specific to how HubSpot and Salesforce differ.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import { functionRegistry } from "@/core/registries/function-registry";
import { getSyncHandler } from "@/core/registries/handler-registry";
import {
  functionNamesForProvider,
  missingScopes,
  providerNamesForFunction,
  providerNamesForFunctions,
  resolveScopes,
  scopesAreCovered,
} from "@/core/registries/function-registry";
import {
  HUBSPOT_AGREEMENT_SCOPES,
  HUBSPOT_IDENTITY_SCOPES,
  HUBSPOT_PROVIDER_NAME,
  HUBSPOT_SUPPORT_SCOPES,
} from "@/core/providers/hubspot/provider";
import {
  SALESFORCE_IDENTITY_SCOPES,
  SALESFORCE_PROVIDER_NAME,
} from "@/core/providers/salesforce/provider";
import { METRIFOX_PROVIDER_NAME } from "@/core/providers/metrifox/provider";
import { MOCK_PROVIDER_NAME } from "@/core/providers/mock/provider";
import { STRIPE_PROVIDER_NAME } from "@/core/providers/stripe/provider";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("scope union across functions", () => {
  it("unions HubSpot identity and support scopes into one request", () => {
    const scopes = resolveScopes(["identity", "support"], "hubspot");

    for (const scope of [...HUBSPOT_IDENTITY_SCOPES, ...HUBSPOT_SUPPORT_SCOPES]) {
      expect(scopes).toContain(scope);
    }
    expect(scopes).toHaveLength(
      new Set([...HUBSPOT_IDENTITY_SCOPES, ...HUBSPOT_SUPPORT_SCOPES]).size
    );
  });

  it("does not request ticket scopes for an identity-only integration", () => {
    const scopes = resolveScopes(["identity"], "hubspot");
    for (const scope of HUBSPOT_SUPPORT_SCOPES) {
      expect(scopes).not.toContain(scope);
    }
  });

  // Salesforce's `api` scope already spans Case, so adding support changes
  // nothing. Holding scopes per (function, provider) is what allows this.
  it("leaves the Salesforce request unchanged when support is added", () => {
    expect(resolveScopes(["identity", "support"], "salesforce")).toEqual(
      resolveScopes(["identity"], "salesforce")
    );
    expect(resolveScopes(["identity", "support"], "salesforce")).toEqual(
      [...SALESFORCE_IDENTITY_SCOPES].sort()
    );
  });

  it("deduplicates scopes shared between two functions", () => {
    const scopes = resolveScopes(["identity", "support"], "mock");
    expect(new Set(scopes).size).toBe(scopes.length);
    // Both mock functions declare crm.schemas.read; it must appear once.
    expect(scopes.filter((s) => s === "crm.schemas.read")).toHaveLength(1);
  });

  it("is order-independent", () => {
    expect(resolveScopes(["support", "identity"], "hubspot")).toEqual(
      resolveScopes(["identity", "support"], "hubspot")
    );
  });
});

describe("provider candidates for a function set", () => {
  it("offers only providers covering every selected function", () => {
    const both = providerNamesForFunctions(["identity", "support"]);
    expect(both).toContain("hubspot");
    expect(both).toContain("salesforce");
  });

  it("excludes a provider that covers only part of the set", () => {
    // Billing is mock-only, so pairing it with identity leaves just the mock.
    expect(providerNamesForFunctions(["identity", "billing"])).toEqual(["mock"]);
    // And a function with no providers at all empties the intersection.
    expect(providerNamesForFunctions(["identity", "usage"])).toEqual([]);
  });

  it("returns nothing when no function is selected", () => {
    expect(providerNamesForFunctions([])).toEqual([]);
  });

  it("reports HubSpot as serving both identity and support", () => {
    const functions = functionNamesForProvider("hubspot");
    expect(functions).toContain("identity");
    expect(functions).toContain("support");
  });

  it("lists no providers for a function nobody implements", () => {
    expect(providerNamesForFunction("usage")).toEqual([]);
  });
});

describe("re-consent detection when a function is added", () => {
  it("flags a widened scope requirement on HubSpot", () => {
    const granted = resolveScopes(["identity"], "hubspot");
    const required = resolveScopes(["identity", "support"], "hubspot");

    expect(scopesAreCovered(granted, required)).toBe(false);
    expect(missingScopes(granted, required).sort()).toEqual(
      [...HUBSPOT_SUPPORT_SCOPES].sort()
    );
  });

  it("does not flag Salesforce, whose grant already covers support", () => {
    const granted = resolveScopes(["identity"], "salesforce");
    const required = resolveScopes(["identity", "support"], "salesforce");

    expect(scopesAreCovered(granted, required)).toBe(true);
    expect(missingScopes(granted, required)).toEqual([]);
  });

  it("treats an unchanged function set as covered", () => {
    const scopes = resolveScopes(["identity"], "hubspot");
    expect(scopesAreCovered(scopes, scopes)).toBe(true);
  });

  it("treats an empty grant as covering nothing", () => {
    expect(scopesAreCovered([], resolveScopes(["identity"], "hubspot"))).toBe(
      false
    );
  });
});

describe("the agreement function", () => {
  it("is served by every connected provider", () => {
    // Breadth is the claim being made: one agreement model spanning a
    // sales-led Contract, a self-serve subscription, and both at once.
    expect(providerNamesForFunction("agreement")).toEqual([
      "hubspot",
      "metrifox",
      "mock",
      "salesforce",
      "stripe",
    ]);
  });

  it("widens the HubSpot request, because deals are a separate grant", () => {
    const granted = resolveScopes(["identity"], "hubspot");
    const required = resolveScopes(["identity", "agreement"], "hubspot");

    expect(scopesAreCovered(granted, required)).toBe(false);
    expect(missingScopes(granted, required).sort()).toEqual(
      [...HUBSPOT_AGREEMENT_SCOPES].sort()
    );
  });

  it("leaves the Salesforce request unchanged, as support does", () => {
    expect(resolveScopes(["identity", "agreement"], "salesforce")).toEqual(
      resolveScopes(["identity"], "salesforce")
    );
  });

  it("unions and deduplicates against identity on one connection", () => {
    const scopes = resolveScopes(["identity", "agreement"], "mock");
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.filter((s) => s === "crm.schemas.read")).toHaveLength(1);
    expect(scopes).toContain("crm.objects.deals.read");
  });

  it("does not leak deal access into an identity-only integration", () => {
    const scopes = resolveScopes(["identity"], "hubspot");
    for (const scope of HUBSPOT_AGREEMENT_SCOPES) {
      expect(scopes).not.toContain(scope);
    }
  });

  // A subscription is a specialization of agreement, not a sibling of invoice.
  // Declaring it under billing is what produces a "subscription table" that
  // order forms and amendments later have to be retrofitted onto, so this pins
  // the declaration rather than trusting a comment to survive.
  it("owns subscriptions, and billing does not", () => {
    expect(functionRegistry.require("agreement").dataModels).toEqual([
      "agreement",
      "subscription",
    ]);
    expect(functionRegistry.require("billing").dataModels).not.toContain(
      "subscription"
    );
  });

  // Built on Stripe, declared on the rest. The picker reads the handler
  // registry separately and offers a function as visibly unavailable per
  // provider, so this pins the boundary: one provider real, four still not.
  //
  // It is a list rather than a loop over every agreement provider, which is
  // what it used to be. A loop asserting "no handler anywhere" stops being a
  // statement about the unbuilt providers the moment one is built — it just
  // fails, and the fix looks like deleting the test. Naming them keeps the
  // assertion meaningful and makes the next provider a one-line change.
  it("is built on Stripe and on no other provider yet", () => {
    expect(getSyncHandler("agreement", STRIPE_PROVIDER_NAME)).toBeDefined();

    for (const provider of [
      HUBSPOT_PROVIDER_NAME,
      SALESFORCE_PROVIDER_NAME,
      METRIFOX_PROVIDER_NAME,
      MOCK_PROVIDER_NAME,
    ]) {
      expect(
        getSyncHandler("agreement", provider),
        `${provider} unexpectedly has an agreement handler`
      ).toBeUndefined();
    }

    // And every one of them is still offered in the picker, which is the point
    // of declaring scopes ahead of handlers.
    expect(providerNamesForFunction("agreement")).toContain(
      HUBSPOT_PROVIDER_NAME
    );
  });
});
