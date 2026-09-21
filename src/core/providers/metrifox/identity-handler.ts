/**
 * Metrifox identity sync handler — customers, with contact people flattened out.
 *
 * Three things are specific to this provider:
 *
 * 1. There is no contacts endpoint. Contacts arrive nested inside each customer
 *    as `contact_people[]`, so they are flattened here and given a synthesized
 *    id. `metrifoxContactExternalId` is the load-bearing piece: an unstable id
 *    would silently duplicate every contact on every sync.
 *
 * 2. The engine needs all customer pages before any contact page, so it can
 *    resolve associations from a single index. Since both arrive together, the
 *    contacts are buffered and flushed after the last customer page. That is a
 *    deliberate departure from the streaming shape the other handlers keep, and
 *    it is affordable because the engine already collects every record before
 *    writing anything — the buffer changes a constant, not an order of growth.
 *    Fetching twice instead would double the request count and let a customer
 *    added mid-sync produce a contact whose parent was never seen.
 *
 * 3. Metrifox has no field-selection parameter, so `ctx.requestedSourcePaths`
 *    is unused. Unlike HubSpot, a mapped field cannot go missing here because
 *    it was not requested.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession } from "../http";
import {
  customersUrl,
  flattenContacts,
  METRIFOX_MAX_PAGES,
  metrifoxPageSize,
  parseCustomersPage,
} from "./api";

/** Session options shared with discovery, so both speak the same auth. */
export const METRIFOX_SESSION_OPTIONS = {
  authHeaders: (key: string): Record<string, string> => ({ "x-api-key": key }),
  credentialNoun: "API key",
} as const;

export const metrifoxIdentityHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Metrifox",
      METRIFOX_SESSION_OPTIONS
    );

    const perPage = metrifoxPageSize();
    const contacts: RawRecord[] = [];

    let page: number | undefined = 1;
    let pagesFetched = 0;

    while (page !== undefined && pagesFetched < METRIFOX_MAX_PAGES) {
      const body = parseCustomersPage(
        await session.getJson(customersUrl(page, perPage))
      );

      for (const customer of body.customers) {
        contacts.push(...flattenContacts(customer));
      }
      yield { object: "customer", records: body.customers };

      // Only advance on a strictly larger page number. A provider echoing the
      // same `next_page` forever is the page-number equivalent of a repeated
      // cursor, and would otherwise loop until the run timed out.
      const next = body.nextPage;
      page = next !== undefined && next > page ? next : undefined;
      pagesFetched += 1;
    }

    for (let i = 0; i < contacts.length; i += perPage) {
      yield { object: "contact", records: contacts.slice(i, i + perPage) };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // One handler serves both objects: a flattened contact carries the
    // synthesized `contact_id`, a customer carries Metrifox's own `id`.
    // Checking the synthetic key first means a customer cannot match it by
    // accident.
    //
    // No fallback to `customer_key` for customers. It is a human-assigned
    // business key, and "immutable" in the docs is a statement of intent, not a
    // constraint; mixing the two would create two identity regimes and
    // duplicate any record that arrived without `id` once and with it later.
    // A customer with no `id` is rejected upstream, which is correct.
    return asString(record["contact_id"]) ?? asString(record["id"]);
  },

  externalRefsOf(contact: RawRecord, object: TargetObject): ExternalRefs {
    // Only a contact hangs off another record in the identity function; a
    // customer is a root, so it claims no references at all.
    if (object !== "contact") return {};

    return { customer: asString(contact["customer_id"]) };
  },
};
