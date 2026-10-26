/**
 * Capability truth: a scope declaration is not a working integration.
 *
 * The picker, the connect API and the integration page all need to know whether
 * a provider/function pair has a handler and which target objects that handler
 * can actually produce. Scope declarations are deliberately broader than that —
 * they carry the roadmap — so these tests pin the narrower answer and, in
 * particular, the places where the two disagree.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  canSyncFunction,
  supportedObjectsFor,
  syncableProviderNamesForFunction,
  syncableProviderNamesForFunctions,
  unsupportedFunctionsFor,
} from "@/core/capabilities";
import { registerSyncHandler } from "@/core/registries/handler-registry";
import { providerNamesForFunction } from "@/core/registries/function-registry";
import type { SyncHandler } from "@/core/types/registry";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("what a provider can actually sync", () => {
  it("requires a handler even when the provider declares the scopes", () => {
    // Salesforce declares agreement scopes because the canonical model says it
    // should eventually carry Contracts. It has no handler, so it cannot be
    // connected for agreement today.
    expect(providerNamesForFunction("agreement")).toContain("salesforce");
    expect(canSyncFunction("agreement", "salesforce")).toBe(false);

    // The same distinction for Support on HubSpot.
    expect(canSyncFunction("support", "hubspot")).toBe(false);
    expect(syncableProviderNamesForFunction("support")).toEqual([]);
  });

  it("offers only handlers for a single function", () => {
    expect(syncableProviderNamesForFunction("agreement")).toEqual([
      "chargebee",
      "hubspot",
      "stigg",
      "stripe",
    ]);
    // The mock declares billing scopes but has no billing handler.
    expect(syncableProviderNamesForFunction("billing")).toEqual([
      "chargebee",
      "stripe",
    ]);
  });

  it("lists only providers that can serve the whole function set", () => {
    // Identity is built everywhere; agreement is built on four of those
    // providers. The intersection is the four, not the seven identity
    // providers and not the seven agreement scope declarations.
    expect(
      syncableProviderNamesForFunctions(["identity", "agreement"])
    ).toEqual(["chargebee", "hubspot", "stigg", "stripe"]);
  });

  it("reports each handler's real object coverage, not the function roadmap", () => {
    // The function declares five objects. HubSpot writes two of them; Stigg
    // deliberately leaves agreementEntitlement unbuilt; Stripe writes three.
    expect(supportedObjectsFor("agreement", "hubspot")).toEqual([
      "agreement",
      "agreementItem",
    ]);
    expect(supportedObjectsFor("agreement", "stigg")).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
      "agreementDiscount",
    ]);
    expect(supportedObjectsFor("agreement", "stripe")).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
    ]);
    expect(supportedObjectsFor("agreement", "chargebee")).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
      "agreementEntitlement",
      "agreementDiscount",
    ]);
  });

  it("has no objects for a pair with no handler", () => {
    expect(supportedObjectsFor("agreement", "salesforce")).toEqual([]);
    expect(supportedObjectsFor("billing", "mock")).toEqual([]);
    expect(canSyncFunction("billing", "mock")).toBe(false);
  });

  it("names the functions a provider cannot serve", () => {
    expect(
      unsupportedFunctionsFor(["identity", "agreement"], "salesforce")
    ).toEqual(["agreement"]);
    expect(
      unsupportedFunctionsFor(["identity", "agreement"], "hubspot")
    ).toEqual([]);
  });
});

describe("handler registration", () => {
  it("rejects a handler that claims an object its function does not write", () => {
    const bad: SyncHandler = {
      objects: ["invoice"],
      // The body is irrelevant: registration rejects the declaration before
      // anything can call it.
      async *fetchPages() {},
      externalIdOf() {
        return undefined;
      },
      externalRefsOf() {
        return {};
      },
    };

    expect(() => registerSyncHandler("identity", "test-provider", bad)).toThrow(
      /does not write: invoice/
    );
  });

  it("rejects a handler with no declared target objects", () => {
    const empty: SyncHandler = {
      objects: [],
      async *fetchPages() {},
      externalIdOf() {
        return undefined;
      },
      externalRefsOf() {
        return {};
      },
    };

    expect(() => registerSyncHandler("identity", "test-provider", empty)).toThrow(
      /at least one target object/
    );
  });
});
