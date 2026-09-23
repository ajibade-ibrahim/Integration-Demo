import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import { InvalidApiKeyError } from "@/core/credentials/errors";
import {
  chargebeeAuthHeaders,
  chargebeeContactExternalId,
  customersUrl,
  epochToIso,
  parseChargebeeCredential,
  parseCustomersPage,
  synthesizeContact,
} from "@/core/providers/chargebee/api";
import {
  CHARGEBEE_FIXTURE_CUSTOMER_1,
  CHARGEBEE_FIXTURE_CUSTOMERS_PAGE_1,
} from "@/core/providers/chargebee/fixtures";
import {
  chargebeeProvider,
  CHARGEBEE_PROVIDER_NAME,
} from "@/core/providers/chargebee/provider";
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

describe("Chargebee Provider Registration & Auth", () => {
  it("registers Chargebee as an API-key provider", () => {
    expect(providerRegistry.get("chargebee")).toBeDefined();
    expect(providerRegistry.get("chargebee")?.auth.kind).toBe("apiKey");
    expect(isProviderConfigured(chargebeeProvider)).toBe(true);
    expect(credentialHint(chargebeeProvider)).toMatch(/API key/i);
    expect(canRefresh("chargebee")).toBe(false);
  });

  it("declares tenant-scoped IDs with site metadata hook", () => {
    expect(chargebeeProvider.externalIdScope).toBe("tenant");
    expect(
      externalIdScopeValue(chargebeeProvider, { site: "my-test-site" })
    ).toBe("my-test-site");
    expect(
      externalIdScopeValue(chargebeeProvider, { site: "" })
    ).toBeUndefined();
  });

  it("validates key shape format (site:api_key)", () => {
    const auth = chargebeeProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

    expect(auth.validateKeyShape("")).toMatch(/paste/i);
    expect(auth.validateKeyShape("just_a_key")).toMatch(/site:api_key/i);
    expect(auth.validateKeyShape("site:key with spaces")).toMatch(
      /more than a key/i
    );
    expect(auth.validateKeyShape("my-site:chb_12345")).toBeUndefined();
  });

  it("parses site and apiKey correctly", () => {
    expect(parseChargebeeCredential("acme-test:chb_123456")).toEqual({
      site: "acme-test",
      apiKey: "chb_123456",
    });
    expect(parseChargebeeCredential("chb_raw_key")).toEqual({
      site: undefined,
      apiKey: "chb_raw_key",
    });
  });

  it("builds Basic HTTP Authorization headers", () => {
    const headers = chargebeeAuthHeaders("acme-test:chb_secret_key");
    const expectedEncoded = Buffer.from("chb_secret_key:").toString("base64");
    expect(headers["Authorization"]).toBe(`Basic ${expectedEncoded}`);
  });

  it("builds correct customers URL", () => {
    const url = customersUrl("my-site", 25, "offset_123");
    expect(url).toContain("https://my-site.chargebee.com/api/v2/customers");
    expect(url).toContain("limit=25");
    expect(url).toContain("next_offset=offset_123");
  });
});

describe("Chargebee API parsing & synthesis", () => {
  it("parses customer page list envelope", () => {
    const page = parseCustomersPage(CHARGEBEE_FIXTURE_CUSTOMERS_PAGE_1);
    expect(page.records.length).toBe(2);
    expect(page.records[0]?.["id"]).toBe("cb_cust_acme");
    expect(page.nextOffset).toBe("offset_page_2");
  });

  it("converts epoch seconds to ISO string", () => {
    expect(epochToIso(1672531200)).toBe("2023-01-01T00:00:00.000Z");
    expect(epochToIso(undefined)).toBeUndefined();
  });

  it("synthesizes billing contact from customer record", () => {
    const contact = synthesizeContact(CHARGEBEE_FIXTURE_CUSTOMER_1);
    expect(contact).toBeDefined();
    expect(contact?.["contact_id"]).toBe("cb_cust_acme:contact");
    expect(contact?.["contact_name"]).toBe("John Doe");
    expect(contact?.["email"]).toBe("john@acme.com");
    expect(contact?.["customer_id"]).toBe("cb_cust_acme");
  });

  it("generates deterministic synthetic contact ID", () => {
    expect(chargebeeContactExternalId("cb_123")).toBe("cb_123:contact");
  });
});

describe("Chargebee probeCredential", () => {
  it("returns site metadata on probe success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => CHARGEBEE_FIXTURE_CUSTOMERS_PAGE_1,
    } as Response);

    const auth = chargebeeProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

    const meta = await auth.probeCredential("my-site:chb_key123");
    expect(meta["site"]).toBe("my-site");
    expect(meta["hasCustomers"]).toBe("true");

    fetchSpy.mockRestore();
  });

  it("throws InvalidApiKeyError on 401/403 status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: "Unauthorized" }),
    } as Response);

    const auth = chargebeeProvider.auth;
    if (auth.kind !== "apiKey") throw new Error("Expected API key provider");

    await expect(auth.probeCredential("my-site:invalid_key")).rejects.toThrow(
      InvalidApiKeyError
    );

    fetchSpy.mockRestore();
  });
});
