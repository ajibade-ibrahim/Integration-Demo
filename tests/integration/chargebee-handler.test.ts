/**
 * Chargebee identity handler integration tests against a mocked API.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { chargebeeIdentityHandler } from "@/core/providers/chargebee/identity-handler";
import { chargebeeFieldDiscovery } from "@/core/providers/chargebee/discovery";
import {
  CHARGEBEE_FIXTURE_CUSTOMER_1,
  CHARGEBEE_FIXTURE_CUSTOMER_2,
} from "@/core/providers/chargebee/fixtures";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "@/core/sync/errors";
import { collect, testContext } from "./helpers";

const SITE = "acme-test";
const CUSTOMERS_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/customers`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  delete process.env["CHARGEBEE_PAGE_SIZE"];
  delete process.env["CHARGEBEE_API_BASE"];
});

afterAll(() => {
  server.close();
});

describe("Chargebee Identity Handler Pagination & Sync", () => {
  it("yields customers and synthesized contacts page by page", async () => {
    server.use(
      http.get(CUSTOMERS_ENDPOINT, ({ request }) => {
        const url = new URL(request.url);
        const offset = url.searchParams.get("next_offset");

        if (!offset) {
          return HttpResponse.json({
            list: [{ customer: CHARGEBEE_FIXTURE_CUSTOMER_1 }],
            next_offset: "offset_2",
          });
        }

        return HttpResponse.json({
          list: [{ customer: CHARGEBEE_FIXTURE_CUSTOMER_2 }],
        });
      })
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:chb_test_key`,
      metadata: { site: SITE },
    });

    const { pages, byObject } = await collect(chargebeeIdentityHandler, ctx);

    // Check customers before contacts ordering
    const objects = pages.map((p) => p.object);
    expect(objects.lastIndexOf("customer")).toBeLessThan(
      objects.indexOf("contact")
    );

    expect(byObject.customer).toHaveLength(2);
    expect(byObject.customer[0]?.["id"]).toBe("cb_cust_acme");
    expect(byObject.customer[0]?.["created_at"]).toBe("2023-01-01T00:00:00.000Z");

    expect(byObject.contact).toHaveLength(2);
    expect(byObject.contact[0]?.["contact_id"]).toBe("cb_cust_acme:contact");
    expect(byObject.contact[0]?.["contact_name"]).toBe("John Doe");

    expect(
      chargebeeIdentityHandler.externalRefsOf(byObject.contact[0]!, "contact")
    ).toEqual({ customer: "cb_cust_acme" });
  });

  it("sends Basic Auth header with encoded key", async () => {
    let authHeader: string | null = null;

    server.use(
      http.get(CUSTOMERS_ENDPOINT, ({ request }) => {
        authHeader = request.headers.get("Authorization");
        return HttpResponse.json({ list: [] });
      })
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:my_secret_key`,
      metadata: { site: SITE },
    });

    await collect(chargebeeIdentityHandler, ctx);

    const expected = `Basic ${Buffer.from("my_secret_key:").toString("base64")}`;
    expect(authHeader).toBe(expected);
  });
});

describe("Chargebee Failure Policy", () => {
  it("treats 401 as terminal ReauthorizationRequiredError", async () => {
    server.use(
      http.get(CUSTOMERS_ENDPOINT, () => new HttpResponse(null, { status: 401 }))
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:invalid_key`,
      metadata: { site: SITE },
    });

    await expect(collect(chargebeeIdentityHandler, ctx)).rejects.toThrow(
      ReauthorizationRequiredError
    );
  });

  it("classifies 5xx as RetryableSyncError and 400 as ProviderHttpError", async () => {
    server.use(
      http.get(CUSTOMERS_ENDPOINT, () => new HttpResponse("Error", { status: 503 }))
    );

    const { ctx } = testContext({
      accessToken: `${SITE}:key`,
      metadata: { site: SITE },
    });

    await expect(collect(chargebeeIdentityHandler, ctx)).rejects.toThrow(
      RetryableSyncError
    );

    server.resetHandlers();
    server.use(
      http.get(CUSTOMERS_ENDPOINT, () => new HttpResponse("Bad Request", { status: 400 }))
    );

    await expect(collect(chargebeeIdentityHandler, ctx)).rejects.toThrow(
      ProviderHttpError
    );
  });
});

describe("Chargebee Field Discovery", () => {
  it("discovers static customer and contact fields", async () => {
    const { ctx } = testContext({
      accessToken: `${SITE}:key`,
      metadata: { site: SITE },
    });

    const customerFields = await chargebeeFieldDiscovery.discover(ctx, "customer");
    expect(customerFields.map((f) => f.path)).toContain("company");
    expect(customerFields.map((f) => f.path)).toContain("email");

    const contactFields = await chargebeeFieldDiscovery.discover(ctx, "contact");
    expect(contactFields.map((f) => f.path)).toContain("contact_name");
  });
});
