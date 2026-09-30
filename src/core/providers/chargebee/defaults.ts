/**
 * Chargebee default field mappings for identity function.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const chargebeeIdentityDefaults: readonly FieldMappingRule[] = [
  // Customer mapping rules
  {
    sourceFieldPath: "company",
    targetObject: "customer",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "email",
    targetObject: "customer",
    targetFieldPath: "email",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "email",
    targetObject: "customer",
    targetFieldPath: "domain",
    transform: "domainFromUrl",
  },
  {
    sourceFieldPath: "created_at",
    targetObject: "customer",
    targetFieldPath: "createDate",
    transform: "dateOnly",
  },

  // Contact mapping rules
  {
    sourceFieldPath: "contact_name",
    targetObject: "contact",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "email",
    targetObject: "contact",
    targetFieldPath: "email",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "phone",
    targetObject: "contact",
    targetFieldPath: "phone",
    transform: "trim",
  },
];

export const chargebeeCatalogDefaults: readonly FieldMappingRule[] = [
  // Product mapping rules (Item Family)
  {
    sourceFieldPath: "name",
    targetObject: "product",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "description",
    targetObject: "product",
    targetFieldPath: "description",
    transform: "trim",
  },

  // Offering mapping rules (Item)
  {
    sourceFieldPath: "name",
    targetObject: "offering",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "description",
    targetObject: "offering",
    targetFieldPath: "description",
    transform: "trim",
  },

  // Price mapping rules (Item Price)
  {
    sourceFieldPath: "price_name",
    targetObject: "price",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "price",
    targetObject: "price",
    targetFieldPath: "amountMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "currency_code",
    targetObject: "price",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "interval",
    targetObject: "price",
    targetFieldPath: "interval",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "interval_count",
    targetObject: "price",
    targetFieldPath: "intervalCount",
    transform: "none",
  },

  // Feature definition mapping rules (Chargebee `/features`).
  //
  // `id` feeds the row's `lookupKey`. Chargebee has no separate lookup-key
  // field, but its feature id ("cbdemo_ticketing_module", merchant-set or
  // generated) is the stable, unique string an application gates on — and it
  // is what the features page groups by — so mapping it here is what keeps that
  // column meaningful instead of permanently blank. The same id is also the
  // row's `externalSourceId`, which the writer takes from the record id.
  {
    sourceFieldPath: "id",
    targetObject: "feature",
    targetFieldPath: "lookupKey",
    transform: "trim",
  },
  {
    sourceFieldPath: "name",
    targetObject: "feature",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "metered",
    targetObject: "feature",
    targetFieldPath: "isMetered",
    transform: "none",
  },
  {
    sourceFieldPath: "unit",
    targetObject: "feature",
    targetFieldPath: "unit",
    transform: "trim",
  },

  // Entitlement mapping rules (item entitlements).
  //
  // Two rules read `value` and write different columns — the raw provider
  // string kept as `value`, and its numeric form as `limitValue`. That pair is
  // intended: `value` is what Chargebee actually said ("50", "true", or nothing
  // at all), while `limitValue` is the queryable number the page and any future
  // limit logic read.
  {
    sourceFieldPath: "value",
    targetObject: "entitlement",
    targetFieldPath: "value",
    transform: "none",
  },
  {
    sourceFieldPath: "name",
    targetObject: "entitlement",
    targetFieldPath: "valueName",
    transform: "trim",
  },
  {
    sourceFieldPath: "value",
    targetObject: "entitlement",
    targetFieldPath: "limitValue",
    transform: "none",
  },
];
