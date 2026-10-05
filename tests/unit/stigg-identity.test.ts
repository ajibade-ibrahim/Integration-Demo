import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import { InvalidApiKeyError } from "@/core/credentials/errors";
import { buildAuthorizationRequest } from "@/core/oauth/oauth-service";
import { connectHrefFor } from "@/core/providers/connect-url";
import {
  customersUrl,
  parseCustomersPage,
  stiggContactExternalId,
  synthesizeContact,
  withCustomerName,
  withStripeLink,
} from "@/core/providers/stigg/api";
import {
  stiggProvider,
  STIGG_PROVIDER_NAME,
} from "@/core/providers/stigg/provider";
import { functionNamesForProvider } from "@/core/registries/function-registry";
import {
  canRefresh,
  credentialHint,
  externalIdScopeValue,
  isProviderConfigured,
  providerRegistry,
} from "@/core/registries/provider-registry";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("Stigg provider registration & auth", () => {
  it("registers Stigg as an API-key provider", () => {
    expect(providerRegistry.get(STIGG_PROVIDER_NAME)).toBeDefined();
    expect(providerRegistry.get(STIGG_PROVIDER_NAME)?.auth.kind).toBe("apiKey");
    expect(isProviderConfigured(stiggProvider)).toBe(true);
    expect(credentialHint(stiggProvider)).toMatch(/API key/i);
    expect(canRefresh(STIGG_PROVIDER_NAME)).toBe(false);
  });

  it("routes to the paste-a-key connect page", () => {
    expect(connectHrefFor(STIGG_PROVIDER_NAME, "int-1")).toBe(
      "/integrations/int-1/connect"
    );
  });

  it("refuses to build an authorization request", async () => {
    await expect(
      buildAuthorizationRequest({
        subject: { kind: "integration", integrationId: "int-1" },
        providerName: STIGG_PROVIDER_NAME,
        functionNames: ["identity"],
      })
    ).rejects.toThrow(/API key, not OAuth/);
  });

  it("declares the header its credential actually travels in", () => {
    // `auth.header` is documentation — the credential is applied by the
    // session's `authHeaders` — so the two drifting apart is a real hazard this
    // is the only place to catch.
    const auth = stiggProvider.auth;
    expect(auth.kind).toBe("apiKey");
    if (auth.kind !== "apiKey") return;
    expect(auth.header).toBe("X-API-KEY");
  });

  it("serves identity only", () => {
    expect(functionNamesForProvider(STIGG_PROVIDER_NAME)).toEqual(["identity"]);
  });
});

describe("Stigg external id scope", () => {
  it("declares tenant scope and emits no key until the environment is known", () => {
    expect(stiggProvider.externalIdScope).toBe("tenant");
    expect(externalIdScopeValue(stiggProvider, {})).toBeUndefined();
    expect(
      externalIdScopeValue(stiggProvider, { environmentId: "   " })
    ).toBeUndefined();
  });

  it("scopes by environment id when the metadata carries one", () => {
    expect(
      externalIdScopeValue(stiggProvider, { environmentId: "env-123" })
    ).toBe("env-123");
  });
});

describe("Stigg key shape", () => {
  it("rejects only the documented true negative, and guesses at nothing else", () => {
    const auth = stiggProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

    expect(auth.validateKeyShape("")).toMatch(/paste/i);
    expect(auth.validateKeyShape("server-abc 123")).toMatch(/more than a key/i);
    // A publishable key cannot authenticate an API request under any
    // circumstances, so this is a fact rather than a format guess.
    expect(auth.validateKeyShape("client-abc123")).toMatch(/publishable/i);

    // Every shape a server key actually takes has to survive.
    expect(auth.validateKeyShape("server-abc123")).toBeUndefined();
    expect(auth.validateKeyShape("some-arbitrary-long-key-value")).toBeUndefined();
  });
});

describe("Stigg probeCredential", () => {
  it("returns no metadata on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const auth = stiggProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

    await expect(auth.probeCredential("server-abc123")).resolves.toEqual({});
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.stigg.io/api/v1/customers");
    expect(String(url)).toContain("limit=1");
    expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe(
      "server-abc123"
    );

    fetchSpy.mockRestore();
  });

  it("throws InvalidApiKeyError on 401/403", async () => {
    for (const status of [401, 403]) {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({}),
      } as Response);

      const auth = stiggProvider.auth;
      if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

      await expect(auth.probeCredential("server-bad")).rejects.toThrow(
        InvalidApiKeyError
      );

      fetchSpy.mockRestore();
    }
  });
});

