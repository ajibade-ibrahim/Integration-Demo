/**
 * Suggested starting mappings for the mock CRM.
 *
 * Applied on first connect so a new integration can sync immediately, and used
 * to pre-fill the mapping editor rather than presenting an empty grid.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const mockIdentityDefaults: FieldMappingRule[] = [
  // Customer
  { sourceFieldPath: "properties.name", targetObject: "customer", targetFieldPath: "name", transform: "none" },
  // The mock stores a full URL, as HubSpot and Salesforce both do.
  { sourceFieldPath: "properties.website", targetObject: "customer", targetFieldPath: "domain", transform: "domainFromUrl" },
  { sourceFieldPath: "properties.industry", targetObject: "customer", targetFieldPath: "industry", transform: "none" },
  { sourceFieldPath: "properties.createdate", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  { sourceFieldPath: "properties.lifecyclestage", targetObject: "customer", targetFieldPath: "type", transform: "lowercase" },
  { sourceFieldPath: "properties.account_tier", targetObject: "customer", targetFieldPath: "customFields.account_tier", transform: "none" },

  // Contact. Only firstname is mapped — see the note in the mapping editor
  // about names split across two source fields.
  { sourceFieldPath: "properties.firstname", targetObject: "contact", targetFieldPath: "name", transform: "none" },
  { sourceFieldPath: "properties.email", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "properties.jobtitle", targetObject: "contact", targetFieldPath: "jobTitle", transform: "none" },
  { sourceFieldPath: "properties.phone", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
];
