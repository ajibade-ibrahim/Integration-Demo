/**
 * An agreement sync end to end: `executeSync` over a mocked Stripe, into a real
 * database.
 *
 * This is the suite's first record with **two parents**, and both of them are
 * written by other functions. Most of what is worth testing here follows from
 * that, and none of it is reachable from a unit test:
 *
 *   - an agreement resolving a customer from `identity` and an offering from
 *     `catalog`, neither of which is in its own run's index;
 *   - the same agreement with one half resolved and one half not, which the
 *     single-parent writer could not represent at all;
 *   - the relink pass repairing both edges on a later run;
 *   - a rejected agreement taking its subscription with it, because the child's
 *     foreign key is required rather than nullable.
 *
 * Mirrors `catalog-sync.test.ts` case for case where the cases still apply.
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
import { readJsonCounts } from "@/core/repositories/json-column";
import { createFakeClock } from "@/core/sync/clock";

const USER_ID = "user-agreement-sync";
const INTEGRATION_ID = "integration-agreement-sync";

const SUBSCRIPTIONS = "https://api.stripe.com/v1/subscriptions";
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
    create: { id: USER_ID, email: "agreement-sync@example.test" },
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
      providerName: "stripe",
      status: "active",
      instanceLabel: "Agreement sync",
      functions: {
        create: functionNames.map((functionName) => ({ functionName })),
      },
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

const PRICE = {
  id: "price_monthly",
  object: "price",
  product: "prod_widget",
  active: true,
  currency: "usd",
  unit_amount: 4900,
  nickname: null,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  created: 1_680_893_993,
  metadata: {},
};

const PRODUCT = {
  id: "prod_widget",
  object: "product",
  name: "Widget",
  description: "A widget",
  active: true,
  created: 1_680_893_993,
  metadata: {},
};

const CUSTOMER = {
  id: "cus_acme",
  object: "customer",
  name: "Acme",
  email: "billing@acme.test",
  created: 1_680_893_993,
  metadata: {},
};

/**
 * A Stripe subscription, with its price expanded inside the item as Stripe
 * returns it. The expansion is what makes the name synthesis possible without a
 * second request, so a fixture that flattened it would be testing an easier
 * problem than the real one.
 */
function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_acme",
    object: "subscription",
    customer: "cus_acme",
    status: "active",
    collection_method: "charge_automatically",
    currency: "usd",
    cancel_at_period_end: false,
    canceled_at: null,
    start_date: 1_680_893_993,
    trial_end: null,
    created: 1_680_893_993,
    // The period dates sit on the *item*, not here, because that is where
    // Stripe puts them today - confirmed against a live sandbox. The older
    // subscription-level shape is covered in tests/unit/stripe-agreement.test.ts;
    // this suite carries the current one so the whole path from handler to
    // column is exercised against what the API actually sends.
    items: {
      object: "list",
      has_more: false,
      data: [
        {
          id: "si_1",
          object: "subscription_item",
          price: PRICE,
          quantity: 3,
          current_period_start: 1_699_000_000,
          current_period_end: 1_701_678_400,
        },
      ],
    },
    metadata: {},
    ...overrides,
  };
}

/** Everything the catalog and identity functions need, plus subscriptions. */
function serveAll(subs: Array<Record<string, unknown>> = [subscription()]) {
  server.use(
    http.get(SUBSCRIPTIONS, () => listing(subs)),
    http.get(PRODUCTS, () => listing([PRODUCT])),
    http.get(PRICES, () => listing([PRICE])),
    http.get(CUSTOMERS, () => listing([CUSTOMER]))
  );
}

