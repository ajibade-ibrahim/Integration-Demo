/**
 * Registry bootstrap — the one place functions, providers, and handlers are
 * declared.
 *
 * All five functions are registered although only `identity` has a working
 * handler. That is deliberate: it makes the function picker honest, and it
 * keeps "no providers support this function yet" a reachable state rather than
 * something only tests ever see.
 *
 * An integration serves a *set* of functions, so scope sets compose. HubSpot
 * declaring both identity and support is the motivating case — one connection,
 * one consent, scopes unioned across the selected functions.
 */

import {
  functionRegistry,
  registerFunction,
} from "./registries/function-registry";
import {
  providerRegistry,
  registerProvider,
} from "./registries/provider-registry";
import {
  clearHandlerRegistries,
  registerFieldDiscovery,
  registerSyncHandler,
} from "./registries/handler-registry";

import {
  hubspotProvider,
  HUBSPOT_IDENTITY_SCOPES,
  HUBSPOT_SUPPORT_SCOPES,
  HUBSPOT_PROVIDER_NAME,
} from "./providers/hubspot/provider";
import {
  salesforceProvider,
  SALESFORCE_IDENTITY_SCOPES,
  SALESFORCE_SUPPORT_SCOPES,
  SALESFORCE_PROVIDER_NAME,
} from "./providers/salesforce/provider";
import {
  isMockEnabled,
  mockProvider,
  MOCK_BILLING_SCOPES,
  MOCK_IDENTITY_SCOPES,
  MOCK_SUPPORT_SCOPES,
  MOCK_PROVIDER_NAME,
} from "./providers/mock/provider";
import {
  metrifoxProvider,
  METRIFOX_IDENTITY_SCOPES,
  METRIFOX_PROVIDER_NAME,
} from "./providers/metrifox/provider";
import {
  stripeProvider,
  STRIPE_IDENTITY_SCOPES,
  STRIPE_PROVIDER_NAME,
} from "./providers/stripe/provider";

import { metrifoxIdentityHandler } from "./providers/metrifox/identity-handler";
import { metrifoxFieldDiscovery } from "./providers/metrifox/discovery";
import { stripeIdentityHandler } from "./providers/stripe/identity-handler";
import { stripeFieldDiscovery } from "./providers/stripe/discovery";
import { mockIdentityHandler } from "./providers/mock/identity-handler";
import { mockFieldDiscovery } from "./providers/mock/discovery";
import { hubspotIdentityHandler } from "./providers/hubspot/identity-handler";
import { hubspotFieldDiscovery } from "./providers/hubspot/discovery";
import { salesforceIdentityHandler } from "./providers/salesforce/identity-handler";
import { salesforceFieldDiscovery } from "./providers/salesforce/discovery";

export const IDENTITY_FUNCTION = "identity";

let bootstrapped = false;

function scopeMap(
  entries: Array<[string, readonly string[]]>
): ReadonlyMap<string, readonly string[]> {
  return new Map(entries);
}

/**
 * Populate the registries. Idempotent — safe to call from every entry point
 * (route handlers, scripts, tests) without guarding at the call site.
 */
