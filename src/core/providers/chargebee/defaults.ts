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
