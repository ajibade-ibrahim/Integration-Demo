/**
 * A Metrifox billing sync end to end: `executeSync` over a mocked Metrifox,
 * into a real database.
 *
 * What only this level can check, and why each case is here:
 *
 *   - the invoice's customer and agreement links both resolve. The customer
 *     ref is the customers-list `id` identity keys on, and the agreement ref is
 *     the subscription whose billing history returned the invoice;
 *   - standard-unit amounts become integer minor units in the stored columns,
 *     while the raw figures survive in `providerMetadata`;
 *   - a credit note keeps its negative sign through `parseInteger`;
 *   - a draft invoice is ignored rather than written as a number-less bill;
 *   - no invoice line or payment rows are written, because the API exposes
 *     neither;
 *   - a re-run upserts rather than duplicating.
 *
 * The agreement handler also runs here (identity + agreement + billing are
 * selected), so the entitlement-summary endpoint is stubbed. Without it the run
 * would report partial for a reason unrelated to billing.
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
import {
  NON_EXPIRING_AT,
  saveToken,
} from "@/core/repositories/token-repository";
import { readJsonObject } from "@/core/repositories/json-column";
import { createFakeClock } from "@/core/sync/clock";

const USER_ID = "user-metrifox-billing-sync";
const INTEGRATION_ID = "integration-metrifox-billing-sync";

const BASE = "https://api.metrifox.com";
const CUSTOMERS = `${BASE}/api/v1/customers`;
const DETAILS = `${BASE}/api/v1/customers/:customerKey/details`;
const SUMMARY = `${BASE}/api/v1/subscriptions/:subscriptionId/v2/entitlements-summary`;
const HISTORY = `${BASE}/api/v1/subscriptions/:subscriptionId/billing-history`;

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "metrifox-billing-sync@example.test" },
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

const CUSTOMER = {
  id: "cust_1",
  customer_key: "KEY-1",
  display_name: "Acme Manufacturing",
  primary_email: "billing@acme.example",
  contact_people: [],
};

const SUBSCRIPTION = {
  id: "sub_1",
  status: "active",
  plan_name: "Growth",
  plan_version: 2,
  product_name: "Core",
  product_key: "core",
  offering_key: "off_core",
  currency_code: "USD",
  starts_at: "2025-01-01T00:00:00.000Z",
  ends_at: null,
  renews_at: "2025-12-01T00:00:00.000Z",
  trial_end_date: null,
  cancelled_at: null,
  current_billing_period_start: "2025-11-01T00:00:00.000Z",
  current_billing_period_end: "2025-12-01T00:00:00.000Z",
  next_billing_amount: 99.5,
  next_billing_date: "2025-12-01T00:00:00.000Z",
  subscription_items: [],
};

const INVOICES = [
  {
    invoice_id: "inv_paid",
    invoice_number: "INV-2025-001",
    status: "paid",
    currency: "USD",
    total_amount: 21,
    amount_paid: 21,
    balance_due: 0,
    issued_date: "2025-03-01T00:00:00.000Z",
    due_date: "2025-03-31T00:00:00.000Z",
    created_at: "2025-02-28T00:00:00.000Z",
    payment_method: "card",
    source_type: "subscription",
  },
  {
    // A credit note: negative amount, kept rather than filtered.
    invoice_id: "cn_1",
    invoice_number: "CN-2025-001",
    status: "open",
    currency: "USD",
    total_amount: -23.0356,
    amount_paid: 0,
    balance_due: -23.0356,
    issued_date: "2025-03-10T00:00:00.000Z",
    due_date: "2025-04-10T00:00:00.000Z",
    created_at: "2025-03-09T00:00:00.000Z",
    payment_method: null,
    source_type: "credit_note",
  },
  {
    // A draft is not a bill yet, so the handler ignores it entirely.
    invoice_id: "inv_draft",
    invoice_number: null,
    status: "draft",
    currency: "USD",
    total_amount: 10,
    amount_paid: 0,
    balance_due: 10,
    issued_date: "2026-01-01T00:00:00.000Z",
    due_date: "2026-02-01T00:00:00.000Z",
    created_at: "2025-12-20T00:00:00.000Z",
    payment_method: null,
    source_type: "subscription",
  },
];

async function connect(): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "metrifox",
      status: "active",
      instanceLabel: "Metrifox billing sync",
      functions: {
        create: [
          { functionName: "identity" },
          { functionName: "agreement" },
          { functionName: "billing" },
        ],
      },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "sk_test_metrifoxbilling",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });

  for (const functionName of ["identity", "agreement", "billing"]) {
    await saveMappings(
      INTEGRATION_ID,
      functionName,
      defaultMappingsFor(functionName, "metrifox")
    );
  }
}

function standardEndpoints() {
  return [
    http.get(CUSTOMERS, () =>
      HttpResponse.json({
        meta: { next_page: null },
        data: [CUSTOMER],
      })
    ),
    http.get(DETAILS, () =>
      HttpResponse.json({
        data: {
          subscriptions: [
            {
              subscription: SUBSCRIPTION,
              subscriptions_history: [],
              product_key: "core",
              product_name: "Core",
              status: "active",
            },
          ],
        },
      })
    ),
    http.get(SUMMARY, () => HttpResponse.json({ data: [] })),
    http.get(HISTORY, () => HttpResponse.json({ data: INVOICES })),
  ];
}

async function sync() {
  return executeSync(INTEGRATION_ID, {
    clock: createFakeClock(1_700_000_000_000),
  });
}

describe("Metrifox billing sync", () => {
  it("writes invoice summaries with resolved links and converted amounts", async () => {
    server.use(...standardEndpoints());
    await connect();

    const result = await sync();
    expect(result.status).toBe("success");

    const customer = await prisma.customer.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cust_1" },
    });
    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "sub_1" },
    });

    const invoices = await prisma.invoice.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { externalSourceId: "asc" },
    });
    expect(invoices.map((i) => i.externalSourceId)).toEqual([
      "cn_1",
      "inv_paid",
    ]);

    const paid = invoices.find((i) => i.externalSourceId === "inv_paid")!;
    expect(paid.number).toBe("INV-2025-001");
    expect(paid.status).toBe("paid");
    // The currency column is canonical lowercase; the source says USD.
    expect(paid.currency).toBe("usd");
    expect(paid.totalMinor).toBe(2100);
    expect(paid.amountPaidMinor).toBe(2100);
    expect(paid.amountDueMinor).toBe(0);
    expect(paid.issuedAt).not.toBeNull();
    expect(paid.dueAt).not.toBeNull();
    // Both edges resolve: the customer through identity, the agreement through
    // the billing handler's subscription fan-out.
    expect(paid.customerId).toBe(customer.id);
    expect(paid.externalCustomerId).toBe("cust_1");
    expect(paid.agreementId).toBe(agreement.id);
    expect(paid.externalAgreementId).toBe("sub_1");
    // Metrifox's own status word is preserved for custom mappings.
    expect(readJsonObject(paid.customFields)).toMatchObject({
      metrifox_status: "paid",
    });
    expect(readJsonObject(paid.providerMetadata)).toMatchObject({
      subscription_id: "sub_1",
      raw_status: "paid",
      source_type: "subscription",
      payment_method: "card",
      issued_date: "2025-03-01T00:00:00.000Z",
      // The raw standard-unit figures survive the conversion.
      total_amount: "21",
      amount_paid: "21",
      balance_due: "0",
    });
  });

  it("keeps a credit note negative", async () => {
    server.use(...standardEndpoints());
    await connect();

    await sync();

    const credit = await prisma.invoice.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cn_1" },
    });
    expect(credit.totalMinor).toBe(-2304);
    expect(credit.amountDueMinor).toBe(-2304);
    expect(credit.amountPaidMinor).toBe(0);
  });

  it("ignores invoices in draft status", async () => {
    server.use(...standardEndpoints());
    await connect();

    await sync();

    // The billing history contains a draft, but it is not a bill yet and is
    // not written at all.
    expect(
      await prisma.invoice.findFirst({
        where: { integrationId: INTEGRATION_ID, externalSourceId: "inv_draft" },
      })
    ).toBeNull();
    expect(
      await prisma.invoice.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(2);
  });

  it("writes no invoice lines or payments", async () => {
    server.use(...standardEndpoints());
    await connect();

    await sync();

    expect(
      await prisma.invoiceLine.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
    expect(
      await prisma.payment.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });

  it("upserts on a re-run rather than duplicating invoices", async () => {
    server.use(...standardEndpoints());
    await connect();

    await sync();
    const first = await prisma.invoice.count({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(first).toBe(2);

    const second = await sync();
    expect(second.status).toBe("success");

    expect(
      await prisma.invoice.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(2);
  });
});
