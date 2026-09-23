/**
 * The provider registry now accepts two credential kinds.
 *
 * The point of these is that widening the union did not loosen validation for
 * the kind that already existed: an OAuth provider missing a token endpoint
 * must still be a registration error, not something that fails at connect time.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  canRefresh,
  credentialHint,
  externalIdScopeValue,
  isProviderConfigured,
  providerRegistry,
  registerProvider,
  requireOAuth,
} from "@/core/registries/provider-registry";
import { buildAuthorizationRequest } from "@/core/oauth/oauth-service";
import { connectHrefFor } from "@/core/providers/connect-url";
import { metrifoxProvider } from "@/core/providers/metrifox/provider";
import { organizationIdFromIdentityUrl } from "@/core/providers/salesforce/provider";
import { stripeProvider } from "@/core/providers/stripe/provider";
import type { ProviderDefinition } from "@/core/types/registry";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

/** A minimal valid OAuth definition, to be broken one field at a time. */
function oauthDefinition(name: string): ProviderDefinition {
  return {
    name,
    label: name,
    description: "",
    externalIdScope: "global",
    auth: {
      kind: "oauth",
      authorizeEndpoint: "https://example.test/authorize",
      tokenEndpoint: "https://example.test/token",
      clientIdEnv: "EXAMPLE_CLIENT_ID",
      clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
      buildAuthorizeParams: () => new URLSearchParams(),
      parseTokenResponse: () => ({
        accessToken: "t",
        expiresInSeconds: 60,
        metadata: {},
      }),
    },
  };
}

describe("registration validation per credential kind", () => {
  it("registers an API-key provider that has no OAuth fields", () => {
    expect(providerRegistry.get("metrifox")).toBeDefined();
    expect(providerRegistry.get("metrifox")?.auth.kind).toBe("apiKey");
  });

  it("still rejects an OAuth provider missing its token endpoint", () => {
    const broken = oauthDefinition("broken-oauth");
    // @ts-expect-error deliberately breaking a required field
    broken.auth.tokenEndpoint = "";

    expect(() => registerProvider(broken)).toThrow(/missing tokenEndpoint/);
  });

  it("still rejects an OAuth provider missing parseTokenResponse", () => {
    const broken = oauthDefinition("broken-parse");
    // @ts-expect-error deliberately breaking a required field
    broken.auth.parseTokenResponse = undefined;

    expect(() => registerProvider(broken)).toThrow(/missing parseTokenResponse/);
  });

  it("rejects an API-key provider missing its probe", () => {
    const broken: ProviderDefinition = {
      name: "broken-apikey",
      label: "Broken",
      description: "",
      externalIdScope: "global",
      auth: {
        kind: "apiKey",
        header: "x-api-key",
        instructions: "",
        placeholder: "",
        validateKeyShape: () => undefined,
        // @ts-expect-error deliberately omitting a required hook
        probeCredential: undefined,
      },
    };

    expect(() => registerProvider(broken)).toThrow(/missing probeCredential/);
  });

  it("rejects an API-key provider with no header", () => {
    const broken: ProviderDefinition = {
      name: "broken-header",
      label: "Broken",
      description: "",
      externalIdScope: "global",
      auth: {
        kind: "apiKey",
        header: "  ",
        instructions: "",
        placeholder: "",
        validateKeyShape: () => undefined,
        probeCredential: async () => ({}),
      },
    };

    expect(() => registerProvider(broken)).toThrow(/missing auth.header/);
  });
});

/**
 * How widely a provider's record ids are unique.
 *
 * Identity resolution turns those ids into match keys, so getting this wrong
 * merges two unrelated businesses rather than failing visibly — which is why
 * the field is non-optional and why registration re-checks it even though the
 * type already requires it.
 */
