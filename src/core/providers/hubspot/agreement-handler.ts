/**
 * HubSpot's `agreement` function: deals as agreements and deal line items as
 * agreement items.
 *
 * Two paginated lists, deliberately. Deals carry the commercial facts and their
 * company association; line items are a separate object whose association names
 * the deal. Reading both lists to exhaustion is what lets `agreementItem` claim
 * `complete`, which is the precondition for the reconciling writer to remove a
 * line the deal no longer has.
 *
 * The line-item list is read when `agreementItem` is mapped and not otherwise.
 * A deal has no required line, so an integration that maps only `agreement`
 * should not pay for a second paginated walk.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import {
  asArray,
  asRecord,
  asString,
  createProviderSession,
  type ProviderSession,
} from "../http";
import {
  HUBSPOT_DEAL_PROPERTIES,
  HUBSPOT_LINE_ITEM_PROPERTIES,
  flattenHubspotDeal,
  flattenHubspotLineItem,
  hubspotCompanyId,
  hubspotDealId,
  hubspotObjectsUrl,
  propertiesParam,
} from "./api";

/** Runaway guard, matching the bounded loops in the other cursored providers. */
const HUBSPOT_MAX_PAGES = 1000;

async function* fetchObjectPages(
  session: ProviderSession,
  object: TargetObject,
  properties: readonly string[],
  associations: readonly string[]
): AsyncGenerator<readonly RawRecord[]> {
  let after: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = asRecord(
      await session.getJson(
        hubspotObjectsUrl({ object, properties, associations, after })
      )
    );
    const records = asArray(body?.["results"]).filter(
      (record): record is RawRecord => asRecord(record) !== undefined
    );

    yield records;

    pagesFetched += 1;

    // `paging.next.after` is absent on the final page — that absence, not a
    // count, is how HubSpot signals the end. An echoed cursor means the list
    // cannot be walked to completion, and for `agreementItem` an incomplete
    // list would license the reconciling writer to delete real rows, so this
    // fails the run rather than stopping quietly.
    const next = asRecord(asRecord(body?.["paging"])?.["next"]);
    const nextAfter = asString(next?.["after"]);
    if (nextAfter === undefined) return;

    if (nextAfter === after) {
      throw new Error(
        `HubSpot repeated the pagination cursor '${nextAfter}' for ${object}; refusing to sync a partial list`
      );
    }

    if (pagesFetched >= HUBSPOT_MAX_PAGES) {
      throw new Error(
        `HubSpot returned more than ${HUBSPOT_MAX_PAGES} pages of ${object}; refusing to sync a partial list`
      );
    }

    after = nextAfter;
  }
}

export const hubspotAgreementHandler: SyncHandler = {
  objects: ["agreement", "agreementItem"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "HubSpot");

    const dealProperties = propertiesParam(
      ctx.requestedSourcePaths.get("agreement") ?? [],
      HUBSPOT_DEAL_PROPERTIES
    );

    const dealIds = new Set<string>();

    for await (const records of fetchObjectPages(
      session,
      "agreement",
      dealProperties,
      ["companies"]
    )) {
      const agreements: RawRecord[] = [];

      for (const record of records) {
        const id = asString(record["id"]);
        if (id !== undefined) dealIds.add(id);
        agreements.push(flattenHubspotDeal(record));
      }

      yield { object: "agreement", records: agreements };
    }

    const itemsMapped =
      (ctx.requestedSourcePaths.get("agreementItem") ?? []).length > 0;
    if (!itemsMapped || dealIds.size === 0) return;

    const lineItemProperties = propertiesParam(
      ctx.requestedSourcePaths.get("agreementItem") ?? [],
      HUBSPOT_LINE_ITEM_PROPERTIES
    );

    const positions = new Map<string, number>();

    for await (const records of fetchObjectPages(
      session,
      "agreementItem",
      lineItemProperties,
      ["deals"]
    )) {
      const items: RawRecord[] = [];

      for (const record of records) {
        const dealId = hubspotDealId(record);
        // A line item with no deal association is not part of any agreement,
        // and one naming a deal outside this run's list would only be rejected
        // by the writer. Both are skipped rather than reported as failures.
        if (dealId === undefined || !dealIds.has(dealId)) continue;

        const position = positions.get(dealId) ?? 0;
        positions.set(dealId, position + 1);
        items.push(flattenHubspotLineItem(record, dealId, position));
      }

      // The line-item list has been walked to exhaustion and every yielded
      // record names a deal this run wrote, so the list is complete by the
      // definition `SyncHandler` requires. A deal that loses its *last* line
      // keeps the stale row: the writer only reconciles agreements that wrote
      // at least one item, and `complete` cannot express "now zero".
      yield { object: "agreementItem", records: items, complete: true };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      case "agreement":
        return { customer: hubspotCompanyId(record) };
      case "agreementItem": {
        const properties = asRecord(record["properties"]);
        return {
          agreement: asString(record["agreement_id"]),
          offering: asString(properties?.["hs_product_id"]),
        };
      }
      default:
        return {};
    }
  },
};
