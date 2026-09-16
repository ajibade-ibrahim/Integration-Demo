/**
 * HubSpot identity sync handler — companies and contacts.
 *
 * Two things here are easy to get wrong and expensive to discover late:
 *
 * 1. HubSpot returns *only* the properties you ask for. A mapped field that is
 *    not in the `properties` query parameter silently arrives as absent, which
 *    the mapper faithfully turns into null. So the parameter is derived from
 *    the user's own mapping rules rather than a hardcoded list.
 * 2. The company a contact belongs to is not a property. It is an association,
 *    fetched only when `associations=companies` is requested, and it arrives
 *    as HubSpot's company id — never our internal one. That id is what the
 *    record writer resolves against the customers written earlier in the run.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
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
  hubspotApiBase,
  hubspotObjectPath,
  hubspotPageSize,
  propertiesParam,
} from "./api";

function pageUrl(
  object: TargetObject,
  properties: readonly string[],
  after: string | undefined
): string {
  const url = new URL(
    `/crm/v3/objects/${hubspotObjectPath(object)}`,
    hubspotApiBase()
  );
  url.searchParams.set("limit", String(hubspotPageSize()));
  if (properties.length > 0) {
    url.searchParams.set("properties", properties.join(","));
  }
  if (object === "contact") {
    url.searchParams.set("associations", "companies");
  }
  if (after !== undefined) url.searchParams.set("after", after);
  return url.toString();
}

async function* fetchObject(
  session: ProviderSession,
  object: TargetObject,
  properties: readonly string[]
): AsyncGenerator<SourcePage> {
  let after: string | undefined;

  do {
    const body = asRecord(await session.getJson(pageUrl(object, properties, after)));
    const records = asArray(body?.["results"]).filter(
      (r): r is RawRecord => asRecord(r) !== undefined
    );

    yield { object, records };

    // `paging.next.after` is absent on the final page — that absence, not a
    // count, is how HubSpot signals the end.
    const next = asRecord(asRecord(body?.["paging"])?.["next"]);
    const nextAfter = asString(next?.["after"]);

    // Defend against a provider echoing the same cursor forever.
    after = nextAfter === after ? undefined : nextAfter;
  } while (after !== undefined);
}

export const hubspotIdentityHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "HubSpot");

    // Companies first: contacts resolve their association against the index
    // built from these.
    for (const object of ["customer", "contact"] as const) {
      const properties = propertiesParam(
        ctx.requestedSourcePaths.get(object) ?? []
      );
      yield* fetchObject(session, object, properties);
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["id"]);
  },

  externalParentIdOf(
    contact: RawRecord,
    object: TargetObject
  ): string | undefined {
    // Only a contact hangs off another record in the identity function; a
    // customer is a root, so it has no parent id to report.
    if (object !== "contact") return undefined;

    // associations.companies.results[] — take the first. HubSpot allows a
    // contact to associate with several companies, but our model holds one, and
    // the first is the primary in practice.
    const associations = asRecord(contact["associations"]);
    const companies = asRecord(associations?.["companies"]);
    const first = asRecord(asArray(companies?.["results"])[0]);
    return asString(first?.["id"]);
  },
};
