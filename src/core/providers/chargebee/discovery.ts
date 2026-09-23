/**
 * Chargebee field discovery.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";

export const CHARGEBEE_CUSTOMER_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "first_name", label: "First Name", type: "string" },
  { path: "last_name", label: "Last Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "company", label: "Company Name", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "created_at", label: "Created Date", type: "date" },
  { path: "billing_address.first_name", label: "Billing First Name", type: "string" },
  { path: "billing_address.last_name", label: "Billing Last Name", type: "string" },
  { path: "billing_address.email", label: "Billing Email", type: "string" },
  { path: "billing_address.phone", label: "Billing Phone", type: "string" },
  { path: "billing_address.company", label: "Billing Company", type: "string" },
  { path: "billing_address.line1", label: "Billing Address Line 1", type: "string" },
  { path: "billing_address.city", label: "Billing City", type: "string" },
  { path: "billing_address.state", label: "Billing State", type: "string" },
  { path: "billing_address.country", label: "Billing Country", type: "string" },
  { path: "billing_address.zip", label: "Billing Zip", type: "string" },
];

export const CHARGEBEE_CONTACT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID", type: "string" },
  { path: "contact_name", label: "Contact Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "customer_id", label: "Customer ID", type: "string" },
  { path: "customer_name", label: "Customer Name", type: "string" },
];

export const CHARGEBEE_PRODUCT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item Family ID", type: "string" },
  { path: "name", label: "Family Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

export const CHARGEBEE_OFFERING_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item ID", type: "string" },
  { path: "name", label: "Item Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "type", label: "Item Type", type: "string" },
  { path: "item_family_id", label: "Item Family ID", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

export const CHARGEBEE_PRICE_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item Price ID", type: "string" },
  { path: "price_name", label: "Price Name", type: "string" },
  { path: "item_id", label: "Item ID", type: "string" },
  { path: "price", label: "Price Amount", type: "number" },
  { path: "currency_code", label: "Currency Code", type: "string" },
  { path: "period", label: "Period Count", type: "number" },
  { path: "period_unit", label: "Period Unit", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

export const CHARGEBEE_FEATURE_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Feature Item ID", type: "string" },
  { path: "feature_name", label: "Feature Name", type: "string" },
  { path: "lookup_key", label: "Lookup Key", type: "string" },
  { path: "product_id", label: "Product Family ID", type: "string" },
];

export const chargebeeFieldDiscovery: FieldDiscovery = {
  async discover(
    _ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    switch (object) {
      case "contact":
        return [...CHARGEBEE_CONTACT_FIELDS];
      case "product":
        return [...CHARGEBEE_PRODUCT_FIELDS];
      case "offering":
        return [...CHARGEBEE_OFFERING_FIELDS];
      case "price":
        return [...CHARGEBEE_PRICE_FIELDS];
      case "productFeature":
        return [...CHARGEBEE_FEATURE_FIELDS];
      default:
        return [...CHARGEBEE_CUSTOMER_FIELDS];
    }
  },
};
