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

/**
 * Suggested mapping for deals and their line items.
 *
 * `agreement_name` is load-bearing: `Agreement.name` is required, and the
 * handler synthesizes a value from `dealname` with an id fallback precisely so
 * an unnamed deal is not rejected on every sync.
 *
 * The raw stage, pipeline, amount and type are mapped into `customFields` rather
 * than the status column. Deal stages are user-defined per pipeline, so the
 * handler's closed-flag mapping owns `status`; the raw values stay available
 * without pretending to be our vocabulary.
 *
 * Line-item money is deliberately not mapped to `unitPriceMinor`: HubSpot
 * states `price` in major units, while that column holds minor units and the
 * row carries no currency exponent. The raw figures go to custom fields until a
 * currency-aware transform exists.
 */
export const hubspotAgreementDefaults: FieldMappingRule[] = [
  { sourceFieldPath: "agreement_name", targetObject: "agreement", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "agreement_type", targetObject: "agreement", targetFieldPath: "agreementType", transform: "none" },
  { sourceFieldPath: "agreement_status", targetObject: "agreement", targetFieldPath: "status", transform: "none" },
  { sourceFieldPath: "effective_date", targetObject: "agreement", targetFieldPath: "effectiveDate", transform: "none" },
  { sourceFieldPath: "end_date", targetObject: "agreement", targetFieldPath: "endDate", transform: "none" },
  { sourceFieldPath: "currency", targetObject: "agreement", targetFieldPath: "currency", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "agreement", targetFieldPath: "providerMetadata", transform: "none" },
  { sourceFieldPath: "properties.dealstage", targetObject: "agreement", targetFieldPath: "customFields.dealStage", transform: "none" },
  { sourceFieldPath: "properties.pipeline", targetObject: "agreement", targetFieldPath: "customFields.pipeline", transform: "none" },
  { sourceFieldPath: "properties.amount", targetObject: "agreement", targetFieldPath: "customFields.amount", transform: "none" },
  { sourceFieldPath: "properties.dealtype", targetObject: "agreement", targetFieldPath: "customFields.dealType", transform: "none" },

  { sourceFieldPath: "properties.quantity", targetObject: "agreementItem", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "position", targetObject: "agreementItem", targetFieldPath: "position", transform: "none" },
  { sourceFieldPath: "properties.hs_recurring_billing_number_of_payments", targetObject: "agreementItem", targetFieldPath: "billingCycles", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "agreementItem", targetFieldPath: "providerMetadata", transform: "none" },
  { sourceFieldPath: "properties.name", targetObject: "agreementItem", targetFieldPath: "customFields.lineName", transform: "none" },
  { sourceFieldPath: "properties.price", targetObject: "agreementItem", targetFieldPath: "customFields.price", transform: "none" },
  { sourceFieldPath: "properties.amount", targetObject: "agreementItem", targetFieldPath: "customFields.amount", transform: "none" },
  { sourceFieldPath: "properties.discount", targetObject: "agreementItem", targetFieldPath: "customFields.discount", transform: "none" },
  { sourceFieldPath: "properties.hs_line_item_currency_code", targetObject: "agreementItem", targetFieldPath: "customFields.currency", transform: "none" },
  { sourceFieldPath: "properties.hs_sku", targetObject: "agreementItem", targetFieldPath: "customFields.sku", transform: "none" },
];
