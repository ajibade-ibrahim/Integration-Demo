/**
 * Chargebee identity sync handler — customers, with a billing contact derived from
 * each customer record.
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
  chargebeeAuthHeaders,
  chargebeePageSize,
  CHARGEBEE_MAX_PAGES,
  customersUrl,
  epochToIso,
  parseChargebeeCredential,
  parseCustomersPage,
  synthesizeContact,
} from "./api";

export const CHARGEBEE_SESSION_OPTIONS = {
  authHeaders: chargebeeAuthHeaders,
  credentialNoun: "API key",
} as const;

export const chargebeeIdentityHandler: SyncHandler = {
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Chargebee",
      CHARGEBEE_SESSION_OPTIONS
    );

    const site =
      ctx.metadata["site"] ??
      parseChargebeeCredential(ctx.accessToken).site;

    if (site === undefined || site === "") {
      throw new Error(
        "Chargebee sync failed: missing site in integration metadata"
      );
    }

    const perPage = chargebeePageSize();
    const contacts: RawRecord[] = [];

    let offset: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseCustomersPage(
        await session.getJson(customersUrl(site, perPage, offset))
      );

      const customers = body.records.map((customer: RawRecord) => ({
        ...customer,
        ...withCreatedAt(customer),
      }));

      for (const customer of customers) {
        const contact = synthesizeContact(customer);
        if (contact !== undefined) contacts.push(contact);
      }

      yield { object: "customer", records: customers };

      pagesFetched += 1;
      if (pagesFetched >= CHARGEBEE_MAX_PAGES) break;

      if (body.nextOffset === undefined || body.nextOffset === offset) break;
      offset = body.nextOffset;
    }

    // Flush contacts after customer pages
    for (let i = 0; i < contacts.length; i += perPage) {
      yield { object: "contact", records: contacts.slice(i, i + perPage) };
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    return asString(record["contact_id"]) ?? asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    if (object !== "contact") return {};
    return { customer: asString(record["customer_id"]) };
  },
};

function withCreatedAt(customer: RawRecord): RawRecord {
  const createdAt = epochToIso(customer["created_at"]);
  return createdAt === undefined ? {} : { created_at: createdAt };
}
