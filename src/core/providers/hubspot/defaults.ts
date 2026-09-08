/**
 * Suggested starting mappings for HubSpot.
 *
 * `properties.type` is deliberately absent: HubSpot has no standard `type`
 * property on companies, and `lifecyclestage` uses its own vocabulary
 * (subscriber, lead, opportunity…) that does not line up with our
 * prospect/customer/partner/vendor enum. Guessing a mapping there would produce
 * records that fail validation on every sync, so it is left for the user.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const hubspotIdentityDefaults: FieldMappingRule[] = [
  { sourceFieldPath: "properties.name", targetObject: "customer", targetFieldPath: "name", transform: "none" },
  { sourceFieldPath: "properties.domain", targetObject: "customer", targetFieldPath: "domain", transform: "lowercase" },
  { sourceFieldPath: "properties.industry", targetObject: "customer", targetFieldPath: "industry", transform: "none" },
  { sourceFieldPath: "properties.createdate", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },

  { sourceFieldPath: "properties.firstname", targetObject: "contact", targetFieldPath: "name", transform: "none" },
  { sourceFieldPath: "properties.email", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "properties.jobtitle", targetObject: "contact", targetFieldPath: "jobTitle", transform: "none" },
  { sourceFieldPath: "properties.phone", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
];
