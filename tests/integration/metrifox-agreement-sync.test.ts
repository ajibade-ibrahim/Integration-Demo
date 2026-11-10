/**
 * A Metrifox agreement sync end to end: `executeSync` over a mocked Metrifox,
 * into a real database.
 *
 * What only this level can check, and why each case is here:
 *
 *   - the customer association resolves. The agreement's ref is the
 *     customers-list `id`; identity keys customers on that same id, so a
 *     handler that used the details payload's own ids would store an unlinked
 *     agreement forever;
 *   - the `limit_value` sentinel survives the writer. With `usage_limit: null`
 *     and `purchased_qty: 3`, the stored row must have `value = "3"` and
 *     `limitValue = null` rather than the writer's `limitValue ?? value`
 *     fallback storing 3 as a hard limit;
 *   - the delete path. An empty, complete summary removes a stale entitlement;
 *     a 404 withholds completeness and removes nothing.
 *
 * Offering and feature links stay null here because no Metrifox catalog
 * handler exists — that is expected, and the provider ids are retained so the
 * links can resolve once it does.
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

const USER_ID = "user-metrifox-agreement-sync";
const INTEGRATION_ID = "integration-metrifox-agreement-sync";

const BASE = "https://api.metrifox.com";
const CUSTOMERS = `${BASE}/api/v1/customers`;
const DETAILS = `${BASE}/api/v1/customers/:customerKey/details`;
const SUMMARY = `${BASE}/api/v1/subscriptions/:subscriptionId/v2/entitlements-summary`;

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "metrifox-agreement-sync@example.test" },
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
  subscription_items: [
    {
      price_option_id: "po_1",
      name: "Growth",
      quantity: 1,
      unit_price: 99.5,
      total_amount: 99.5,
      is_addon: false,
      source_type: "ProductCatalogues::Offerings::Plan",
      source_id: "plan_1",
    },
    {
      price_option_id: "po_2",
      name: "Extra seats",
      quantity: 5,
      unit_price: 10,
      total_amount: 50,
      is_addon: true,
      source_type: "ProductCatalogues::Entitlements::PaidEntitlement",
      source_id: "feat_seats",
    },
  ],
};

const ENTITLEMENT_ROW = {
  id: "row_1",
  feature_key: "seats",
  feature_name: "Seats",
  active: true,
  purchased_qty: 3,
  included_allowance: 1,
  usage_limit: null,
  usage_model: "per_unit",
  price_type: "recurring",
  feature_type: "quantity",
  soft_limit_enabled: false,
  aggregation_method: "sum",
  carryover_enabled: true,
  billing_interval: "month",
  billing_interval_value: 1,
};

async function connect(): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "metrifox",
      status: "active",
      instanceLabel: "Metrifox agreement sync",
      functions: {
        create: [{ functionName: "identity" }, { functionName: "agreement" }],
      },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "sk_test_metrifoxagreement",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });

  for (const functionName of ["identity", "agreement"]) {
    await saveMappings(
      INTEGRATION_ID,
      functionName,
      defaultMappingsFor(functionName, "metrifox")
    );
  }
}

function customersEndpoint() {
  return http.get(CUSTOMERS, () =>
    HttpResponse.json({
      meta: { next_page: null },
      data: [CUSTOMER],
    })
  );
}

function detailsEndpoint() {
  return http.get(DETAILS, () =>
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
  );
}

function summaryEndpoint(rows: unknown[]) {
  return http.get(SUMMARY, () => HttpResponse.json({ data: rows }));
}

function standardEndpoints() {
  return [
    customersEndpoint(),
    detailsEndpoint(),
    summaryEndpoint([ENTITLEMENT_ROW]),
  ];
}

async function sync() {
  return executeSync(INTEGRATION_ID, {
    clock: createFakeClock(1_700_000_000_000),
  });
}

describe("Metrifox agreement sync", () => {
  it("writes the agreement, its subscription detail, its lines and entitlements", async () => {
    server.use(...standardEndpoints());
    await connect();

    const result = await sync();
    expect(result.status).toBe("success");

    const customer = await prisma.customer.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cust_1" },
    });

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "sub_1",
      },
    });
    expect(agreement.name).toBe("Growth");
    expect(agreement.agreementType).toBe("subscription");
    expect(agreement.status).toBe("active");
    expect(agreement.currency).toBe("usd");
    expect(agreement.effectiveDate).not.toBeNull();
    expect(agreement.endDate).toBeNull();
    // The customer ref resolves because the handler used the list id.
    expect(agreement.customerId).toBe(customer.id);
    expect(agreement.externalCustomerId).toBe("cust_1");
    // No Metrifox catalog handler, so the offering stays unlinked — with the
    // provider id retained for a later run.
    expect(agreement.offeringId).toBeNull();
    expect(agreement.externalOfferingId).toBe("off_core");
    // The writer's provider-metadata path coerces values to strings, like
    // `customFields`; the bag is a convenience, not a typed store.
    expect(readJsonObject(agreement.providerMetadata)).toMatchObject({
      product_key: "core",
      plan_version: "2",
      raw_status: "active",
    });

    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { agreementId: agreement.id },
    });
    expect(subscription.currentPeriodStart).not.toBeNull();
    expect(subscription.currentPeriodEnd).not.toBeNull();
    expect(subscription.nextBillingAt).not.toBeNull();
    expect(subscription.trialEndsAt).toBeNull();
    expect(subscription.canceledAt).toBeNull();
    expect(subscription.itemCount).toBe(2);
    // None of these is stated by the payload, so all stay null.
    expect(subscription.billingPeriod).toBeNull();
    expect(subscription.billingPeriodCount).toBeNull();
    expect(subscription.collectionMethod).toBeNull();
    expect(readJsonObject(subscription.providerMetadata)).toMatchObject({
      next_billing_amount: "99.5",
      raw_status: "active",
    });

    const items = await prisma.agreementItem.findMany({
      where: { agreementId: agreement.id },
      orderBy: { position: "asc" },
    });
    expect(items.map((i) => i.externalSourceId)).toEqual([
      "sub_1:po_1",
      "sub_1:po_2",
    ]);
    expect(items.map((i) => i.itemType)).toEqual(["plan", "add_on"]);
    expect(items[0]?.quantity).toBe(1);
    expect(items[1]?.quantity).toBe(5);
    expect(items[0]?.externalPriceId).toBe("po_1");
    expect(items[1]?.externalPriceId).toBe("po_2");
    // Standard units are never written as minor units.
    expect(items[0]?.unitPriceMinor).toBeNull();
    // The plan line names the subscription's offering; the add-on does not.
    expect(items[0]?.externalOfferingId).toBe("off_core");
    expect(items[1]?.externalOfferingId).toBeNull();

    const entitlements = await prisma.agreementEntitlement.findMany({
      where: { agreementId: agreement.id },
    });
    expect(entitlements).toHaveLength(1);
    const entitlement = entitlements[0]!;
    expect(entitlement.externalSourceId).toBe("row_1");
    // No Metrifox catalog handler, so the feature is unlinked but named.
    expect(entitlement.featureId).toBeNull();
    expect(entitlement.externalFeatureId).toBe("seats");
    expect(entitlement.value).toBe("3");
    expect(entitlement.isEnabled).toBe(true);
    expect(readJsonObject(entitlement.providerMetadata)).toMatchObject({
      usage_model: "per_unit",
      aggregation_method: "sum",
    });
  });

  it("stores a null limit as null rather than falling back to the purchased quantity", async () => {
    server.use(...standardEndpoints());
    await connect();

    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "sub_1" },
    });
    const entitlement = await prisma.agreementEntitlement.findFirstOrThrow({
      where: { agreementId: agreement.id },
    });

    // The `unlimited` sentinel is what stops the writer's
    // `limitValue ?? value` fallback: without it this would be 3.
    expect(entitlement.value).toBe("3");
    expect(entitlement.limitValue).toBeNull();
  });

  it("removes a stale entitlement when the summary is empty and complete", async () => {
    server.use(...standardEndpoints());
    await connect();
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "sub_1" },
    });
    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(1);

    server.use(customersEndpoint(), detailsEndpoint(), summaryEndpoint([]));
    const second = await sync();
    expect(second.status).toBe("success");

    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(0);
  });

  it("keeps entitlements when the summary 404s, because completeness is withheld", async () => {
    server.use(...standardEndpoints());
    await connect();
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "sub_1" },
    });
    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(1);

    server.use(
      customersEndpoint(),
      detailsEndpoint(),
      http.get(SUMMARY, () => new HttpResponse(null, { status: 404 }))
    );
    const second = await sync();
    expect(second.status).toBe("success");

    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(1);
  });
});
