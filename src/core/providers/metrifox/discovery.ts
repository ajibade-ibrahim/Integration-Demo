/**
 * Metrifox field discovery.
 *
 * Metrifox publishes no describe or schema endpoint, so unlike HubSpot's
 * properties API or Salesforce's describe call there is nothing authoritative
 * to read. A purely static list — the mock provider's approach — would work,
 * except it would miss the one thing users most want to map: the free-form
 * `metadata` object, whose keys differ per tenant.
 *
 * So: the known fields, unioned with the `metadata.*` keys sampled from one
 * small page of live data. The discovery service caches the answer for an hour,
 * so this costs one request per integration per hour.
 *
 * Only `customer` samples. Contacts are synthesized from customers, and the
 * agreement objects come from payload shapes there is no list endpoint to
 * sample — the customer details fan-out is per customer, so sampling it would
 * cost O(customers) for a static answer. Their field lists are declared from
 * the documented shapes in `fixtures.ts`; `agreementDiscount` returns nothing
 * because the handler deliberately writes no discount rows.
 *
 * Billing offers invoice summaries only. There is no invoice-list endpoint and
 * no invoice-line or payment list to sample or write, so `invoiceLine` and
 * `payment` return nothing rather than fields a rule could never fill.
 *
 * The dispatch is a switch whose default returns `[]` rather than falling
 * through to customer fields: offering customer paths for, say, a product would
 * be the "customer fields for everything" bug the Stripe and Stigg switches
 * document.
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
  METRIFOX_DISCOVERY_SAMPLE,
  parseCustomersPage,
} from "./api";
import {
  METRIFOX_AGREEMENT_ENTITLEMENT_FIELDS,
  METRIFOX_AGREEMENT_FIELDS,
  METRIFOX_AGREEMENT_ITEM_FIELDS,
  METRIFOX_CONTACT_FIELDS,
  METRIFOX_CUSTOMER_FIELDS,
  METRIFOX_INVOICE_FIELDS,
  METRIFOX_SUBSCRIPTION_FIELDS,
} from "./fixtures";
import { METRIFOX_SESSION_OPTIONS } from "./identity-handler";

export const metrifoxFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    switch (object) {
      // Contacts are entirely synthesized by the handler, so their shape is
      // known statically and needs no request.
      case "contact":
        return [...METRIFOX_CONTACT_FIELDS];

      // Agreement objects are static for the reason in the header: there is no
      // single page to sample them from.
      case "agreement":
        return [...METRIFOX_AGREEMENT_FIELDS];
      case "subscription":
        return [...METRIFOX_SUBSCRIPTION_FIELDS];
      case "agreementItem":
        return [...METRIFOX_AGREEMENT_ITEM_FIELDS];
      case "agreementEntitlement":
        return [...METRIFOX_AGREEMENT_ENTITLEMENT_FIELDS];

      // No documented per-subscription discount, so no rows are written and no
      // fields are offered. See the plan's out-of-scope note.
      case "agreementDiscount":
        return [];

      // Billing offers invoices only: no line list and no payment read exists.
      case "invoice":
        return [...METRIFOX_INVOICE_FIELDS];
      case "invoiceLine":
      case "payment":
        return [];

      // The one sampled object, below.
      case "customer":
        break;

      default:
        return [];
    }

    const session = createProviderSession(
      ctx,
      "Metrifox",
      METRIFOX_SESSION_OPTIONS
    );

    const body = parseCustomersPage(
      await session.getJson(customersUrl(1, METRIFOX_DISCOVERY_SAMPLE))
    );

    const metadataKeys = new Set<string>();
    for (const customer of body.customers) {
      for (const key of Object.keys(asRecord(customer["metadata"]) ?? {})) {
        metadataKeys.add(key);
      }
    }

    return [
      ...METRIFOX_CUSTOMER_FIELDS,
      ...[...metadataKeys].sort().map((key) => ({
        path: `metadata.${key}`,
        label: `Metadata — ${key}`,
        type: "string",
      })),
    ];
  },
};
