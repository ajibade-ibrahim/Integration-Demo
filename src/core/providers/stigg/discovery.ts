/**
 * Stigg field discovery.
 *
 * Stigg publishes no describe or schema endpoint, so unlike HubSpot's
 * properties API or Salesforce's describe call there is nothing authoritative
 * to read. A purely static list would work, except it would miss the one thing
 * users most want to map: the free-form `metadata` object, whose keys differ
 * per environment.
 *
 * So: the known fields, unioned with the `metadata.*` keys sampled from one
 * small page of live data. The discovery service caches the answer for an hour,
 * so this costs one request per integration per hour.
 *
 * The static field lists live here rather than in a `fixtures.ts` because this
 * provider ships no fixture data (the user chose tests-only via msw), so a
 * separate module would hold two arrays and nothing else.
 *
 * The dispatch below is an exhaustive switch rather than a catch-all, and that
 * is deliberate. It names every object so the compiler asks the question when a
 * future function adds one; returning `[]` for the objects Stigg does not serve
 * is the honest answer, because offering customer fields for, say, a product
 * would be the "customer fields for everything" bug Stripe's switch documents.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asRecord, createProviderSession } from "../http";
import {
  customersUrl,
  parseCustomersPage,
  STIGG_DISCOVERY_SAMPLE,
} from "./api";
import { STIGG_SESSION_OPTIONS } from "./identity-handler";

export const STIGG_CUSTOMER_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "name", label: "Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
  { path: "archivedAt", label: "Archived at (ISO 8601; Stigg archives rather than deletes)", type: "datetime" },
  { path: "billingId", label: "Billing ID (the id in the connected billing provider — Stripe or Zuora)", type: "string" },
  { path: "billingCurrency", label: "Billing currency", type: "string" },
  { path: "timezone", label: "Time zone", type: "string" },
  { path: "language", label: "Language", type: "string" },
  { path: "couponId", label: "Coupon ID", type: "string" },
  // Synthesized by the handler from `integrations[]`, which no mapping path can
  // index — this is the `crossRef.stripe` source.
  { path: "stripe_customer_id", label: "Stripe customer ID (synthesized, crosswalk)", type: "string" },
];

/**
 * Contacts are entirely synthesized — Stigg has no contact resource — so every
 * path here is one this codebase invents. Labelled as such, so nobody hunts for
 * them in the Stigg API reference.
 */
export const STIGG_CONTACT_FIELDS: DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID (synthesized)", type: "string" },
  {
    path: "contact_name",
    label: "Contact name (customer name, or the email local part)",
    type: "string",
  },
  { path: "email", label: "Email", type: "string" },
  { path: "customer_id", label: "Customer ID (association)", type: "string" },
  { path: "customer_name", label: "Customer name", type: "string" },
];

/**
 * The static fields, plus whatever `metadata.*` keys one sample page reveals.
 */
async function withMetadataKeys(
  ctx: Omit<HandlerContext, "requestedSourcePaths">,
): Promise<readonly DiscoveredFieldDef[]> {
  const session = createProviderSession(ctx, "Stigg", STIGG_SESSION_OPTIONS);
  const body = parseCustomersPage(
    await session.getJson(customersUrl(STIGG_DISCOVERY_SAMPLE)),
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const key of Object.keys(asRecord(record["metadata"]) ?? {})) {
      metadataKeys.add(key);
    }
  }

  return [
    ...STIGG_CUSTOMER_FIELDS,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Metadata — ${key}`,
      type: "string",
    })),
  ];
}

export const stiggFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject,
  ): Promise<readonly DiscoveredFieldDef[]> {
    // Contacts are entirely synthesized by the identity handler, so their shape
    // is known statically and needs no request.
    if (object === "contact") return [...STIGG_CONTACT_FIELDS];

    switch (object) {
      case "customer":
        return withMetadataKeys(ctx);
      // Stigg's handler serves identity only. Every other object is declared
      // here as empty rather than reaching a catch-all: the compiler then asks
      // this question again when a future function adds an object, and until
      // then `[]` is the truthful answer instead of a plausible-looking list
      // for an object this provider never yields.
      case "product":
      case "offering":
      case "price":
      case "feature":
      case "entitlement":
      case "agreement":
      case "subscription":
      case "agreementItem":
      case "agreementEntitlement":
      case "agreementDiscount":
      case "invoice":
      case "invoiceLine":
      case "payment":
        return [];
    }
  },
};
