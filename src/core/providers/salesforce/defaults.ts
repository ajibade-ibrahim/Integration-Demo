/**
 * Suggested starting mappings for Salesforce.
 *
 * `Website` is a full URL and our `domain` target wants a bare host, which is
 * what the `domainFromUrl` transform exists for. `Type` is a real picklist on
 * Account whose values often match our enum, so it is mapped through
 * `lowercase` — validation will reject any org-specific value that does not,
 * per record, without failing the run.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const salesforceIdentityDefaults: FieldMappingRule[] = [
  { sourceFieldPath: "Name", targetObject: "customer", targetFieldPath: "name", transform: "none" },
  { sourceFieldPath: "Website", targetObject: "customer", targetFieldPath: "domain", transform: "domainFromUrl" },
  { sourceFieldPath: "Industry", targetObject: "customer", targetFieldPath: "industry", transform: "none" },
  { sourceFieldPath: "CreatedDate", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  { sourceFieldPath: "Type", targetObject: "customer", targetFieldPath: "type", transform: "lowercase" },

  { sourceFieldPath: "Name", targetObject: "contact", targetFieldPath: "name", transform: "none" },
  { sourceFieldPath: "Email", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "Title", targetObject: "contact", targetFieldPath: "jobTitle", transform: "none" },
  { sourceFieldPath: "Phone", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
];
