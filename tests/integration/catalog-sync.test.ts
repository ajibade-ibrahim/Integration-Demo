/**
 * A catalog sync end to end: `executeSync` over a mocked Stripe, into a real
 * database.
 *
 * Everything else in this suite tests a layer. This tests the wiring between
 * them — mappings are read for the right function, the registered handler is
 * resolved for (function, provider), its pages are mapped through the user's
 * rules, the writers run parents-first, and the run is recorded with per-object
 * counts. That seam had no coverage at all before the catalog existed, which is
 * why a rewrite of `runOnce` could have broken identity syncs without a single
 * test noticing.
 *
 * So both functions are exercised here, not just the new one. Identity is the
 * regression half: the point is that generalizing the engine did not change
 * what it already did.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { prisma } from "@/lib/prisma";
import { bootstrap } from "@/core/bootstrap";
import { executeSync } from "@/core/sync/sync-engine";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { NON_EXPIRING_AT, saveToken } from "@/core/repositories/token-repository";
import { readJsonCounts } from "@/core/repositories/json-column";
import { createFakeClock } from "@/core/sync/clock";
import type { SyncRunCoverage } from "@/core/types/common";

const USER_ID = "user-catalog-sync";
const INTEGRATION_ID = "integration-catalog-sync";

const PRODUCTS = "https://api.stripe.com/v1/products";
const PRICES = "https://api.stripe.com/v1/prices";
const ENTITLEMENT_FEATURES = "https://api.stripe.com/v1/entitlements/features";
const CUSTOMERS = "https://api.stripe.com/v1/customers";

/**
 * An empty entitlements list, as a *default* handler.
 *
 * The catalog handler probes this endpoint once per sync to decide whether it is
 * worth asking each product for its features, and an empty answer skips the
 * fan-out. Registered here rather than per test so it survives
 * `resetHandlers()`: none of these tests is about the probe — an account with no
 * entitlements is what almost every Stripe account is — and repeating it in
 * every `server.use` would bury the thing each test is actually arranging.
 * `stripe-catalog.test.ts` is where the probe and the fan-out are pinned.
 */
const server = setupServer(
  http.get(ENTITLEMENT_FEATURES, () => listing([]))
);

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "catalog-sync@example.test" },
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
  // A fresh integration per test: the sync engine keys its in-flight guard on
  // the integration id, and `executeSync` writes a SyncRun every time.
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });
});

/**
 * A connected Stripe integration serving `functionNames`, with its shipped
 * default mappings seeded — the same path `finalizeConnection` takes.
 */
async function connect(functionNames: string[]): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Catalog sync",
      functions: { create: functionNames.map((functionName) => ({ functionName })) },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "sk_test_fake",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: {},
  });

  for (const functionName of functionNames) {
    await saveMappings(
      INTEGRATION_ID,
      functionName,
      defaultMappingsFor(functionName, "stripe")
    );
  }
}

function listing(data: Array<Record<string, unknown>>) {
  return HttpResponse.json({ object: "list", has_more: false, data });
}

const PRODUCT = {
  id: "prod_widget",
  object: "product",
  name: "Widget",
  description: "A widget",
  active: true,
  created: 1_680_893_993,
  metadata: {},
};

const PRICE = {
  id: "price_monthly",
  object: "price",
  product: "prod_widget",
  active: true,
  currency: "usd",
  unit_amount: 4900,
  nickname: null,
  billing_scheme: "per_unit",
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  created: 1_680_893_993,
  metadata: {},
};

