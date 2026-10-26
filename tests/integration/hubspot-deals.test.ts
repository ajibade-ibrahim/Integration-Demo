/**
 * HubSpot's deal handler against a mocked CRM.
 *
 * What carries the risk here: the second paginated list (line items), the line
 * between raw deal facts and our agreement vocabulary, the company association
 * that becomes the customer link, and the `complete` claim the reconciling
 * agreement-item writer trusts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { hubspotAgreementHandler } from "@/core/providers/hubspot/agreement-handler";
import { hubspotFieldDiscovery } from "@/core/providers/hubspot/discovery";
import { collect, testContext } from "./helpers";

const BASE = "https://api.hubapi.com";
const DEALS = `${BASE}/crm/v3/objects/deals`;
const LINE_ITEMS = `${BASE}/crm/v3/objects/line_items`;
const DEAL_PROPERTIES = `${BASE}/crm/v3/properties/deals`;
const LINE_ITEM_PROPERTIES = `${BASE}/crm/v3/properties/line_items`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

interface DealOverrides {
  properties?: Record<string, string>;
  companyId?: string;
}

function deal(id: string, overrides: DealOverrides = {}) {
  return {
    id,
    properties: {
      dealname: `Deal ${id}`,
      amount: "100.00",
      dealstage: "appointmentscheduled",
      pipeline: "default",
      dealtype: "newbusiness",
      createdate: "2024-01-01T00:00:00.000Z",
      closedate: "2024-06-01T00:00:00.000Z",
      deal_currency_code: "USD",
      hs_is_closed: "false",
      hs_is_closed_won: "false",
      hs_is_closed_lost: "false",
      ...overrides.properties,
    },
    associations: {
      companies: {
        results:
          overrides.companyId === undefined
            ? []
            : [{ id: overrides.companyId, type: "deal_to_company" }],
      },
    },
  };
}

function lineItem(
  id: string,
  dealId: string | undefined,
  properties: Record<string, string> = {}
) {
  return {
    id,
    properties: {
      name: `Line ${id}`,
      quantity: "2",
      price: "49.00",
      amount: "98.00",
      discount: "0",
      hs_product_id: `prod_${id}`,
      hs_sku: `SKU-${id}`,
      hs_line_item_currency_code: "USD",
      hs_position_on_quote: "0",
      hs_recurring_billing_number_of_payments: "12",
      recurringbillingfrequency: "monthly",
      ...properties,
    },
    associations: {
      deals: {
        results:
          dealId === undefined
            ? []
            : [{ id: dealId, type: "line_item_to_deal" }],
      },
    },
  };
}

function pagedEndpoint(
  url: string,
  pages: Array<Array<Record<string, unknown>>>,
  seen?: string[]
) {
  return http.get(url, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get("after");
    seen?.push(cursor ?? "(none)");

    const index =
      cursor === null
        ? 0
        : pages.findIndex((page) => page.at(-1)?.["id"] === cursor) + 1;
    const results = pages[index] ?? [];
    const last = results.at(-1);
    const next =
      index < pages.length - 1 && last !== undefined
        ? { after: String(last["id"]) }
        : undefined;

    return HttpResponse.json({
      results,
      ...(next === undefined ? {} : { paging: { next } }),
    });
  });
}

describe("HubSpot deal synthesis", () => {
  it("keeps raw deal facts without inventing agreement status or dates", async () => {
    server.use(
      pagedEndpoint(DEALS, [
        [
          deal("deal-won", {
            companyId: "101",
            properties: {
              dealname: "Acme renewal",
              hs_is_closed: "true",
              hs_is_closed_won: "true",
              amount: "12000.00",
            },
          }),
          deal("deal-open"),
          deal("deal-lost", {
            properties: {
              hs_is_closed: "true",
              hs_is_closed_lost: "true",
            },
          }),
          deal("deal-closed-unknown", {
            properties: { hs_is_closed: "true" },
          }),
        ],
      ])
    );

    const { ctx } = testContext({ sources: { agreement: ["agreement_name"] } });
    const { byObject } = await collect(hubspotAgreementHandler, ctx);

    const won = byObject.agreement.find((r) => r["id"] === "deal-won");
    expect(won?.["agreement_name"]).toBe("Acme renewal");
    expect(won?.["agreement_type"]).toBe("deal");
    expect(won?.["currency"]).toBe("USD");
    // These are not HubSpot facts. The closed flags and CRM dates stay below,
    // in metadata, rather than being promoted to our lifecycle vocabulary.
    expect(won).not.toHaveProperty("agreement_status");
    expect(won).not.toHaveProperty("effective_date");
    expect(won).not.toHaveProperty("end_date");
    expect(JSON.parse(String(won?.["provider_metadata"]))).toMatchObject({
      dealname: "Acme renewal",
      dealstage: "appointmentscheduled",
      pipeline: "default",
      amount: "12000.00",
      createdate: "2024-01-01T00:00:00.000Z",
      closedate: "2024-06-01T00:00:00.000Z",
      deal_currency_code: "USD",
      hs_is_closed: "true",
      hs_is_closed_won: "true",
    });

    const open = byObject.agreement.find((r) => r["id"] === "deal-open");
    expect(open?.["agreement_name"]).toBe("Deal deal-open");
    expect(open).not.toHaveProperty("agreement_status");
    expect(open).not.toHaveProperty("effective_date");
    // An open deal's close date is a forecast, and is kept only as a raw fact.
    expect(open).not.toHaveProperty("end_date");
    expect(JSON.parse(String(open?.["provider_metadata"]))).toMatchObject({
      closedate: "2024-06-01T00:00:00.000Z",
      hs_is_closed: "false",
      hs_is_closed_won: "false",
    });

    const lost = byObject.agreement.find((r) => r["id"] === "deal-lost");
    expect(lost).not.toHaveProperty("agreement_status");
    expect(JSON.parse(String(lost?.["provider_metadata"]))).toMatchObject({
      hs_is_closed: "true",
      hs_is_closed_lost: "true",
    });

    const unknown = byObject.agreement.find(
      (r) => r["id"] === "deal-closed-unknown"
    );
    expect(unknown).not.toHaveProperty("agreement_status");
    expect(JSON.parse(String(unknown?.["provider_metadata"]))).toMatchObject({
      hs_is_closed: "true",
    });

    expect(
      hubspotAgreementHandler.externalRefsOf(byObject.agreement[0]!, "agreement")
    ).toEqual({ customer: "101" });
    expect(
      hubspotAgreementHandler.externalRefsOf(byObject.agreement[1]!, "agreement")
    ).toEqual({ customer: undefined });
  });

  it("falls back to an id-based name when a deal has none", async () => {
    server.use(
      pagedEndpoint(DEALS, [[deal("deal-1", { properties: { dealname: "" } })]]),
    );

    const { ctx } = testContext({ sources: { agreement: ["agreement_name"] } });
    const { byObject } = await collect(hubspotAgreementHandler, ctx);

    expect(byObject.agreement[0]?.["agreement_name"]).toBe("Deal deal-1");
  });

  it("requests the synthesis properties plus every mapped property", async () => {
    let seen: URL | undefined;
    server.use(
      http.get(DEALS, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ results: [deal("deal-1")] });
      })
    );

    const { ctx } = testContext({
      sources: {
        agreement: ["properties.dealname", "properties.hubspot_owner_id"],
      },
    });
    await collect(hubspotAgreementHandler, ctx);

    const properties = seen?.searchParams.get("properties")?.split(",") ?? [];
    expect(properties).toEqual(
      expect.arrayContaining([
        "dealname",
        "dealstage",
        "pipeline",
        "createdate",
        "closedate",
        "deal_currency_code",
        "hs_is_closed",
        "hs_is_closed_won",
        "hs_is_closed_lost",
        "hubspot_owner_id",
      ])
    );
    expect(properties.filter((p) => p === "dealname")).toHaveLength(1);
    expect(seen?.searchParams.get("associations")).toBe("companies");
  });

  it("follows the after cursor and stops on the final page", async () => {
    const seen: string[] = [];
    server.use(
      pagedEndpoint(
        DEALS,
        [[deal("deal-1")], [deal("deal-2")], [deal("deal-3")]],
        seen
      )
    );

    const { ctx } = testContext({ sources: { agreement: ["agreement_name"] } });
    const { byObject } = await collect(hubspotAgreementHandler, ctx);

    expect(seen).toEqual(["(none)", "deal-1", "deal-2"]);
    expect(byObject.agreement.map((r) => r["id"])).toEqual([
      "deal-1",
      "deal-2",
      "deal-3",
    ]);
  });

  it("fails rather than claiming a list it could not finish", async () => {
    server.use(
      http.get(DEALS, () =>
        HttpResponse.json({
          results: [deal("deal-1")],
          paging: { next: { after: "stuck" } },
        })
      )
    );

    const { ctx } = testContext({ sources: { agreement: ["agreement_name"] } });
    await expect(collect(hubspotAgreementHandler, ctx)).rejects.toThrow(
      /pagination cursor/
    );
  });
});

describe("HubSpot line items", () => {
  it("does not read line items when agreementItem is unmapped", async () => {
    let lineItemRequests = 0;
    server.use(
      pagedEndpoint(DEALS, [[deal("deal-1")]]),
      http.get(LINE_ITEMS, () => {
        lineItemRequests += 1;
        return HttpResponse.json({ results: [] });
      })
    );

    const { ctx } = testContext({ sources: { agreement: ["agreement_name"] } });
    const { pages, byObject } = await collect(hubspotAgreementHandler, ctx);

    expect(lineItemRequests).toBe(0);
    expect(pages.map((p) => p.object)).toEqual(["agreement"]);
    expect(byObject.agreementItem).toEqual([]);
  });

  it("groups lines by deal, assigns positions and claims completeness", async () => {
    const seen: string[] = [];
    server.use(
      pagedEndpoint(DEALS, [[deal("deal-1"), deal("deal-2")]]),
      pagedEndpoint(
        LINE_ITEMS,
        [
          [lineItem("li-1", "deal-1"), lineItem("li-2", "deal-2")],
          [
            lineItem("li-3", "deal-1"),
            lineItem("li-4", undefined),
            lineItem("li-5", "deal-missing"),
          ],
        ],
        seen
      )
    );

    const { ctx } = testContext({
      sources: {
        agreement: ["agreement_name"],
        agreementItem: ["properties.quantity", "position"],
      },
    });
    const { pages, byObject } = await collect(hubspotAgreementHandler, ctx);

    expect(seen).toEqual(["(none)", "li-2"]);
    expect(pages.map((p) => p.object)).toEqual([
      "agreement",
      "agreementItem",
      "agreementItem",
    ]);
    expect(
      pages
        .filter((p) => p.object === "agreementItem")
        .every((p) => p.complete === true)
    ).toBe(true);

    expect(byObject.agreementItem.map((r) => r["id"])).toEqual([
      "li-1",
      "li-2",
      "li-3",
    ]);
    expect(byObject.agreementItem.map((r) => r["position"])).toEqual([0, 0, 1]);

    const first = byObject.agreementItem[0]!;
    expect(hubspotAgreementHandler.externalRefsOf(first, "agreementItem")).toEqual({
      agreement: "deal-1",
      offering: "prod_li-1",
    });
  });

  it("asks for the synthesis properties and deal associations", async () => {
    let seen: URL | undefined;
    server.use(
      pagedEndpoint(DEALS, [[deal("deal-1")]]),
      http.get(LINE_ITEMS, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ results: [lineItem("li-1", "deal-1")] });
      })
    );

    const { ctx } = testContext({
      sources: {
        agreement: ["agreement_name"],
        agreementItem: ["properties.hs_sku"],
      },
    });
    await collect(hubspotAgreementHandler, ctx);

    const properties = seen?.searchParams.get("properties")?.split(",") ?? [];
    expect(properties).toEqual(
      expect.arrayContaining([
        "quantity",
        "price",
        "amount",
        "hs_product_id",
        "hs_line_item_currency_code",
        "hs_sku",
      ])
    );
    expect(seen?.searchParams.get("associations")).toBe("deals");
  });
});

describe("HubSpot deal discovery", () => {
  it("lists deal and line-item properties plus the synthesized fields", async () => {
    server.use(
      http.get(DEAL_PROPERTIES, () =>
        HttpResponse.json({
          results: [
            {
              name: "dealname",
              label: "Deal name",
              type: "string",
            },
            {
              name: "amount",
              label: "Amount",
              type: "number",
            },
            {
              name: "hidden_prop",
              label: "Hidden",
              type: "string",
              hidden: true,
            },
          ],
        })
      ),
      http.get(LINE_ITEM_PROPERTIES, () =>
        HttpResponse.json({
          results: [
            {
              name: "quantity",
              label: "Quantity",
              type: "number",
            },
          ],
        })
      )
    );

    const { ctx } = testContext();

    const agreement = await hubspotFieldDiscovery.discover(ctx, "agreement");
    const agreementPaths = agreement.map((f) => f.path);
    expect(agreementPaths).toEqual(
      expect.arrayContaining([
        "agreement_name",
        "agreement_type",
        "currency",
        "provider_metadata",
        "properties.dealname",
        "properties.amount",
      ])
    );
    expect(agreementPaths).not.toContain("properties.hidden_prop");
    // Retired synthesized fields: the raw properties remain discoverable.
    expect(agreementPaths).not.toContain("agreement_status");
    expect(agreementPaths).not.toContain("effective_date");
    expect(agreementPaths).not.toContain("end_date");

    const items = await hubspotFieldDiscovery.discover(ctx, "agreementItem");
    expect(items.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "position",
        "provider_metadata",
        "properties.quantity",
      ])
    );
  });

  it("returns no fields for an object HubSpot does not serve", async () => {
    const { ctx } = testContext();
    await expect(
      hubspotFieldDiscovery.discover(ctx, "subscription")
    ).resolves.toEqual([]);
  });
});
