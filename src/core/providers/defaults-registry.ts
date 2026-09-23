/**
 * Suggested default mappings, keyed by (function, provider).
 *
 * Applied once when an integration is first authorized, so it can sync straight
 * away instead of requiring a trip through the mapping editor. Defaults are a
 * starting point, never enforced — `seedMappingsIfEmpty` refuses to overwrite
 * rules a user has already saved.
 */

import type { FieldMappingRule } from "../types/mapping";
import { hubspotIdentityDefaults } from "./hubspot/defaults";
import { salesforceIdentityDefaults } from "./salesforce/defaults";
import { mockIdentityDefaults } from "./mock/defaults";
import { metrifoxIdentityDefaults } from "./metrifox/defaults";
import {
  stripeAgreementDefaults,
  stripeCatalogDefaults,
  stripeIdentityDefaults,
} from "./stripe/defaults";
import { HUBSPOT_PROVIDER_NAME } from "./hubspot/provider";
import { SALESFORCE_PROVIDER_NAME } from "./salesforce/provider";
import { MOCK_PROVIDER_NAME } from "./mock/provider";
import { METRIFOX_PROVIDER_NAME } from "./metrifox/provider";
import { STRIPE_PROVIDER_NAME } from "./stripe/provider";
import { chargebeeIdentityDefaults } from "./chargebee/defaults";
import { CHARGEBEE_PROVIDER_NAME } from "./chargebee/provider";

const DEFAULTS: Record<string, FieldMappingRule[]> = {
  [`identity:${HUBSPOT_PROVIDER_NAME}`]: hubspotIdentityDefaults,
  [`identity:${SALESFORCE_PROVIDER_NAME}`]: salesforceIdentityDefaults,
  [`identity:${MOCK_PROVIDER_NAME}`]: mockIdentityDefaults,
  [`identity:${METRIFOX_PROVIDER_NAME}`]: metrifoxIdentityDefaults,
  [`identity:${STRIPE_PROVIDER_NAME}`]: stripeIdentityDefaults,
  [`identity:${CHARGEBEE_PROVIDER_NAME}`]: chargebeeIdentityDefaults,
  [`catalog:${STRIPE_PROVIDER_NAME}`]: stripeCatalogDefaults,
  [`agreement:${STRIPE_PROVIDER_NAME}`]: stripeAgreementDefaults,
};

export function defaultMappingsFor(
  functionName: string,
  providerName: string
): FieldMappingRule[] {
  return (DEFAULTS[`${functionName}:${providerName}`] ?? []).map((r) => ({ ...r }));
}
