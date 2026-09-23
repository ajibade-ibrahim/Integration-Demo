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

  // ProductFeature mapping rules
  {
    sourceFieldPath: "feature_name",
    targetObject: "productFeature",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "lookup_key",
    targetObject: "productFeature",
    targetFieldPath: "lookupKey",
    transform: "trim",
  },
];
