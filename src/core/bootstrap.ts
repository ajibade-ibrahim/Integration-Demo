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
  HUBSPOT_AGREEMENT_SCOPES,
  HUBSPOT_PROVIDER_NAME,
} from "./providers/hubspot/provider";
import {
  salesforceProvider,
  SALESFORCE_IDENTITY_SCOPES,
  SALESFORCE_SUPPORT_SCOPES,
  SALESFORCE_AGREEMENT_SCOPES,
  SALESFORCE_PROVIDER_NAME,
} from "./providers/salesforce/provider";
import {
  isMockEnabled,
  mockProvider,
  MOCK_AGREEMENT_SCOPES,
  MOCK_BILLING_SCOPES,
  MOCK_IDENTITY_SCOPES,
  MOCK_SUPPORT_SCOPES,
  MOCK_PROVIDER_NAME,
} from "./providers/mock/provider";
import {
  metrifoxProvider,
  METRIFOX_IDENTITY_SCOPES,
  METRIFOX_AGREEMENT_SCOPES,
  METRIFOX_PROVIDER_NAME,
} from "./providers/metrifox/provider";
import {
  stripeProvider,
  STRIPE_IDENTITY_SCOPES,
  STRIPE_AGREEMENT_SCOPES,
  STRIPE_CATALOG_SCOPES,
  STRIPE_PROVIDER_NAME,
} from "./providers/stripe/provider";
import {
  chargebeeProvider,
  CHARGEBEE_CATALOG_SCOPES,
  CHARGEBEE_IDENTITY_SCOPES,
  CHARGEBEE_PROVIDER_NAME,
} from "./providers/chargebee/provider";

import { metrifoxIdentityHandler } from "./providers/metrifox/identity-handler";
import { metrifoxFieldDiscovery } from "./providers/metrifox/discovery";
import { stripeIdentityHandler } from "./providers/stripe/identity-handler";
import { stripeAgreementHandler } from "./providers/stripe/agreement-handler";
import { stripeCatalogHandler } from "./providers/stripe/catalog-handler";
import { stripeFieldDiscovery } from "./providers/stripe/discovery";
import { chargebeeCatalogHandler } from "./providers/chargebee/catalog-handler";
import { chargebeeIdentityHandler } from "./providers/chargebee/identity-handler";
import { chargebeeFieldDiscovery } from "./providers/chargebee/discovery";
import { mockIdentityHandler } from "./providers/mock/identity-handler";
import { mockFieldDiscovery } from "./providers/mock/discovery";
import { hubspotIdentityHandler } from "./providers/hubspot/identity-handler";
import { hubspotFieldDiscovery } from "./providers/hubspot/discovery";
import { salesforceIdentityHandler } from "./providers/salesforce/identity-handler";
import { salesforceFieldDiscovery } from "./providers/salesforce/discovery";

