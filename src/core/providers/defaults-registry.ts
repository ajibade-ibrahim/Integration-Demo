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
  stripeBillingDefaults,
  stripeCatalogDefaults,
  stripeIdentityDefaults,
} from "./stripe/defaults";
import { HUBSPOT_PROVIDER_NAME } from "./hubspot/provider";
import { SALESFORCE_PROVIDER_NAME } from "./salesforce/provider";
import { MOCK_PROVIDER_NAME } from "./mock/provider";
import { METRIFOX_PROVIDER_NAME } from "./metrifox/provider";
import { STRIPE_PROVIDER_NAME } from "./stripe/provider";
import {
  chargebeeAgreementDefaults,
  chargebeeBillingDefaults,
  chargebeeCatalogDefaults,
  chargebeeIdentityDefaults,
} from "./chargebee/defaults";
import { CHARGEBEE_PROVIDER_NAME } from "./chargebee/provider";
import {
  stiggAgreementDefaults,
  stiggCatalogDefaults,
  stiggIdentityDefaults,
} from "./stigg/defaults";
import { STIGG_PROVIDER_NAME } from "./stigg/provider";

const DEFAULTS: Record<string, readonly FieldMappingRule[]> = {
  [`identity:${HUBSPOT_PROVIDER_NAME}`]: hubspotIdentityDefaults,
  [`identity:${SALESFORCE_PROVIDER_NAME}`]: salesforceIdentityDefaults,
  [`identity:${MOCK_PROVIDER_NAME}`]: mockIdentityDefaults,
  [`identity:${METRIFOX_PROVIDER_NAME}`]: metrifoxIdentityDefaults,
  [`identity:${STRIPE_PROVIDER_NAME}`]: stripeIdentityDefaults,
  [`identity:${CHARGEBEE_PROVIDER_NAME}`]: chargebeeIdentityDefaults,
  [`identity:${STIGG_PROVIDER_NAME}`]: stiggIdentityDefaults,
  [`catalog:${STRIPE_PROVIDER_NAME}`]: stripeCatalogDefaults,
  [`catalog:${CHARGEBEE_PROVIDER_NAME}`]: chargebeeCatalogDefaults,
  [`catalog:${STIGG_PROVIDER_NAME}`]: stiggCatalogDefaults,
  [`agreement:${STRIPE_PROVIDER_NAME}`]: stripeAgreementDefaults,
  [`agreement:${CHARGEBEE_PROVIDER_NAME}`]: chargebeeAgreementDefaults,
  [`agreement:${STIGG_PROVIDER_NAME}`]: stiggAgreementDefaults,
  [`billing:${STRIPE_PROVIDER_NAME}`]: stripeBillingDefaults,
  [`billing:${CHARGEBEE_PROVIDER_NAME}`]: chargebeeBillingDefaults,
};

export function defaultMappingsFor(
  functionName: string,
  providerName: string
): FieldMappingRule[] {
  return (DEFAULTS[`${functionName}:${providerName}`] ?? []).map((r) => ({ ...r }));
}
