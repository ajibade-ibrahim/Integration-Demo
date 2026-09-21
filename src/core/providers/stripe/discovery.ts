/**
 * Stripe field discovery.
 *
 * Stripe publishes no describe or schema endpoint, so unlike HubSpot's
 * properties API or Salesforce's describe call there is nothing authoritative
 * to read. A purely static list — the mock provider's approach — would work,
 * except it would miss the one thing users most want to map: the free-form
 * `metadata` object, whose keys differ per account.
 *
 * So: the known fields, unioned with the `metadata.*` keys sampled from one
 * small page of live data. The discovery service caches the answer for an hour,
 * so this costs one request per integration per hour.
 *
 * The dispatch below is an exhaustive switch rather than a default branch, and
 * that is deliberate. It used to read "contacts are static, everything else
 * samples customers", which was true while customer and contact were the only
 * objects — and would have quietly offered *customer* fields for products the
 * moment a second function existed. A switch that names every object makes the
 * compiler ask the question when the next one is added.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asRecord, createProviderSession, type ProviderSession } from "../http";
import { listUrl, parseListPage, STRIPE_DISCOVERY_SAMPLE, type StripeResource } from "./api";
import {
  STRIPE_AGREEMENT_FIELDS,
  STRIPE_CONTACT_FIELDS,
  STRIPE_CUSTOMER_FIELDS,
  STRIPE_OFFERING_FIELDS,
  STRIPE_PRODUCT_FIELDS,
  STRIPE_SUBSCRIPTION_FIELDS,
} from "./fixtures";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

/**
 * The static fields, plus whatever `metadata.*` keys one sample page reveals.
 *
 * Every Stripe resource carries a `metadata` object with account-specific keys,
 * so the sampling is worth doing for each of them and not just for customers.
 */
async function withMetadataKeys(
  session: ProviderSession,
  resource: StripeResource,
  base: readonly DiscoveredFieldDef[]
): Promise<readonly DiscoveredFieldDef[]> {
  const body = parseListPage(
    await session.getJson(listUrl(resource, STRIPE_DISCOVERY_SAMPLE))
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const key of Object.keys(asRecord(record["metadata"]) ?? {})) {
      metadataKeys.add(key);
    }
  }

  return [
    ...base,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Metadata — ${key}`,
      type: "string",
    })),
  ];
}

export const stripeFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    // Contacts are entirely synthesized by the identity handler, so their shape
    // is known statically and needs no request.
    if (object === "contact") return [...STRIPE_CONTACT_FIELDS];

    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    switch (object) {
      case "customer":
        return withMetadataKeys(session, "customers", STRIPE_CUSTOMER_FIELDS);
      case "product":
        return withMetadataKeys(session, "products", STRIPE_PRODUCT_FIELDS);
      case "offering":
        return withMetadataKeys(session, "prices", STRIPE_OFFERING_FIELDS);
      // Both halves of an agreement are read from the same endpoint, because
      // they are two halves of one Stripe record. Only the field list differs:
      // the shared node's fields against the recurring detail's.
      case "agreement":
        return withMetadataKeys(
          session,
          "subscriptions",
          STRIPE_AGREEMENT_FIELDS
        );
      case "subscription":
        return withMetadataKeys(
          session,
          "subscriptions",
          STRIPE_SUBSCRIPTION_FIELDS
        );
    }
  },
};