export const IDENTITY_FUNCTION = "identity";
export const CATALOG_FUNCTION = "catalog";
export const AGREEMENT_FUNCTION = "agreement";

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
  registerProvider(chargebeeProvider);
  if (isMockEnabled()) registerProvider(mockProvider);

  // --- functions ---------------------------------------------------------
  // Declaring scopes for a (function, provider) pair claims that the provider
  // can serve that function and that these are the scopes it would need. It
  // does not claim we have built the handler — the picker reads the handler
  // registry separately and marks a function visibly unavailable.
  //
  // Billing stays mock-only although Stripe and Metrifox both have invoice
  // APIs. That is deliberate rather than an oversight: it keeps
  // `providerNamesForFunctions(["identity","billing"])` a genuine partial
  // intersection, which is the only place the "a provider must cover the whole
  // set" rule is observable, and `tests/unit/multi-function.test.ts` pins it.
  // Agreement is the deliberate widening that comment used to ask for.
  const identityScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_IDENTITY_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_IDENTITY_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_IDENTITY_SCOPES],
    [STRIPE_PROVIDER_NAME, STRIPE_IDENTITY_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_IDENTITY_SCOPES],
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

  // Catalog: what the company sells, and the second function with a working
  // handler.
  //
  // Stripe only, for now, and honestly so — it is the provider whose API maps
  // onto this cleanly, a `product` to a Product and a `price` to an Offering.
  // The CRMs have product objects too (HubSpot line items, Salesforce
  // Product2/PricebookEntry) and declaring scopes for them here would be a
  // claim we have not checked.
  //
  // Independent of identity by construction: a product exists whether or not
  // anyone has bought it, and nothing in the catalog references a customer. So
  // this can be selected on its own, and `providerNamesForFunctions(["identity",
  // "catalog"])` is a real intersection rather than a formality.
  const catalogScopes: Array<[string, readonly string[]]> = [
    [STRIPE_PROVIDER_NAME, STRIPE_CATALOG_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_CATALOG_SCOPES],
  ];

  registerFunction({
    name: CATALOG_FUNCTION,
    label: "Catalog",
    description:
      "Products and the offerings that price them — what is for sale, at what amount, on what billing interval.",
    dataModels: ["product", "offering", "price", "productFeature"],
    scopesByProvider: scopeMap(catalogScopes),
  });

  // Agreement: the commercial spine, and the first function declared on four
  // real providers at once. That breadth is the point rather than a bonus —
  // the canonical model insists one agreement covers both a self-serve
  // subscription and a sales-led order form, and the scope sets are where that
  // claim first becomes checkable: Salesforce supplies Contract, Stripe
  // supplies subscriptions, Metrifox supplies both, HubSpot supplies deals.
  //
  // `dataModels` names two objects, and the pair is the whole design. The
  // canonical AGREEMENT node is six fields — id, account, offering, type,
  // status, effective date — and `agreement` is exactly that. `subscription`
  // holds what is true of subscriptions alone: the period, the trial, the
  // cancellation intent.
  //
  // Splitting them rather than widening one table is what keeps the promise
  // this comment used to make in the abstract. On a shared table no
  // type-specific column can be NOT NULL, because every column must tolerate
  // the types that lack it — `Subscription` can require a period, an
  // `Agreement` with a period column never could. The fourth type is then a
  // new table rather than an ALTER against every row already stored.
  //
  // What was expensive to retrofit is unchanged and is now built: the
  // `agreement_type` discriminator and the foreign-key shape.
  //
  // `agreementItem` is the third object, and it is what `Subscription.itemCount`
  // was the marker for. It hangs off `agreement` rather than `subscription`
  // because line items belong to every type and are the *primary* structure of
  // three of them — Salesforce ContractLineItem and OrderItem, HubSpot deal
  // line items, and an order form that is little more than a header plus its
  // lines. Only Stripe has a handler today, so only subscriptions produce
  // them; the table is shaped for the other three regardless.
  //
  // The rest of the twelve-object zoom-in (terms, amendments, acceptance,
  // renewals, concessions) is still additive and still unbuilt — modelling
  // amendments before anything reads them would be the opposite mistake.
  const agreementScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_AGREEMENT_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_AGREEMENT_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_AGREEMENT_SCOPES],
    [STRIPE_PROVIDER_NAME, STRIPE_AGREEMENT_SCOPES],
  ];
  if (isMockEnabled()) {
    agreementScopes.push([MOCK_PROVIDER_NAME, MOCK_AGREEMENT_SCOPES]);
  }

  registerFunction({
    name: AGREEMENT_FUNCTION,
    label: "Agreement",
    description:
      "Subscriptions, order forms and contracts — what the customer agreed to, on what terms, and when it changes.",
    dataModels: ["agreement", "subscription", "agreementItem"],
    scopesByProvider: scopeMap(agreementScopes),
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
  // Invoice, charge and payment — not subscription. A subscription is a
  // *specialization of* agreement in the canonical model, not a sibling of
  // invoice, and declaring it here is what would eventually produce the
  // "subscription table" that order forms and amendments then have to be
  // retrofitted onto. That retrofit is named as the expensive path in the
  // framework doc, so the fix belongs at the declaration, before anything is
  // built against it.
  registerFunction({
    name: "billing",
    label: "Billing",
    description: "Invoices, charges, and payment history.",
    dataModels: ["invoice", "charge", "payment"],
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

  registerSyncHandler(
    IDENTITY_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeIdentityHandler
  );
  registerFieldDiscovery(
    IDENTITY_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeFieldDiscovery
  );

  // The same discoverer serves all three functions: it switches on the target
  // object rather than the function, so registering it repeatedly is not a
  // duplicate but the entries the (function, provider) key requires.
  registerSyncHandler(CATALOG_FUNCTION, STRIPE_PROVIDER_NAME, stripeCatalogHandler);
  registerFieldDiscovery(CATALOG_FUNCTION, STRIPE_PROVIDER_NAME, stripeFieldDiscovery);

  registerSyncHandler(
    CATALOG_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeCatalogHandler
  );
  registerFieldDiscovery(
    CATALOG_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeFieldDiscovery
  );

  // Stripe is the first provider to make `agreement` real. Its scopes were
  // declared long before this handler existed, so nothing about the picker,
  // the consent screen or the scope union changes here.
  registerSyncHandler(
    AGREEMENT_FUNCTION,
    STRIPE_PROVIDER_NAME,
    stripeAgreementHandler
  );
  registerFieldDiscovery(
    AGREEMENT_FUNCTION,
    STRIPE_PROVIDER_NAME,
    stripeFieldDiscovery
  );

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