export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // --- providers ---------------------------------------------------------
  registerProvider(hubspotProvider);
  registerProvider(salesforceProvider);
  // Need no credentials in .env — their key is supplied per integration — so
  // they register unconditionally.
  registerProvider(metrifoxProvider);
  registerProvider(stripeProvider);
  if (isMockEnabled()) registerProvider(mockProvider);

  // --- functions ---------------------------------------------------------
  // Metrifox and Stripe declare identity only. Both have billing APIs too —
  // Stripe conspicuously so — but adding those here would change what
  // `providerNamesForFunctions` returns for ["identity","billing"], which
  // `tests/unit/multi-function.test.ts` pins. Widening it is a deliberate
  // change, not a drive-by: the billing function has no target schema and no
  // handlers, so a provider claiming it would be claiming something untrue.
  const identityScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_IDENTITY_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_IDENTITY_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_IDENTITY_SCOPES],
    [STRIPE_PROVIDER_NAME, STRIPE_IDENTITY_SCOPES],
  ];
  if (isMockEnabled()) {
    identityScopes.push([MOCK_PROVIDER_NAME, MOCK_IDENTITY_SCOPES]);
  }

  registerFunction({
    name: IDENTITY_FUNCTION,
    label: "Identity",
    description:
      "Customer accounts and the people associated with them — names, domains, industries, emails, job titles.",
    dataModels: ["customer", "contact"],
    scopesByProvider: scopeMap(identityScopes),
  });

  // Support: declared with real scopes on both CRMs, because one integration
  // commonly serves several functions — a single HubSpot connection supplies
  // identity from companies and contacts, and support from tickets. The scopes
  // requested at authorization are the union across whichever functions the
  // user picked, which is why they must be chosen before consent.
  //
  // The two providers differ instructively here. HubSpot's scopes are granular,
  // so adding support genuinely widens the request. Salesforce's `api` scope
  // already spans Case, so its scope set is unchanged. Holding scopes per
  // (function, provider) is what lets both be true at once.
  const supportScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_SUPPORT_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_SUPPORT_SCOPES],
  ];
  if (isMockEnabled()) {
    supportScopes.push([MOCK_PROVIDER_NAME, MOCK_SUPPORT_SCOPES]);
  }

  registerFunction({
    name: "support",
    label: "Support",
    description: "Tickets, conversations, and satisfaction scores.",
    dataModels: ["ticket"],
    scopesByProvider: scopeMap(supportScopes),
  });

  // Functions with neither handlers nor providers yet. Selecting one correctly
  // yields an empty provider list and blocks the flow. The mock declares
  // billing scopes only so scope isolation stays observable — authorizing for
  // identity must never request `billing.invoices.read`.
  registerFunction({
    name: "billing",
    label: "Billing",
    description: "Invoices, subscriptions, and payment history.",
    dataModels: ["invoice", "subscription"],
    scopesByProvider: scopeMap(
      isMockEnabled() ? [[MOCK_PROVIDER_NAME, MOCK_BILLING_SCOPES]] : []
    ),
  });

  for (const [name, label, description, models] of [
    ["usage", "Usage", "Product usage events and metering data.", ["usageEvent"]],
    [
      "communication",
      "Communication",
      "Email, calls, and messaging history with contacts.",
      ["message"],
    ],
  ] as const) {
    registerFunction({
      name,
      label,
      description,
      dataModels: [...models],
      scopesByProvider: scopeMap([]),
    });
  }

  // --- handlers ----------------------------------------------------------
  // Only identity has handlers. A function declared with scopes but no handler
  // is a reachable, honest state — the user can select it and see it listed,
  // and the sync engine says so plainly rather than failing obscurely.
  registerSyncHandler(IDENTITY_FUNCTION, HUBSPOT_PROVIDER_NAME, hubspotIdentityHandler);
  registerFieldDiscovery(IDENTITY_FUNCTION, HUBSPOT_PROVIDER_NAME, hubspotFieldDiscovery);

  registerSyncHandler(
    IDENTITY_FUNCTION,
    SALESFORCE_PROVIDER_NAME,
    salesforceIdentityHandler
  );
  registerFieldDiscovery(
    IDENTITY_FUNCTION,
    SALESFORCE_PROVIDER_NAME,
    salesforceFieldDiscovery
  );

  registerSyncHandler(
    IDENTITY_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxIdentityHandler
  );
  registerFieldDiscovery(
    IDENTITY_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxFieldDiscovery
  );

  registerSyncHandler(IDENTITY_FUNCTION, STRIPE_PROVIDER_NAME, stripeIdentityHandler);
  registerFieldDiscovery(IDENTITY_FUNCTION, STRIPE_PROVIDER_NAME, stripeFieldDiscovery);

  if (isMockEnabled()) {
    registerSyncHandler(IDENTITY_FUNCTION, MOCK_PROVIDER_NAME, mockIdentityHandler);
    registerFieldDiscovery(IDENTITY_FUNCTION, MOCK_PROVIDER_NAME, mockFieldDiscovery);
  }
}

/** Test helper: tear down and re-register from a clean slate. */
export function resetBootstrapForTests(): void {
  functionRegistry.clear();
  providerRegistry.clear();
  clearHandlerRegistries();
  bootstrapped = false;
}