describe("Stigg API parsing & synthesis", () => {
  it("builds the customers URL with limit, and omits the cursor on the first page", () => {
    const first = customersUrl(25);
    expect(first).toContain("https://api.stigg.io/api/v1/customers");
    expect(first).toContain("limit=25");
    expect(first).not.toContain("after=");

    const next = customersUrl(25, "cursor-abc");
    expect(next).toContain("after=cursor-abc");
  });

  it("parses records and the pagination.next cursor", () => {
    const page = parseCustomersPage({
      data: [{ id: "customer-1" }, { id: "customer-2" }],
      pagination: { next: "cursor-2", prev: null },
    });
    expect(page.records.map((r) => r["id"])).toEqual([
      "customer-1",
      "customer-2",
    ]);
    expect(page.nextCursor).toBe("cursor-2");
  });

  it("treats a null next cursor as the last page", () => {
    expect(
      parseCustomersPage({ data: [], pagination: { next: null } }).nextCursor
    ).toBeUndefined();
    expect(parseCustomersPage({ data: [] }).nextCursor).toBeUndefined();
  });

  it("generates a deterministic synthetic contact id", () => {
    expect(stiggContactExternalId("customer-1")).toBe("customer-1:contact");
  });

  it("synthesizes a contact from the customer's name", () => {
    const contact = synthesizeContact({
      id: "customer-1",
      name: "Acme Inc",
      email: "billing@acme.example",
    });

    expect(contact).toBeDefined();
    expect(contact?.["contact_id"]).toBe("customer-1:contact");
    expect(contact?.["contact_name"]).toBe("Acme Inc");
    expect(contact?.["email"]).toBe("billing@acme.example");
    expect(contact?.["customer_id"]).toBe("customer-1");
    expect(contact?.["customer_name"]).toBe("Acme Inc");
    // No `id`: `externalIdOf` falls back to it for customers, and the contact is
    // built from scratch rather than spread from its parent.
    expect(contact).not.toHaveProperty("id");
  });

  it("prefers the email local part over the id when there is no name", () => {
    const contact = synthesizeContact({
      id: "customer-2",
      name: null,
      email: "billing@acme.example",
    });

    expect(contact?.["contact_name"]).toBe("billing");
    // The customer's effective name is still its id, matching the record.
    expect(contact?.["customer_name"]).toBe("customer-2");
  });

  it("falls back to the customer id when there is neither a name nor an email", () => {
    const contact = synthesizeContact({
      id: "customer-3",
      name: "   ",
      email: null,
    });

    expect(contact?.["contact_name"]).toBe("customer-3");
    expect(contact?.["customer_name"]).toBe("customer-3");
  });

  it("emits nothing when the customer has no id", () => {
    expect(synthesizeContact({ name: "Acme Inc" })).toBeUndefined();
  });

  it("names a customer by its id when Stigg gave no name", () => {
    expect(withCustomerName({ id: "customer-1", name: null })).toEqual({
      name: "customer-1",
    });
    expect(withCustomerName({ id: "customer-1", name: "   " })).toEqual({
      name: "customer-1",
    });
  });

  it("leaves a name Stigg did supply untouched, and adds nothing without an id", () => {
    expect(withCustomerName({ id: "customer-1", name: "Acme Inc" })).toEqual({});
    expect(withCustomerName({ name: null })).toEqual({});
  });

  it("picks the STRIPE integration out of several", () => {
    expect(
      withStripeLink({
        id: "customer-1",
        integrations: [
          { vendorIdentifier: "ZUORA", syncedEntityId: "zuora-1" },
          { vendorIdentifier: "STRIPE", syncedEntityId: "cus_123" },
        ],
      })
    ).toEqual({ stripe_customer_id: "cus_123" });
  });

  it("emits no stripe link when absent or non-Stripe", () => {
    expect(withStripeLink({ id: "customer-1" })).toEqual({});
    expect(
      withStripeLink({
        id: "customer-1",
        integrations: [{ vendorIdentifier: "ZUORA", syncedEntityId: "zuora-1" }],
      })
    ).toEqual({});
    expect(
      withStripeLink({
        id: "customer-1",
        integrations: [{ vendorIdentifier: "STRIPE", syncedEntityId: "" }],
      })
    ).toEqual({});
  });
});