describe("external id scope", () => {
  it("declares a scope for every registered provider", () => {
    for (const provider of providerRegistry.getAll()) {
      expect(["global", "tenant"], provider.name).toContain(
        provider.externalIdScope
      );
    }
  });

  it("gives every tenant-scoped provider a way to name its tenant", () => {
    // The hook may well return undefined at runtime — three of these have no
    // account identifier available yet. Its *absence* is the bug: a provider
    // with no hook has no way to ever be scoped, so the omission would be
    // permanent and silent.
    for (const provider of providerRegistry.getAll()) {
      if (provider.externalIdScope !== "tenant") continue;
      expect(typeof provider.tenantScopeValue, provider.name).toBe("function");
    }
  });

  it("scopes Stripe globally, because a cus_ id means one customer", () => {
    // The reason the Metrifox → Stripe crosswalk works at all: neither side has
    // to agree on a tenant for a Stripe id to name the same customer.
    expect(providerRegistry.require("stripe").externalIdScope).toBe("global");
    expect(externalIdScopeValue(stripeProvider, {})).toBe("");
  });

  it("scopes HubSpot per tenant and emits nothing until the portal is known", () => {
    // Company `12345` exists in most portals and they are unrelated
    // businesses. HubSpot's token response carries no hub_id — it is only
    // available from /oauth/v1/access-tokens/{token}, which parseTokenResponse
    // cannot call — so the honest answer today is no key at all.
    const hubspot = providerRegistry.require("hubspot");
    expect(hubspot.externalIdScope).toBe("tenant");
    expect(externalIdScopeValue(hubspot, {})).toBeUndefined();
    expect(externalIdScopeValue(hubspot, { hubId: "hub-1" })).toBe("hub-1");
  });

  it("scopes Salesforce by org id, never by instance host", () => {
    // The distinction is the whole point of the scope segment. Legacy pod
    // hostnames like na1.salesforce.com were shared by thousands of unrelated
    // orgs, so scoping by instanceUrl would have been no scoping at all.
    const salesforce = providerRegistry.require("salesforce");
    expect(salesforce.externalIdScope).toBe("tenant");
    expect(
      externalIdScopeValue(salesforce, {
        instanceUrl: "https://na1.salesforce.com",
      })
    ).toBeUndefined();
    expect(
      externalIdScopeValue(salesforce, {
        instanceUrl: "https://na1.salesforce.com",
        organizationId: "00Dxx0000001gPA",
      })
    ).toBe("00Dxx0000001gPA");
  });

  it("captures the org id out of Salesforce's identity URL", () => {
    expect(
      organizationIdFromIdentityUrl(
        "https://login.salesforce.com/id/00Dxx0000001gPA/005xx000001Sv6c"
      )
    ).toBe("00Dxx0000001gPA");
    // A missing or reshaped URL costs one join, so it must not throw.
    expect(organizationIdFromIdentityUrl("")).toBeUndefined();
    expect(
      organizationIdFromIdentityUrl("https://login.salesforce.com/id/nope/x")
    ).toBeUndefined();
  });

  it("treats a blank scope value as no scope, not as an empty segment", () => {
    // An empty segment is the *global* shape. A tenant-scoped provider reaching
    // it would emit `hubspot::12345` — exactly the unscoped key the design
    // exists to prevent.
    const hubspot = providerRegistry.require("hubspot");
    expect(externalIdScopeValue(hubspot, { hubId: "   " })).toBeUndefined();
  });

  it("rejects a provider that declares no scope", () => {
    const broken = oauthDefinition("broken-scope");
    // @ts-expect-error deliberately omitting a required field
    delete broken.externalIdScope;

    expect(() => registerProvider(broken)).toThrow(/missing externalIdScope/);
  });

  it("rejects a tenant-scoped provider with no scope hook", () => {
    const broken = {
      ...oauthDefinition("broken-tenant"),
      externalIdScope: "tenant" as const,
    };

    expect(() => registerProvider(broken)).toThrow(/no tenantScopeValue hook/);
  });
});

describe("credential-kind behaviour", () => {
  it("treats an API-key provider as always configured", () => {
    // No METRIFOX_* env vars are set in tests, deliberately: the key arrives
    // per integration, so there is nothing that could be missing.
    expect(isProviderConfigured(metrifoxProvider)).toBe(true);
    expect(credentialHint(metrifoxProvider)).toMatch(/API key/i);
  });

  it("reports only OAuth providers as refreshable", () => {
    expect(canRefresh("hubspot")).toBe(true);
    expect(canRefresh("metrifox")).toBe(false);
    expect(canRefresh("nonexistent")).toBe(false);
  });

  // `.rejects`, not `.toThrow`: building an authorization request now records
  // the state value it issues, so the function is async and refuses by
  // rejecting. The refusal still happens before anything is written.
  it("refuses to build an authorization request for an API-key provider", async () => {
    await expect(
      buildAuthorizationRequest({
        subject: { kind: "integration", integrationId: "int-1" },
        providerName: "metrifox",
        functionNames: ["identity"],
      })
    ).rejects.toThrow(/API key, not OAuth/);
  });

  it("requireOAuth narrows or throws", () => {
    expect(requireOAuth(providerRegistry.require("hubspot")).tokenEndpoint).toContain(
      "hubapi.com"
    );
    expect(() => requireOAuth(metrifoxProvider)).toThrow(/not OAuth/);
  });

  it("points each kind at the connect route that works for it", () => {
    expect(connectHrefFor("metrifox", "int-1")).toBe("/integrations/int-1/connect");
    expect(connectHrefFor("hubspot", "int-1")).toBe(
      "/api/oauth/hubspot/start?integrationId=int-1"
    );
  });
});

