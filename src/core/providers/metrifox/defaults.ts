/**
 * Suggested starting mappings for Metrifox.
 *
 * Two absences are deliberate, for the same reason the HubSpot defaults omit
 * `type`: a default that fails validation on every record of every sync is
 * worse than no default at all.
 *
 *   `customer.industry` — Metrifox has no industry field. Nothing to map.
 *   `customer.type`     — `customer_type` is BUSINESS/INDIVIDUAL, a legal-entity
 *                         classification. Our `type` is a relationship stage
 *                         (prospect/customer/partner/vendor). Mapping one onto
 *                         the other yields "business", which the record writer
 *                         warns about and drops on every record forever, so it
 *                         goes to a custom field instead.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const metrifoxIdentityDefaults: FieldMappingRule[] = [
  // --- customer ---
  { sourceFieldPath: "display_name", targetObject: "customer", targetFieldPath: "name", transform: "trim" },
  // `domain` wants a bare host, and Metrifox gives a full URL with a path.
  { sourceFieldPath: "website_url", targetObject: "customer", targetFieldPath: "domain", transform: "domainFromUrl" },
  { sourceFieldPath: "created_at", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  { sourceFieldPath: "customer_key", targetObject: "customer", targetFieldPath: "customFields.customer_key", transform: "none" },
  { sourceFieldPath: "legal_name", targetObject: "customer", targetFieldPath: "customFields.legal_name", transform: "trim" },
  { sourceFieldPath: "customer_type", targetObject: "customer", targetFieldPath: "customFields.customer_type", transform: "none" },
  { sourceFieldPath: "primary_email", targetObject: "customer", targetFieldPath: "customFields.primary_email", transform: "lowercase" },
  { sourceFieldPath: "currency", targetObject: "customer", targetFieldPath: "customFields.currency", transform: "none" },
  { sourceFieldPath: "country", targetObject: "customer", targetFieldPath: "customFields.country", transform: "trim" },

  // --- contact ---
  // `full_name` is synthesized by the handler from first + last, which is why
  // Metrifox has none of HubSpot's "surnames vanish" problem.
  { sourceFieldPath: "full_name", targetObject: "contact", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "email_address", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "designation", targetObject: "contact", targetFieldPath: "jobTitle", transform: "trim" },
  { sourceFieldPath: "phone_number", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
  { sourceFieldPath: "department", targetObject: "contact", targetFieldPath: "customFields.department", transform: "trim" },
  { sourceFieldPath: "is_primary", targetObject: "contact", targetFieldPath: "customFields.is_primary", transform: "none" },
];
