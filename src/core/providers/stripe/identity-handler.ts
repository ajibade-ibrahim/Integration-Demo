/**
 * Stripe identity sync handler — customers, with a billing contact derived from
 * each one.
 *
 * Three things are specific to this provider:
 *
 * 1. There is no contact resource at all. Where Metrifox at least nests
 *    `contact_people[]` inside a customer, Stripe has only the customer's own
 *    `name`/`email`/`phone`, so the contact is *constructed* rather than
 *    flattened. `stripeContactExternalId` is the load-bearing piece: an
 *    unstable id would silently duplicate every contact on every sync.
 *
 * 2. Pagination is a cursor built from the last id of the previous page. Unlike
 *    an opaque server-issued token, that makes termination partly our
 *    responsibility — hence the checks on `hasMore`, on an absent cursor, and
 *    on a cursor that fails to advance.
 *
 * 3. `created` arrives as Unix epoch seconds, which no downstream date parse
 *    accepts, so an ISO `created_at` is synthesized onto each customer here.
 *    Same move as Metrifox's `full_name`: we are already building the record,
 *    so we can do the conversion once, correctly, instead of warning users that
 *    create dates vanish.
 *
 * Stripe has no field-selection parameter, so `ctx.requestedSourcePaths` is
 * unused. Unlike HubSpot, a mapped field cannot go missing here because it was
 * not requested.
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
  epochToIso,
  parseCustomersPage,
  stripeAuthHeaders,
  stripePageSize,
  STRIPE_MAX_PAGES,
  synthesizeContact,
} from "./api";

/**
 * Session options shared with discovery, so both speak the same auth *and* the
 * same API version. `stripeAuthHeaders` carries both — see the note there on
 * why the version rides in with the credential.
 */
export const STRIPE_SESSION_OPTIONS = {
  authHeaders: stripeAuthHeaders,
  credentialNoun: "API key",
} as const;

export const stripeIdentityHandler: SyncHandler = {
  objects: ["customer", "contact"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    const perPage = stripePageSize();
    const contacts: RawRecord[] = [];

    let cursor: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseCustomersPage(await session.getJson(customersUrl(perPage, cursor)));

      const customers = body.records.map((customer: RawRecord) => ({
        ...customer,
        // Spread first, so ours wins if Stripe ever ships a field of this name.
        ...withCreatedAt(customer),
      }));

      for (const customer of customers) {
        const contact = synthesizeContact(customer);
        if (contact !== undefined) contacts.push(contact);
      }
      yield { object: "customer", records: customers };

      pagesFetched += 1;
      if (pagesFetched >= STRIPE_MAX_PAGES) break;

      // Three ways to stop, and all three are needed. `hasMore` false is
      // Stripe's own signal. An absent cursor means this page held no readable
      // id, so the only request we could make next is the one we just made.
      // A cursor that did not advance is the same situation arriving by a
      // different route — the page-number echo that Metrifox guards against,
      // translated into cursors.
      if (!body.hasMore) break;
      if (body.lastId === undefined || body.lastId === cursor) break;
      cursor = body.lastId;
    }

    // Flushed after the last customer page, not interleaved.
    //
    // Contacts are derived from customers, so they could not precede them in
    // any case. What the ordering buys is that customers-before-contacts is the
    // invariant every handler in this codebase keeps and the Metrifox
    // integration test pins, so a new handler interleaving them would read as a
    // bug even though the engine buckets every page before writing anything.
    // The buffer changes a constant, not an order of growth.
    for (let i = 0; i < contacts.length; i += perPage) {
      yield { object: "contact", records: contacts.slice(i, i + perPage) };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // One handler serves both objects: a synthesized contact carries
    // `contact_id`, a customer carries Stripe's own `id`. Checking the
    // synthetic key first means a customer cannot match it by accident — and
    // because the contact record is built from scratch rather than spread from
    // its customer, it carries no `id` at all, so the fallback is unambiguous.
    return asString(record["contact_id"]) ?? asString(record["id"]);
  },

  externalRefsOf(contact: RawRecord, object: TargetObject): ExternalRefs {
    // Only a contact hangs off another record in the identity function; a
    // customer is a root, so it claims no references at all.
    if (object !== "contact") return {};

    return { customer: asString(contact["customer_id"]) };
  },
};

/**
 * The `created_at` addition for one customer, or nothing when `created` is
 * missing or not a number.
 *
 * Returning a spreadable object rather than a value keeps an unparseable
 * `created` from writing `created_at: undefined` onto the record, which the
 * mapping editor would then offer as a field that is always blank.
 */
function withCreatedAt(customer: RawRecord): RawRecord {
  const createdAt = epochToIso(customer["created"]);
  return createdAt === undefined ? {} : { created_at: createdAt };
}
