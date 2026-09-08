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
  isProviderConfigured,
  providerRegistry,
  registerProvider,
  requireOAuth,
} from "@/core/registries/provider-registry";
import { buildAuthorizationRequest } from "@/core/oauth/oauth-service";
import { connectHrefFor } from "@/core/providers/connect-url";
import { metrifoxProvider } from "@/core/providers/metrifox/provider";
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

  it("refuses to build an authorization request for an API-key provider", () => {
    expect(() =>
      buildAuthorizationRequest({
        subject: { kind: "integration", integrationId: "int-1" },
        providerName: "metrifox",
        functionNames: ["identity"],
      })
    ).toThrow(/API key, not OAuth/);
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
  it("serves identity, and only identity", async () => {
    const { functionNamesForProvider, providerNamesForFunction } = await import(
      "@/core/registries/function-registry"
    );

    expect(functionNamesForProvider("metrifox")).toEqual(["identity"]);
    expect(providerNamesForFunction("identity")).toContain("metrifox");
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

  it("is not refreshable and has no authorization request to build", () => {
    expect(canRefresh("stripe")).toBe(false);
    expect(() => requireOAuth(stripeProvider)).toThrow(/not OAuth/);
    expect(() =>
      buildAuthorizationRequest({
        subject: { kind: "integration", integrationId: "int-1" },
        providerName: "stripe",
        functionNames: ["identity"],
      })
    ).toThrow(/API key, not OAuth/);
  });

  it("routes to the paste-a-key connect page, like the other API-key provider", () => {
    expect(connectHrefFor("stripe", "int-1")).toBe("/integrations/int-1/connect");
  });

  it("serves identity, and only identity", async () => {
    const { functionNamesForProvider, providerNamesForFunction } = await import(
      "@/core/registries/function-registry"
    );

    // Stripe has a billing API, conspicuously — but the billing function has no
    // schema and no handlers, so claiming it would be a claim that is not true.
    expect(functionNamesForProvider("stripe")).toEqual(["identity"]);
    expect(providerNamesForFunction("identity")).toContain("stripe");
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
