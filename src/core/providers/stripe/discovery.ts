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
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asRecord, createProviderSession } from "../http";
import { customersUrl, parseCustomersPage, STRIPE_DISCOVERY_SAMPLE } from "./api";
import { STRIPE_CONTACT_FIELDS, STRIPE_CUSTOMER_FIELDS } from "./fixtures";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

export const stripeFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    // Contacts are entirely synthesized by the handler, so their shape is known
    // statically and needs no request.
    if (object === "contact") return [...STRIPE_CONTACT_FIELDS];

    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    const body = parseCustomersPage(
      await session.getJson(customersUrl(STRIPE_DISCOVERY_SAMPLE))
    );

    const metadataKeys = new Set<string>();
    for (const customer of body.customers) {
      for (const key of Object.keys(asRecord(customer["metadata"]) ?? {})) {
        metadataKeys.add(key);
      }
    }

    return [
      ...STRIPE_CUSTOMER_FIELDS,
      ...[...metadataKeys].sort().map((key) => ({
        path: `metadata.${key}`,
        label: `Metadata — ${key}`,
        type: "string",
      })),
    ];
  },
};
