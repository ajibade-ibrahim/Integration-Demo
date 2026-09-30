/**
 * A Chargebee agreement sync end to end: `executeSync` over a mocked Chargebee,
 * into a real database.
 *
 * What only this level can check, and why each case is here:
 *
 *   - the effective-entitlement fan-out is one request per subscription, so the
 *     `complete` flag it withholds or sets only means anything once the engine
 *     has ANDed it across pages and the writer has honoured it against real
 *     rows;
 *   - the delete path. Every test that ends by asserting a row *survives* is
 *     guarding the one thing `complete` exists for;
 *   - the 404 case, where the Entitlements feature is off for the whole site
 *     and the handler must neither delete nor fail.
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
import {
  CHARGEBEE_FIXTURE_SUBSCRIPTION_1,
  CHARGEBEE_FIXTURE_SUBSCRIPTION_2,
  CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1,
  CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1,
  CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY,
} from "@/core/providers/chargebee/fixtures";

const USER_ID = "user-chargebee-agreement-sync";
const INTEGRATION_ID = "integration-chargebee-agreement-sync";
const SITE = "acme-test";

const SUBSCRIPTIONS_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/subscriptions`;
const ENTITLEMENTS_ENDPOINT = `https://${SITE}.chargebee.com/api/v2/subscriptions/:subscriptionId/subscription_entitlements`;

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "chargebee-agreement-sync@example.test" },
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
      providerName: "chargebee",
      status: "active",
      instanceLabel: "Chargebee agreement sync",
      functions: {
        create: functionNames.map((functionName) => ({ functionName })),
      },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: `${SITE}:chb_test_key`,
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: { site: SITE },
  });

  for (const functionName of functionNames) {
    await saveMappings(
      INTEGRATION_ID,
      functionName,
      defaultMappingsFor(functionName, "chargebee")
    );
  }
}

/** The subscriptions list plus the empty entitlement fan-out default mappings expect. */
function standardEndpoints() {
  return [
    http.get(SUBSCRIPTIONS_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
    ),
    http.get(ENTITLEMENTS_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY)
    ),
  ];
}

function entitlementsBySubscription() {
  return [
    http.get(SUBSCRIPTIONS_ENDPOINT, () =>
      HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
    ),
    http.get(ENTITLEMENTS_ENDPOINT, ({ params }) =>
      HttpResponse.json(
        String(params["subscriptionId"]) === "cb_sub_acme"
          ? CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1
          : CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY
      )
    ),
  ];
}

async function sync() {
  return executeSync(INTEGRATION_ID, {
    clock: createFakeClock(1_700_000_000_000),
  });
}