describe("function coverage", () => {
  it("serves identity and agreement, but not billing", async () => {
    const { functionNamesForProvider, providerNamesForFunction } = await import(
      "@/core/registries/function-registry"
    );

    expect(functionNamesForProvider("metrifox")).toEqual([
      "agreement",
      "identity",
    ]);
    expect(providerNamesForFunction("identity")).toContain("metrifox");

    // Metrifox carries orders and subscriptions, so agreement is a true claim
    // about the API even though no handler reads them yet. It carries invoices
    // too — billing is held to the mock deliberately, to keep
    // ["identity","billing"] a genuine partial intersection.
    expect(providerNamesForFunction("billing")).not.toContain("metrifox");
  });
});

/**
 * Stripe is the second API-key provider, and the reason the credential kind has
 * to be an abstraction rather than a special case: its key travels in
 * `Authorization: Bearer`, not a custom header, and it pins an API version
 * alongside. If any of these mirror-image assertions needed different treatment
 * from Metrifox's, the abstraction would have leaked.
 */
describe("Stripe as a second API-key provider", () => {
  it("registers as an API-key provider and is always configured", () => {
    expect(providerRegistry.get("stripe")?.auth.kind).toBe("apiKey");
    expect(isProviderConfigured(stripeProvider)).toBe(true);
    expect(credentialHint(stripeProvider)).toMatch(/API key/i);
  });

  it("is not refreshable and has no authorization request to build", async () => {
    expect(canRefresh("stripe")).toBe(false);
    expect(() => requireOAuth(stripeProvider)).toThrow(/not OAuth/);
    await expect(
      buildAuthorizationRequest({
        subject: { kind: "integration", integrationId: "int-1" },
        providerName: "stripe",
        functionNames: ["identity"],
      })
    ).rejects.toThrow(/API key, not OAuth/);
  });

  it("routes to the paste-a-key connect page, like the other API-key provider", () => {
    expect(connectHrefFor("stripe", "int-1")).toBe("/integrations/int-1/connect");
  });

  it("serves identity, catalog and agreement, but not billing", async () => {
    const { functionNamesForProvider, providerNamesForFunction } = await import(
      "@/core/registries/function-registry"
    );

    // A declared scope set claims the provider *can* serve the function and
    // names what it would need — not that the handler exists. Stripe genuinely
    // exposes subscriptions, so agreement is true of the API today; catalog is
    // true *and* built.
    expect(functionNamesForProvider("stripe")).toEqual([
      "agreement",
      "catalog",
      "identity",
    ]);
    expect(providerNamesForFunction("catalog")).toEqual(["chargebee", "stripe"]);
    expect(providerNamesForFunction("identity")).toContain("stripe");

    // Stripe has a billing API, conspicuously. Withholding it is a deliberate
    // demo shape rather than a statement about the API: it is what keeps
    // ["identity","billing"] resolving to the mock alone, which is the only
    // place the whole-set coverage rule is observable.
    expect(providerNamesForFunction("billing")).not.toContain("stripe");
  });

  it("declares the header its credential actually travels in", () => {
    // `auth.header` is documentation — the credential is applied by the
    // session's `authHeaders` — so the two drifting apart is a real hazard, and
    // this is the only place it can be caught.
    const auth = stripeProvider.auth;
    expect(auth.kind).toBe("apiKey");
    if (auth.kind !== "apiKey") return;
    expect(auth.header).toBe("Authorization");
  });

  it("rejects a publishable key without a round trip, but guesses at nothing else", () => {
    const auth = stripeProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("expected an API-key provider");

    // A true negative: a publishable key cannot authenticate an API request.
    expect(auth.validateKeyShape("pk_test_abc123")).toMatch(/publishable/i);
    expect(auth.validateKeyShape("")).toMatch(/paste/i);
    expect(auth.validateKeyShape("curl https://api.stripe.com -u sk_test_x")).toMatch(
      /more than a key/i
    );

    // Everything Stripe actually issues has to survive: dashboard secret keys,
    // restricted keys, and the sandbox keys the CLI prints.
    for (const key of ["sk_test_abc123", "sk_live_abc123", "rk_test_abc123", "rkcs_test_abc123"]) {
      expect(auth.validateKeyShape(key), key).toBeUndefined();
    }
  });
});