describe("an agreement sync, end to end", () => {
  it("writes an agreement and its subscription, linked to both parents", async () => {
    serveAll();
    await connect(["identity", "catalog", "agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("success");

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, offering: true, subscription: true },
    });

    // The whole chain in one assertion: Stripe sent no name, so the handler
    // built one from the price nested inside the item; the status came back in
    // our vocabulary rather than Stripe's; both parents resolved across
    // function boundaries; and the detail row attached to it.
    expect(agreement.name).toBe("$49/month");
    expect(agreement.agreementType).toBe("subscription");
    expect(agreement.status).toBe("active");
    expect(agreement.customer?.name).toBe("Acme");
    expect(agreement.offering?.externalSourceId).toBe("price_monthly");
    expect(agreement.subscription?.quantity).toBe(3);
    expect(agreement.subscription?.currentPeriodEnd?.toISOString()).toBe(
      new Date(1_701_678_400 * 1000).toISOString()
    );
  });

  it("asks Stripe for canceled subscriptions too", async () => {
    // Not a detail. Stripe's default is to list live subscriptions only, and
    // this system has no absence detection — so without `status=all` a
    // subscription canceled at Stripe would read as active here forever.
    const seen: string[] = [];
    server.use(
      http.get(SUBSCRIPTIONS, ({ request }) => {
        seen.push(request.url);
        return listing([subscription()]);
      })
    );
    await connect(["agreement"]);

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).searchParams.get("status")).toBe("all");
  });

  it("records a canceled subscription as canceled rather than dropping it", async () => {
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        listing([
          subscription({ status: "canceled", canceled_at: 1_700_500_000 }),
        ])
      )
    );
    await connect(["agreement"]);

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { subscription: true },
    });
    expect(agreement.status).toBe("canceled");
    expect(agreement.subscription?.canceledAt).not.toBeNull();
  });

  it("records per-object counts for both halves", async () => {
    serveAll();
    await connect(["agreement"]);

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });

    // Three rows from one source record, and all three are counted. The same
    // thing happens for Stripe identity, whose contacts are derived from its
    // customers — so the run report is at least consistent about it.
    //
    // The item count is the one that need not match: a subscription yields one
    // agreement and one subscription however many lines it carries, and this
    // fixture carries one.
    expect(readJsonCounts(run.recordCountsJson)).toEqual({
      agreement: 1,
      subscription: 1,
      agreementItem: 1,
    });
  });

  it("is idempotent across runs", async () => {
    serveAll();
    await connect(["identity", "catalog", "agreement"]);

    const clock = createFakeClock(1_700_000_000_000);
    await executeSync(INTEGRATION_ID, { clock });
    await executeSync(INTEGRATION_ID, { clock });

    expect(
      await prisma.agreement.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);
    expect(
      await prisma.subscription.count({
        where: { integrationId: INTEGRATION_ID },
      })
    ).toBe(1);
  });
});

describe("two parents, resolved independently", () => {
  it("keeps an agreement whose parents are missing, and links both later", async () => {
    // The case the single-parent writer could not express. An agreement-only
    // integration has no customers and no offerings to resolve against, so
    // both halves dangle — and both must repair themselves once the other
    // functions run.
    server.use(http.get(SUBSCRIPTIONS, () => listing([subscription()])));
    await connect(["agreement"]);

    const clock = createFakeClock(1_700_000_000_000);
    const first = await executeSync(INTEGRATION_ID, { clock });

    // Warnings, not rejections: an agreement with no links is still a real
    // agreement, and dropping it would lose the name, status and dates too.
    expect(first.status).toBe("success");
    expect(first.issues.every((i) => i.severity === "warning")).toBe(true);
    // One per unresolved half, plus the line item's own unresolved offering.
    // Three rather than two, and the third is not noise: the agreement's
    // offering link and its line's are separate columns that repair
    // separately, so a report naming only one of them would understate what
    // is dangling.
    expect(
      first.issues.map((i) => `${i.targetObject}.${i.fieldName}`).sort()
    ).toEqual([
      "agreement.associatedCustomerId",
      "agreement.associatedOfferingId",
      "agreementItem.associatedOfferingId",
    ]);

    const dangling = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(dangling.customerId).toBeNull();
    expect(dangling.offeringId).toBeNull();
    // The provider's own ids are retained, which is what makes the repair
    // possible at all.
    expect(dangling.externalCustomerId).toBe("cus_acme");
    expect(dangling.externalOfferingId).toBe("price_monthly");

    // Add the other two functions and sync again.
    await prisma.integrationFunction.createMany({
      data: [
        { integrationId: INTEGRATION_ID, functionName: "identity" },
        { integrationId: INTEGRATION_ID, functionName: "catalog" },
      ],
    });
    for (const functionName of ["identity", "catalog"]) {
      await saveMappings(
        INTEGRATION_ID,
        functionName,
        defaultMappingsFor(functionName, "stripe")
      );
    }
    server.resetHandlers();
    serveAll();

    await executeSync(INTEGRATION_ID, { clock });

    const linked = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, offering: true },
    });
    expect(linked.customer?.name).toBe("Acme");
    expect(linked.offering?.externalSourceId).toBe("price_monthly");

    // The line repaired itself too, through its own relink pass rather than
    // the agreement's. Asserted separately because they are separate columns
    // and a single pass repairing only one of them would still let this
    // agreement look fully linked.
    const item = await prisma.agreementItem.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { offering: true },
    });
    expect(item.offering?.externalSourceId).toBe("price_monthly");
  });

  it("warns about each unresolved half separately", async () => {
    // Half-resolved is the state the old shape had no way to record: identity
    // is connected, catalog is not, so the customer links and the offering
    // does not. One warning, not two, and not a blanket "unresolved".
    server.use(
      http.get(SUBSCRIPTIONS, () => listing([subscription()])),
      http.get(CUSTOMERS, () => listing([CUSTOMER]))
    );
    await connect(["identity", "agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    const fields = result.issues
      .filter((i) => i.targetObject === "agreement")
      .map((i) => i.fieldName);
    expect(fields).toEqual(["associatedOfferingId"]);

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(agreement.customerId).not.toBeNull();
    expect(agreement.offeringId).toBeNull();
  });
});