describe("Chargebee agreement sync", () => {
  it("writes the agreement, its subscription detail and its inline lines", async () => {
    server.use(...standardEndpoints());
    await connect(["agreement"]);

    const result = await sync();
    expect(result.status).toBe("success");

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "cb_sub_acme",
      },
    });
    expect(agreement.name).toBe("cb_price_analytics_pro_monthly");
    expect(agreement.agreementType).toBe("subscription");
    expect(agreement.status).toBe("active");
    expect(agreement.currency).toBe("usd");

    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { agreementId: agreement.id },
    });
    expect(subscription.billingPeriod).toBe("month");
    expect(subscription.billingPeriodCount).toBe(1);
    expect(subscription.collectionMethod).toBe("automatic");
    expect(subscription.itemCount).toBe(2);
    expect(subscription.nextBillingAt).not.toBeNull();
    // The provider bag is parsed JSON, not the raw string.
    expect(readJsonObject(subscription.providerMetadata)).toEqual({
      po: "PO-42",
    });

    const items = await prisma.agreementItem.findMany({
      where: { agreementId: agreement.id },
      orderBy: { position: "asc" },
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.itemType)).toEqual(["plan", "add_on"]);
    // Chargebee inlines the per-subscription unit price.
    expect(items[0]?.unitPriceMinor).toBe(9900);
    expect(items[1]?.quantity).toBe(5);
    // The offering link stays null — the list payload omits the item price's
    // product — but the provider's price id is retained.
    expect(items[0]?.externalPriceId).toBe("cb_price_analytics_pro_monthly");
  });

  it("fans out the effective entitlements, one request per subscription", async () => {
    const requested: string[] = [];
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
      ),
      http.get(ENTITLEMENTS_ENDPOINT, ({ params }) => {
        const id = String(params["subscriptionId"]);
        requested.push(id);
        return HttpResponse.json(
          id === "cb_sub_acme"
            ? CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1
            : CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY
        );
      })
    );
    await connect(["agreement"]);

    await sync();

    expect(requested.sort()).toEqual(["cb_sub_acme", "cb_sub_globex"]);

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cb_sub_acme" },
    });
    const entitlements = await prisma.agreementEntitlement.findMany({
      where: { agreementId: agreement.id },
      orderBy: { value: "desc" },
    });

    expect(entitlements.map((e) => e.externalSourceId).sort()).toEqual([
      "cb_sub_acme:cb_feat_advanced_reports",
      "cb_sub_acme:cb_feat_dashboards",
    ]);
    expect(entitlements.map((e) => e.externalFeatureId).sort()).toEqual([
      "cb_feat_advanced_reports",
      "cb_feat_dashboards",
    ]);

    const dashboards = entitlements.find(
      (e) => e.externalFeatureId === "cb_feat_dashboards"
    );
    expect(dashboards?.value).toBe("50");
    expect(dashboards?.limitValue).toBe(50);
    expect(dashboards?.isOverride).toBe(true);
    expect(dashboards?.isEnabled).toBe(true);

    // A disabled feature is stored, not dropped: "not included" is a fact.
    const reports = entitlements.find(
      (e) => e.externalFeatureId === "cb_feat_advanced_reports"
    );
    expect(reports?.isEnabled).toBe(false);
  });

  it("deletes entitlements an exhausted list no longer contains", async () => {
    server.use(...entitlementsBySubscription());
    await connect(["agreement"]);
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cb_sub_acme" },
    });
    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(2);

    // The next run's list is empty for every subscription, and exhausted —
    // which is exactly what licenses the delete.
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
      ),
      http.get(ENTITLEMENTS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY)
      )
    );
    const second = await sync();
    expect(second.status).toBe("success");

    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(0);
  });

  it("withholds deletion when the entitlement endpoint 404s, and flags the agreement", async () => {
    server.use(...entitlementsBySubscription());
    await connect(["agreement"]);
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cb_sub_acme" },
    });
    const before = await prisma.agreementEntitlement.count({
      where: { agreementId: agreement.id },
    });
    expect(before).toBe(2);

    // The Entitlements feature is off for the whole site: a 404, which is not
    // retryable and would fail the run uncaught if the handler did not expect
    // it.
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
      ),
      http.get(ENTITLEMENTS_ENDPOINT, () =>
        new HttpResponse(null, { status: 404 })
      )
    );
    const second = await sync();
    expect(second.status).toBe("success");

    // Nothing deleted, because the list never declared completeness.
    expect(
      await prisma.agreementEntitlement.count({ where: { agreementId: agreement.id } })
    ).toBe(before);

    // And the withholding is visible rather than silent.
    const refreshed = await prisma.agreement.findFirstOrThrow({
      where: { id: agreement.id },
    });
    expect(readJsonObject(refreshed.providerMetadata)).toEqual({
      po: "PO-42",
      entitlements: "site_feature_disabled",
    });
  });

  it("deletes a vanished discount and keeps one whose key was withheld", async () => {
    server.use(...entitlementsBySubscription());
    await connect(["agreement"]);
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cb_sub_acme" },
    });
    expect(
      await prisma.agreementDiscount.count({ where: { agreementId: agreement.id } })
    ).toBe(1);

    // Both subscriptions carry an empty `discounts` key, so the object's list
    // is complete and the missing discount is reconciled away.
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json({
          list: [
            {
              subscription: {
                ...CHARGEBEE_FIXTURE_SUBSCRIPTION_1,
                discounts: [],
              },
            },
            { subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_2 },
          ],
        })
      ),
      http.get(ENTITLEMENTS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY)
      )
    );
    await sync();

    expect(
      await prisma.agreementDiscount.count({ where: { agreementId: agreement.id } })
    ).toBe(0);
  });

  it("withholds deletion when one page omits the discounts key", async () => {
    server.use(...entitlementsBySubscription());
    await connect(["agreement"]);
    await sync();

    const agreement = await prisma.agreement.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, externalSourceId: "cb_sub_acme" },
    });
    expect(
      await prisma.agreementDiscount.count({ where: { agreementId: agreement.id } })
    ).toBe(1);

    // The second subscription omits the key entirely, which is not the same as
    // an empty list. The AND across pages must disable deletion for the object.
    const withoutKey = { ...CHARGEBEE_FIXTURE_SUBSCRIPTION_1 };
    delete (withoutKey as Record<string, unknown>)["discounts"];

    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json({
          list: [
            { subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_2 },
            { subscription: withoutKey },
          ],
        })
      ),
      http.get(ENTITLEMENTS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY)
      )
    );
    await sync();

    // The discount survives because the run could not promise the list was whole.
    expect(
      await prisma.agreementDiscount.count({ where: { agreementId: agreement.id } })
    ).toBe(1);
  });

  it("follows next_offset on the subscription list", async () => {
    const offsets: (string | null)[] = [];
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("next_offset");
        offsets.push(offset);
        return HttpResponse.json(
          offset === null
            ? {
                list: [{ subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_1 }],
                next_offset: "cb_off_2",
              }
            : { list: [{ subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_2 }] }
        );
      }),
      http.get(ENTITLEMENTS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY)
      )
    );
    await connect(["agreement"]);

    await sync();

    expect(offsets).toEqual([null, "cb_off_2"]);
    expect(
      await prisma.agreement.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(2);
  });

  it("does not fan out entitlements when no rule targets them", async () => {
    // `onUnhandledRequest: "error"` would fail any entitlement request, but the
    // count is asserted too so the intent survives a config change.
    let entitlementRequests = 0;
    server.use(
      http.get(SUBSCRIPTIONS_ENDPOINT, () =>
        HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1)
      ),
      http.get(ENTITLEMENTS_ENDPOINT, () => {
        entitlementRequests += 1;
        return HttpResponse.json(CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY);
      })
    );

    await prisma.integration.create({
      data: {
        id: INTEGRATION_ID,
        userId: USER_ID,
        providerName: "chargebee",
        status: "active",
        instanceLabel: "Chargebee agreement sync",
        functions: { create: [{ functionName: "agreement" }] },
      },
    });
    await saveToken({
      integrationId: INTEGRATION_ID,
      accessToken: `${SITE}:chb_test_key`,
      expiresAt: NON_EXPIRING_AT,
      grantedScopes: [],
      metadata: { site: SITE },
    });
    // Only the agreement and subscription objects are mapped.
    await saveMappings(
      INTEGRATION_ID,
      "agreement",
      defaultMappingsFor("agreement", "chargebee").filter(
        (rule) =>
          rule.targetObject === "agreement" ||
          rule.targetObject === "subscription" ||
          rule.targetObject === "agreementItem"
      )
    );

    await sync();

    expect(entitlementRequests).toBe(0);
  });
});
