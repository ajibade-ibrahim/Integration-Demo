/**
 * Salesforce identity sync handler — Accounts and Contacts.
 *
 * Salesforce reads through SOQL rather than object endpoints, which changes
 * three things relative to HubSpot:
 *
 * 1. The field list is part of the query text, so unmapped fields are not
 *    merely unrequested — they are absent from the query entirely. `Id` and
 *    `AccountId` are therefore forced in regardless of mapping, being the
 *    upsert key and the contact association.
 * 2. User-supplied field paths are interpolated into a query language. See
 *    `soql.ts` — every path is shape-checked before it gets near the query.
 * 3. Pagination is a server-side cursor: the response carries `nextRecordsUrl`
 *    until `done` is true. We follow it rather than buffering the org, which is
 *    a deliberate departure from the original spec's fetch-all-then-map.
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
import { nextPageUrl, queryUrl, SALESFORCE_OBJECT } from "./api";
import { buildQuery, buildSelectList } from "./soql";

/** Fields the sync cannot work without, whatever the user mapped. */
const REQUIRED_FIELDS: Record<TargetObject, readonly string[]> = {
  customer: ["Id"],
  contact: ["Id", "AccountId"],
};

async function* fetchObject(
  session: ProviderSession,
  object: TargetObject,
  sourcePaths: readonly string[]
): AsyncGenerator<SourcePage> {
  const { fields, rejected } = buildSelectList(
    sourcePaths,
    REQUIRED_FIELDS[object]
  );

  if (rejected.length > 0) {
    // Loud but non-fatal: the rest of the mapping still works, and a silently
    // missing column is far harder to diagnose than a logged one.
    console.warn(
      `[salesforce] Ignoring source paths that are not valid field names: ${rejected.join(", ")}`
    );
  }

  const soql = buildQuery(SALESFORCE_OBJECT[object], fields);
  let url: string | undefined = queryUrl(session.metadata, soql);

  while (url !== undefined) {
    const body = asRecord(await session.getJson(url));
    const records = asArray(body?.["records"]).filter(
      (r): r is RawRecord => asRecord(r) !== undefined
    );

    yield { object, records };

    const next = asString(body?.["nextRecordsUrl"]);
    url =
      body?.["done"] === true || next === undefined
        ? undefined
        : nextPageUrl(session.metadata, next);
  }
}

export const salesforceIdentityHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Salesforce");

    for (const object of ["customer", "contact"] as const) {
      yield* fetchObject(session, object, ctx.requestedSourcePaths.get(object) ?? []);
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["Id"]);
  },

  externalCustomerIdOf(contact: RawRecord): string | undefined {
    // Salesforce nulls the field rather than omitting it, so an unaffiliated
    // contact arrives as `AccountId: null` — asString turns that into undefined,
    // which the record writer reads as "no association claimed" and links to
    // nothing without raising a warning.
    return asString(contact["AccountId"]);
  },
};
