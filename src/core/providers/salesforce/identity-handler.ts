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

import {
  isIdentityObject,
  type IdentityObject,
} from "../../identity-schema";
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
import { nextPageUrl, queryUrl, salesforceObject } from "./api";
import { buildQuery, buildSelectList } from "./soql";

/** Fields the sync cannot work without, whatever the user mapped. */
const REQUIRED_FIELDS: Record<IdentityObject, readonly string[]> = {
  customer: ["Id"],
  contact: ["Id", "AccountId"],
};

async function* fetchObject(
  session: ProviderSession,
  object: TargetObject,
  sourcePaths: readonly string[]
): AsyncGenerator<SourcePage> {
  // Narrowed before either lookup: both `REQUIRED_FIELDS` and the sObject name
  // cover the identity objects only, and `salesforceObject` says so by name.
  const sObject = salesforceObject(object);
  const required = isIdentityObject(object) ? REQUIRED_FIELDS[object] : [];

  const { fields, rejected } = buildSelectList(sourcePaths, required);

  if (rejected.length > 0) {
    // Loud but non-fatal: the rest of the mapping still works, and a silently
    // missing column is far harder to diagnose than a logged one.
    console.warn(
      `[salesforce] Ignoring source paths that are not valid field names: ${rejected.join(", ")}`
    );
  }

  const soql = buildQuery(sObject, fields);
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
  objects: ["customer", "contact"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Salesforce");

    for (const object of ["customer", "contact"] as const) {
      yield* fetchObject(session, object, ctx.requestedSourcePaths.get(object) ?? []);
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["Id"]);
  },

  externalRefsOf(contact: RawRecord, object: TargetObject): ExternalRefs {
    // Only a contact hangs off another record in the identity function; a
    // customer is a root, so it claims no references at all.
    if (object !== "contact") return {};

    // Salesforce nulls the field rather than omitting it, so an unaffiliated
    // contact arrives as `AccountId: null` — asString turns that into undefined,
    // which the record writer reads as "no association claimed" and links to
    // nothing without raising a warning.
    return { customer: asString(contact["AccountId"]) };
  },
};
