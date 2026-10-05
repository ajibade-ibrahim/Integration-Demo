/**
 * Stigg identity sync handler — customers, with a billing contact derived from
 * each one.
 *
 * The Stripe/Chargebee shape, for the same reason: Stigg has no contact
 * resource, so the contact is *constructed* from the customer's own name and
 * email. `stiggContactExternalId` is the load-bearing piece — an unstable id
 * would silently duplicate every contact on every sync.
 *
 * Pagination is an opaque, server-issued cursor (`after` + `pagination.next`),
 * so termination is the provider's own signal plus a non-advancing guard. The
 * cursor is echoed verbatim and never constructed.
 *
 * Stigg has no field-selection parameter, so `ctx.requestedSourcePaths` is
 * unused. A mapped field cannot go missing here because it was not requested.
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
  parseCustomersPage,
  STIGG_MAX_PAGES,
  stiggPageSize,
  synthesizeContact,
  withCustomerName,
  withStripeLink,
} from "./api";

/** Session options shared with discovery, so both speak the same auth. */
export const STIGG_SESSION_OPTIONS = {
  authHeaders: (key: string): Record<string, string> => ({ "X-API-KEY": key }),
  credentialNoun: "API key",
} as const;

export const stiggIdentityHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Stigg",
      STIGG_SESSION_OPTIONS,
    );

    const perPage = stiggPageSize();
    const contacts: RawRecord[] = [];

    let cursor: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseCustomersPage(
        await session.getJson(customersUrl(perPage, cursor)),
      );

      const customers = body.records.map((customer: RawRecord) => ({
        ...customer,
        // Spread first, so ours win if Stigg ever ships fields of these names.
        // `withCustomerName` guarantees the required `Customer.name` for a
        // customer Stigg left nameless, falling back to the customer's own id.
        ...withStripeLink(customer),
        ...withCustomerName(customer),
      }));

      // Contacts are derived from the **raw** record, not the patched one, so a
      // nameless customer's contact can still prefer the email local part over
      // the id `withCustomerName` substitutes. A contact reads none of the
      // synthesized customer fields, so the raw shape is the complete input.
      for (const customer of body.records) {
        const contact = synthesizeContact(customer);
        if (contact !== undefined) contacts.push(contact);
      }

      yield { object: "customer", records: customers };

      pagesFetched += 1;
      if (pagesFetched >= STIGG_MAX_PAGES) break;

      // Two ways to stop, and both are needed. An absent cursor is the
      // provider's own end-of-data signal. A cursor that did not advance is the
      // same situation arriving by a different route — the echoed-token guard
      // Metrifox and Stripe both keep, translated into opaque cursors.
      if (body.nextCursor === undefined || body.nextCursor === cursor) break;
      cursor = body.nextCursor;
    }

    // Flushed after the last customer page, not interleaved: contacts are
    // derived from customers, and customers-before-contacts is the invariant
    // every identity handler keeps so associations resolve against a complete
    // index. The buffer changes a constant, not an order of growth.
    for (let i = 0; i < contacts.length; i += perPage) {
      yield { object: "contact", records: contacts.slice(i, i + perPage) };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // One handler serves both objects: a synthesized contact carries
    // `contact_id`, a customer carries Stigg's own `id`. Checking the synthetic
    // key first means a customer cannot match it by accident — and because the
    // contact record is built from scratch rather than spread from its
    // customer, it carries no `id` at all, so the fallback is unambiguous.
    return asString(record["contact_id"]) ?? asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    // Only a contact hangs off another record in the identity function; a
    // customer is a root, so it claims no references at all.
    if (object !== "contact") return {};

    return { customer: asString(record["customer_id"]) };
  },
};
