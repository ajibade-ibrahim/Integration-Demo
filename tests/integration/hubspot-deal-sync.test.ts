/**
 * A HubSpot deal sync end to end: `executeSync` over a mocked CRM, into a real
 * database.
 *
 * What only this level can check: that the deal's company association resolves
 * against the customer the identity function wrote earlier in the same run, that
 * the line item lands under the right agreement, and that a second refresh
 * upserts rather than duplicates.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { prisma } from "@/lib/prisma";
import { bootstrap } from "@/core/bootstrap";
import { executeSync } from "@/core/sync/sync-engine";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { NON_EXPIRING_AT, saveToken } from "@/core/repositories/token-repository";
import { readJsonObject } from "@/core/repositories/json-column";
import { createFakeClock } from "@/core/sync/clock";

const USER_ID = "user-hubspot-deal-sync";
const INTEGRATION_ID = "integration-hubspot-deal-sync";

const BASE = "https://api.hubapi.com";
const COMPANIES = `${BASE}/crm/v3/objects/companies`;
const CONTACTS = `${BASE}/crm/v3/objects/contacts`;
const DEALS = `${BASE}/crm/v3/objects/deals`;
const LINE_ITEMS = `${BASE}/crm/v3/objects/line_items`;

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "hubspot-deal-sync@example.test" },
    update: {},
  });
});

afterEach(() => server.resetHandlers());

afterAll(async () => {
  server.close();
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });
});

async function connect(functionNames: string[]): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "hubspot",
      status: "active",
      instanceLabel: "HubSpot deal sync",
      functions: {
        create: functionNames.map((functionName) => ({ functionName })),
      },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "hubspot-test-token",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });

  for (const functionName of functionNames) {
    await saveMappings(
      INTEGRATION_ID,
      functionName,
      defaultMappingsFor(functionName, "hubspot")
    );
  }
}

function hubspotEndpoints() {
  return [
    http.get(COMPANIES, () =>
      HttpResponse.json({
        results: [
          {
            id: "101",
            properties: {
              name: "Acme",
              domain: "acme.test",
              industry: "Software",
              createdate: "2024-01-01T00:00:00.000Z",
            },
          },
        ],
      })
    ),
    http.get(CONTACTS, () => HttpResponse.json({ results: [] })),
    http.get(DEALS, () =>
      HttpResponse.json({
        results: [
          {
            id: "deal-1",
            properties: {
              dealname: "Acme renewal",
              amount: "12000.00",
              dealstage: "closedwon",
              pipeline: "default",
              dealtype: "existingbusiness",
              createdate: "2024-01-01T00:00:00.000Z",
              closedate: "2024-06-01T00:00:00.000Z",
              deal_currency_code: "USD",
              hs_is_closed: "true",
              hs_is_closed_won: "true",
              hs_is_closed_lost: "false",
            },
            associations: {
              companies: {
                results: [{ id: "101", type: "deal_to_company" }],
              },
            },
          },
        ],
      })
    ),
    http.get(LINE_ITEMS, () =>
      HttpResponse.json({
        results: [
          {
            id: "li-1",
            properties: {
              name: "Seats",
              quantity: "2",
              price: "49.00",
              amount: "98.00",
              discount: "0",
              hs_product_id: "prod-1",
              hs_sku: "SKU-1",
              hs_line_item_currency_code: "USD",
              hs_position_on_quote: "0",
              hs_recurring_billing_number_of_payments: "12",
              recurringbillingfrequency: "monthly",
            },
            associations: {
              deals: {
                results: [{ id: "deal-1", type: "line_item_to_deal" }],
              },
            },
          },
        ],
      })
    ),
  ];
}

async function sync() {
  return executeSync(INTEGRATION_ID, {
    clock: createFakeClock(1_700_000_000_000),
  });
}

describe("HubSpot deal sync", () => {
  it("writes the deal, links its customer and writes its line item", async () => {
    server.use(...hubspotEndpoints());
    await connect(["identity", "agreement"]);

    const result = await sync();
    expect(result.status).toBe("success");

    const customer = await prisma.customer.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "101" },
    });
    expect(customer.name).toBe("Acme");

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "deal-1" },
    });
    expect(agreement.name).toBe("Acme renewal");
    expect(agreement.agreementType).toBe("deal");
    expect(agreement.status).toBe("active");
    expect(agreement.currency).toBe("USD");
    expect(agreement.externalCustomerId).toBe("101");
    expect(agreement.customerId).toBe(customer.id);
    expect(agreement.effectiveDate?.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z"
    );
    expect(agreement.endDate?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(readJsonObject(agreement.providerMetadata)).toMatchObject({
      dealstage: "closedwon",
      pipeline: "default",
      amount: "12000.00",
    });

    const items = await prisma.agreementItem.findMany({
      where: { agreementId: agreement.id },
      orderBy: { position: "asc" },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(2);
    expect(items[0]?.position).toBe(0);
    expect(items[0]?.externalOfferingId).toBe("prod-1");
    expect(readJsonObject(items[0]?.providerMetadata)).toMatchObject({
      price: "49.00",
      amount: "98.00",
      hs_product_id: "prod-1",
    });
  });

  it("upserts on a second refresh instead of duplicating", async () => {
    server.use(...hubspotEndpoints());
    await connect(["identity", "agreement"]);

    await sync();
    await sync();

    expect(
      await prisma.customer.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);
    expect(
      await prisma.agreement.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "deal-1" },
    });
    expect(
      await prisma.agreementItem.count({ where: { agreementId: agreement.id } })
    ).toBe(1);
  });
});