describe("a catalog sync, end to end", () => {
  it("writes products and offerings through the shipped default mappings", async () => {
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await connect(["catalog"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("success");
    // `feature: 0` and `entitlement: 0`, not absent: the catalog function does
    // write both objects, and this account simply has none. Absent would say
    // "not synced", which is the claim the customer key's absence below makes.
    expect(result.recordCounts).toEqual({
      product: 1,
      offering: 1,
      price: 1,
      feature: 0,
      entitlement: 0,
    });

    const offering = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true, prices: true },
    });

    // The whole chain in one assertion: Stripe's nested `recurring.interval`
    // and null `nickname` arrived as a flat interval and a synthesized name,
    // the default rules mapped them, and the writer linked product→offering→price.
    expect(offering.name).toBe("Widget");
    expect(offering.product?.name).toBe("Widget");

    const price = offering.prices[0];
    expect(price?.name).toBe("$49/month");
    expect(price?.amountMinor).toBe(4900);
    expect(price?.currency).toBe("usd");
    expect(price?.interval).toBe("month");
  });

  it("records per-object counts on the run, with no customer key", async () => {
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await connect(["catalog"]);

    await executeSync(INTEGRATION_ID, { clock: createFakeClock(1_700_000_000_000) });

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });

    // Absent, not zero. A catalog sync claiming "0 customers" would read as a
    // failed identity sync to anyone looking at the run report.
    expect(readJsonCounts(run.recordCountsJson)).toEqual({
      product: 1,
      offering: 1,
      price: 1,
      feature: 0,
      entitlement: 0,
    });

    const coverage = JSON.parse(run.coverageJson) as SyncRunCoverage;
    const catalog = coverage.functions.find(
      (entry) => entry.functionName === "catalog"
    );
    expect(catalog?.objects.find((entry) => entry.object === "product"))
      .toMatchObject({
        mapped: true,
        yielded: true,
        pages: 1,
        recordsRead: 1,
        recordsWritten: 1,
        complete: null,
        atPageLimit: false,
      });
  });

  it("is idempotent across runs", async () => {
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await connect(["catalog"]);

    const clock = createFakeClock(1_700_000_000_000);
    await executeSync(INTEGRATION_ID, { clock });
    await executeSync(INTEGRATION_ID, { clock });

    expect(await prisma.product.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
    expect(await prisma.offering.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
    expect(await prisma.price.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
  });

  it("keeps a price whose offering's product Stripe did not return, and links it later", async () => {
    // Run one: prices only, no products. An archived or filtered product
    // genuinely does not come back, so this is not a contrived case.
    //
    // In the 3-tier model the handler synthesizes offerings from product
    // records, so with no products there is no offering row — only the price
    // record arrives, orphaned against the offering that would have been created
    // had the product come back. The run stays green (warning, not partial).
    server.use(
      http.get(PRODUCTS, () => listing([])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await connect(["catalog"]);

    const clock = createFakeClock(1_700_000_000_000);
    const first = await executeSync(INTEGRATION_ID, { clock });

    // `partial` is reserved for rejected records; a warning keeps the run green.
    expect(first.status).toBe("success");
    expect(first.issues.map((i) => i.severity)).toEqual(["warning"]);
    // But the warning is on the coverage record, so a green status cannot be
    // mistaken for an unqualified complete success.
    const priceCoverage = first.coverage.functions
      .find((entry) => entry.functionName === "catalog")
      ?.objects.find((entry) => entry.object === "price");
    expect(priceCoverage).toMatchObject({ warnings: 1, complete: null });

    // No offering yet — it is synthesised from the product which did not arrive.
    expect(await prisma.offering.count({ where: { integrationId: INTEGRATION_ID } })).toBe(0);
    // The price is retained with no offering link, so it can be linked later.
    const orphanPrice = await prisma.price.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(orphanPrice.offeringId).toBeNull();
    expect(orphanPrice.externalOfferingId).toBe("prod_widget");

    // Run two: the product appears. The offering is synthesised, and the relink
    // pass connects the orphaned price to it without the price itself changing.
    server.resetHandlers();
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await executeSync(INTEGRATION_ID, { clock });

    const offering = await prisma.offering.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { product: true, prices: true },
    });
    expect(offering.product?.externalSourceId).toBe("prod_widget");
    expect(offering.prices[0]?.externalSourceId).toBe("price_monthly");
  });

  it("refuses to run a function with no mappings rather than reporting success", async () => {
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE]))
    );
    await connect(["catalog"]);
    await prisma.fieldMapping.deleteMany({ where: { integrationId: INTEGRATION_ID } });

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no field mappings/i);
  });
});

describe("identity still syncs the way it did", () => {
  it("writes customers and contacts, and reports their counts", async () => {
    // The regression half. Generalizing `runOnce` from a hardcoded
    // customers-then-contacts block to a per-function dispatch must not have
    // changed this.
    server.use(
      http.get(CUSTOMERS, () =>
        listing([
          {
            id: "cus_1",
            object: "customer",
            name: "Acme",
            email: "billing@acme.test",
            phone: null,
            description: null,
            balance: 0,
            delinquent: false,
            currency: "usd",
            created: 1_680_893_993,
            metadata: {},
          },
        ])
      )
    );
    await connect(["identity"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("success");
    // One customer, and the contact Stripe has no resource for — synthesized by
    // the identity handler and linked back to its customer.
    expect(result.recordCounts).toEqual({ customer: 1, contact: 1 });

    const contact = await prisma.contact.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true },
    });
    expect(contact.customer?.name).toBe("Acme");
  });

  it("runs both functions in one sync and totals them separately", async () => {
    server.use(
      http.get(PRODUCTS, () => listing([PRODUCT])),
      http.get(PRICES, () => listing([PRICE])),
      http.get(CUSTOMERS, () =>
        listing([
          {
            id: "cus_1",
            object: "customer",
            name: "Acme",
            email: "billing@acme.test",
            created: 1_680_893_993,
            metadata: {},
          },
        ])
      )
    );
    await connect(["identity", "catalog"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("success");
    expect(result.recordCounts).toEqual({
      customer: 1,
      contact: 1,
      product: 1,
      offering: 1,
      price: 1,
      feature: 0,
      entitlement: 0,
    });
  });

  it("keeps writes and coverage from functions completed before a failure", async () => {
    // Identity runs first and succeeds. Catalog then fails, so the run is
    // failed — but the customer and contact rows are real, and the report must
    // say what was written and how far acquisition got.
    server.use(
      http.get(CUSTOMERS, () =>
        listing([
          {
            id: "cus_1",
            object: "customer",
            name: "Acme",
            email: "billing@acme.test",
            created: 1_680_893_993,
            metadata: {},
          },
        ])
      ),
      http.get(PRODUCTS, () =>
        HttpResponse.json({ error: { message: "boom" } }, { status: 500 })
      )
    );
    await connect(["identity", "catalog"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("failed");
    expect(result.recordCounts).toEqual({ customer: 1, contact: 1 });
    expect(result.coverage.error).toMatch(/boom|500/i);

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(readJsonCounts(run.recordCountsJson)).toEqual({
      customer: 1,
      contact: 1,
    });

    const coverage = JSON.parse(run.coverageJson) as SyncRunCoverage;
    const identity = coverage.functions.find(
      (entry) => entry.functionName === "identity"
    );
    expect(identity?.objects.find((entry) => entry.object === "customer"))
      .toMatchObject({
        mapped: true,
        yielded: true,
        recordsRead: 1,
        recordsWritten: 1,
      });

    const catalog = coverage.functions.find(
      (entry) => entry.functionName === "catalog"
    );
    expect(catalog?.error).toMatch(/boom|500/i);
    expect(catalog?.objects.find((entry) => entry.object === "product"))
      .toMatchObject({ mapped: true, yielded: false });
  });
});