describe("the subscription half", () => {
  it("rejects a subscription whose agreement was rejected", async () => {
    // A blank name rejects the agreement. The subscription row would then have
    // no agreement to attach to, and its foreign key is required — so it is
    // rejected rather than written unlinked, which is the one place this
    // family differs from offering-without-product.
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        listing([
          {
            ...subscription(),
            // No id anywhere for the name to fall back to, and no price to
            // build one from.
            id: "",
            items: { object: "list", has_more: false, data: [] },
          },
        ])
      )
    );
    await connect(["agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("partial");
    expect(
      result.issues.every((i) => i.severity === "rejected")
    ).toBe(true);
    expect(
      await prisma.agreement.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
    expect(
      await prisma.subscription.count({
        where: { integrationId: INTEGRATION_ID },
      })
    ).toBe(0);
  });

  it("warns when a subscription carries more priced items than it can link", async () => {
    // A base plan plus seats plus a metered add-on is one subscription with
    // three prices, and only the first is linked. `itemCount` plus this warning
    // are the only things on the row that say the other two exist — without
    // them a subscription billing $349 reads as $49/month with no clue why.
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        listing([
          subscription({
            items: {
              object: "list",
              has_more: false,
              data: [
                { id: "si_1", object: "subscription_item", price: PRICE, quantity: 1 },
                {
                  id: "si_2",
                  object: "subscription_item",
                  price: { ...PRICE, id: "price_seat", unit_amount: 1200 },
                  quantity: 25,
                },
                {
                  id: "si_3",
                  object: "subscription_item",
                  price: { ...PRICE, id: "price_metered", unit_amount: null },
                  quantity: 1,
                },
              ],
            },
          }),
        ])
      )
    );
    await connect(["agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    const warning = result.issues.find((i) => i.fieldName === "itemCount");
    expect(warning?.severity).toBe("warning");
    expect(warning?.reason).toMatch(/3 priced items/);

    const row = await prisma.subscription.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.itemCount).toBe(3);

    // The first item is the one linked, and the agreement's name comes from it.
    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(agreement.externalOfferingId).toBe("price_monthly");
  });

  it("cascades away with its agreement", async () => {
    // The FK is `Cascade` rather than `SetNull`, unlike every other
    // association here. Deleting the integration must leave neither table
    // holding rows, and `Subscription` is reachable by two cascade paths.
    serveAll();
    await connect(["agreement"]);
    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    await prisma.integration.delete({ where: { id: INTEGRATION_ID } });

    expect(
      await prisma.agreement.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
    expect(
      await prisma.subscription.count({
        where: { integrationId: INTEGRATION_ID },
      })
    ).toBe(0);
    // Two cascades deep — the item hangs off the agreement, which hangs off
    // the integration — so this is the one that would survive a `SetNull`
    // written where a `Cascade` belongs.
    expect(
      await prisma.agreementItem.count({
        where: { integrationId: INTEGRATION_ID },
      })
    ).toBe(0);
  });
});

/**
 * The completeness contract, asserted on the wire.
 *
 * `SyncHandler` obliges a handler that yields any line for an agreement to
 * yield *all* of them, and `writeAgreementItems` deletes on the strength of
 * that. Stripe inlines only the first ten items, so meeting the obligation
 * means a second request — and the assertion has to be the **request count**,
 * not just the resulting rows. A handler that silently returned the inlined
 * ten would produce a plausible-looking set of rows here and quietly delete
 * every line past the tenth on the next sync.
 */
describe("completing a truncated item list", () => {
  const SUBSCRIPTION_ITEMS = "https://api.stripe.com/v1/subscription_items";

  function item(id: string, position: number) {
    return {
      id,
      object: "subscription_item",
      price: PRICE,
      quantity: position + 1,
      current_period_start: 1_699_000_000,
      current_period_end: 1_701_678_400,
    };
  }

  it("makes no extra request when Stripe says the list is whole", async () => {
    let itemRequests = 0;
    server.use(
      http.get(SUBSCRIPTIONS, () => listing([subscription()])),
      http.get(SUBSCRIPTION_ITEMS, () => {
        itemRequests += 1;
        return listing([]);
      })
    );
    await connect(["agreement"]);

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    // The common case, and it must stay free. Paying a request per
    // subscription to re-read a list already in hand would make this feature
    // cost more than the sync it rides on.
    expect(itemRequests).toBe(0);
    expect(
      await prisma.agreementItem.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(1);
  });

  it("pages for the rest when Stripe says there are more", async () => {
    let itemRequests = 0;
    const inlined = [item("si_0", 0), item("si_1", 1)];

    server.use(
      http.get(SUBSCRIPTIONS, () =>
        listing([
          subscription({
            items: { object: "list", has_more: true, data: inlined },
          }),
        ])
      ),
      http.get(SUBSCRIPTION_ITEMS, ({ request }) => {
        itemRequests += 1;
        const url = new URL(request.url);
        // The filter is what keeps this from returning another
        // subscription's lines, so it is asserted rather than assumed.
        expect(url.searchParams.get("subscription")).toBe("sub_acme");
        // Resumed after the last inlined item, not from the top — otherwise
        // the first two would arrive twice.
        expect(url.searchParams.get("starting_after")).toBe("si_1");
        return listing([item("si_2", 2)]);
      })
    );
    await connect(["agreement"]);

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(itemRequests).toBe(1);

    const rows = await prisma.agreementItem.findMany({
      where: { integrationId: INTEGRATION_ID },
      orderBy: { position: "asc" },
    });
    // All three, and positioned across the join rather than restarting at
    // zero for the fetched page.
    expect(rows.map((r) => r.externalSourceId)).toEqual([
      "si_0",
      "si_1",
      "si_2",
    ]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("fails the run rather than syncing a list it could not complete", async () => {
    // The direction this has to fail in. A failed sync costs a retry; a
    // successful one that stored a truncated list has the next run delete the
    // lines it did not see.
    server.use(
      http.get(SUBSCRIPTIONS, () =>
        listing([
          subscription({
            items: {
              object: "list",
              has_more: true,
              data: [item("si_0", 0)],
            },
          }),
        ])
      ),
      http.get(SUBSCRIPTION_ITEMS, () =>
        HttpResponse.json({ error: { message: "boom" } }, { status: 500 })
      )
    );
    await connect(["agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("failed");
    expect(
      await prisma.agreementItem.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });
});

describe("the other functions still sync alongside it", () => {
  it("runs all three in one sync and totals them separately", async () => {
    serveAll();
    await connect(["identity", "catalog", "agreement"]);

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(1_700_000_000_000),
    });

    expect(result.status).toBe("success");
    expect(result.recordCounts).toEqual({
      customer: 1,
      contact: 1,
      product: 1,
      offering: 1,
      productFeature: 0,
      agreement: 1,
      subscription: 1,
      agreementItem: 1,
    });
  });
});
