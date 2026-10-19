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
import {
  STRIPE_BILLING_SCOPES,
  STRIPE_PROVIDER_NAME,
} from "@/core/providers/stripe/provider";
import { CHARGEBEE_PROVIDER_NAME } from "@/core/providers/chargebee/provider";
import { STIGG_PROVIDER_NAME } from "@/core/providers/stigg/provider";

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
    // Billing is built on Stripe and Chargebee and declared on the mock, so
    // pairing it with identity leaves exactly those three — HubSpot, Salesforce
    // and Metrifox have identity but no billing scope, and the whole-set rule
    // is why they drop out.
    expect(providerNamesForFunctions(["identity", "billing"])).toEqual([
      "chargebee",
      "mock",
      "stripe",
    ]);
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
      "chargebee",
      "hubspot",
      "metrifox",
      "mock",
      "salesforce",
      "stigg",
      "stripe",
    ]);
  });

  it("widens the HubSpot request, because deals are a separate grant", () => {
    const granted = resolveScopes(["identity"], "hubspot");
    const required = resolveScopes(["identity", "agreement"], "hubspot");

    expect(scopesAreCovered(granted, required)).toBe(false);

    // Companies is shared with identity, so the widening is every agreement
    // scope identity did not already grant — deals, line items and their
    // schemas.
    expect(HUBSPOT_AGREEMENT_SCOPES).toContain("crm.objects.line_items.read");
    expect(HUBSPOT_AGREEMENT_SCOPES).toContain("crm.schemas.line_items.read");
    const alreadyGranted = new Set<string>(HUBSPOT_IDENTITY_SCOPES);
    expect(missingScopes(granted, required).sort()).toEqual(
      HUBSPOT_AGREEMENT_SCOPES.filter(
        (scope) => !alreadyGranted.has(scope)
      ).sort()
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

  it("does not leak deal or line-item access into an identity-only integration", () => {
    const scopes = resolveScopes(["identity"], "hubspot");
    expect(scopes).not.toContain("crm.objects.deals.read");
    expect(scopes).not.toContain("crm.schemas.deals.read");
    expect(scopes).not.toContain("crm.objects.line_items.read");
    expect(scopes).not.toContain("crm.schemas.line_items.read");
  });

  // A subscription is a specialization of agreement, not a sibling of invoice.
  // Declaring it under billing is what produces a "subscription table" that
  // order forms and amendments later have to be retrofitted onto, so this pins
  // the declaration rather than trusting a comment to survive.
  it("owns subscriptions and their lines, and billing does not", () => {
    expect(functionRegistry.require("agreement").dataModels).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
      "agreementEntitlement",
      "agreementDiscount",
    ]);
    expect(functionRegistry.require("billing").dataModels).not.toContain(
      "subscription"
    );
    // Named `agreementItem` rather than `subscriptionItem` for the same
    // reason: a line belongs to every agreement type — ContractLineItem,
    // OrderItem, a HubSpot deal's line items — and naming it after the one
    // type with a handler today is the discriminator mistake this function
    // was built to avoid.
    expect(functionRegistry.require("agreement").dataModels).not.toContain(
      "subscriptionItem"
    );
  });

  // Built on Stripe, Chargebee, Stigg and HubSpot; declared on the rest. The
  // picker reads the handler registry separately and offers a function as
  // visibly unavailable per provider, so this pins the boundary: four providers
  // real, three still not.
  //
  // It is a list rather than a loop over every agreement provider, which is
  // what it used to be. A loop asserting "no handler anywhere" stops being a
  // statement about the unbuilt providers the moment one is built — it just
  // fails, and the fix looks like deleting the test. Naming them keeps the
  // assertion meaningful and makes the next provider a one-line change.
  it("is built on Stripe, Chargebee, Stigg and HubSpot, and on no other provider yet", () => {
    expect(getSyncHandler("agreement", STRIPE_PROVIDER_NAME)).toBeDefined();
    expect(getSyncHandler("agreement", CHARGEBEE_PROVIDER_NAME)).toBeDefined();
    expect(getSyncHandler("agreement", STIGG_PROVIDER_NAME)).toBeDefined();
    expect(getSyncHandler("agreement", HUBSPOT_PROVIDER_NAME)).toBeDefined();

    for (const provider of [
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

describe("the billing function", () => {
  it("is served by the providers that ship it, in registry order", () => {
    // The agreement test's sort proof, one function over: the registry sorts,
    // so the expectation is alphabetical rather than insertion order.
    expect(providerNamesForFunction("billing")).toEqual([
      "chargebee",
      "mock",
      "stripe",
    ]);
  });

  it("owns invoices, their lines and payments, and not subscriptions or charge", () => {
    expect(functionRegistry.require("billing").dataModels).toEqual([
      "invoice",
      "invoiceLine",
      "payment",
    ]);
    // The other half of the decision pinned above: a subscription is an
    // agreement specialization while an invoice is a bill, so neither function
    // may hold the other's table. And `charge` is absent deliberately — the
    // word means three incompatible things across these providers, and what it
    // used to stand in for is `invoiceLine`.
    expect(functionRegistry.require("billing").dataModels).not.toContain(
      "subscription"
    );
    expect(functionRegistry.require("billing").dataModels).not.toContain(
      "charge"
    );
  });

  it("is built on Stripe and Chargebee and on no other provider yet", () => {
    // A named list rather than a loop, for the reason the agreement twin gives:
    // a loop over every billing provider stops testing the unbuilt ones the
    // moment one is built, and the fix then looks like deleting the test.
    expect(getSyncHandler("billing", STRIPE_PROVIDER_NAME)).toBeDefined();
    expect(getSyncHandler("billing", CHARGEBEE_PROVIDER_NAME)).toBeDefined();

    for (const provider of [
      HUBSPOT_PROVIDER_NAME,
      SALESFORCE_PROVIDER_NAME,
      METRIFOX_PROVIDER_NAME,
      MOCK_PROVIDER_NAME,
    ]) {
      expect(
        getSyncHandler("billing", provider),
        `${provider} unexpectedly has a billing handler`
      ).toBeUndefined();
    }

    // The mock is still offered, because declaring scopes ahead of handlers is
    // the point — it simply cannot sync.
    expect(providerNamesForFunction("billing")).toContain(MOCK_PROVIDER_NAME);
  });

  it("does not leak invoice scopes into an identity-only integration", () => {
    const scopes = resolveScopes(["identity"], "stripe");
    for (const scope of STRIPE_BILLING_SCOPES) {
      expect(scopes).not.toContain(scope);
    }
  });

  it("unions and deduplicates invoice scopes against identity", () => {
    const scopes = resolveScopes(["identity", "billing"], "stripe");
    for (const scope of STRIPE_BILLING_SCOPES) {
      expect(scopes).toContain(scope);
    }
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
