/**
 * Registry bootstrap — the one place functions, providers, and handlers are
 * declared.
 *
 * All seven functions are registered, but a handler exists only for the
 * provider/function pairs that are actually built. That is deliberate: scope
 * declarations keep the roadmap and the consent rules honest, while the
 * capability layer filters unbuilt pairs out of the picker and connect API.
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
  METRIFOX_BILLING_SCOPES,
  METRIFOX_PROVIDER_NAME,
} from "./providers/metrifox/provider";
import {
  stripeProvider,
  STRIPE_IDENTITY_SCOPES,
  STRIPE_AGREEMENT_SCOPES,
  STRIPE_BILLING_SCOPES,
  STRIPE_CATALOG_SCOPES,
  STRIPE_PROVIDER_NAME,
} from "./providers/stripe/provider";
import {
  chargebeeProvider,
  CHARGEBEE_AGREEMENT_SCOPES,
  CHARGEBEE_BILLING_SCOPES,
  CHARGEBEE_CATALOG_SCOPES,
  CHARGEBEE_IDENTITY_SCOPES,
  CHARGEBEE_PROVIDER_NAME,
} from "./providers/chargebee/provider";
import {
  stiggProvider,
  STIGG_AGREEMENT_SCOPES,
  STIGG_CATALOG_SCOPES,
  STIGG_IDENTITY_SCOPES,
  STIGG_PROVIDER_NAME,
} from "./providers/stigg/provider";
import {
  gmailProvider,
  GMAIL_COMMUNICATION_SCOPES,
  GMAIL_PROVIDER_NAME,
} from "./providers/gmail/provider";
import {
  slackProvider,
  SLACK_COMMUNICATION_SCOPES,
  SLACK_PROVIDER_NAME,
} from "./providers/slack/provider";

import { metrifoxIdentityHandler } from "./providers/metrifox/identity-handler";
import { metrifoxAgreementHandler } from "./providers/metrifox/agreement-handler";
import { metrifoxBillingHandler } from "./providers/metrifox/billing-handler";
import { metrifoxFieldDiscovery } from "./providers/metrifox/discovery";
import { stripeIdentityHandler } from "./providers/stripe/identity-handler";
import { stripeAgreementHandler } from "./providers/stripe/agreement-handler";
import { stripeBillingHandler } from "./providers/stripe/billing-handler";
import { stripeCatalogHandler } from "./providers/stripe/catalog-handler";
import { stripeFieldDiscovery } from "./providers/stripe/discovery";
import { chargebeeCatalogHandler } from "./providers/chargebee/catalog-handler";
import { chargebeeAgreementHandler } from "./providers/chargebee/agreement-handler";
import { chargebeeBillingHandler } from "./providers/chargebee/billing-handler";
import { chargebeeIdentityHandler } from "./providers/chargebee/identity-handler";
import { chargebeeFieldDiscovery } from "./providers/chargebee/discovery";
import { stiggIdentityHandler } from "./providers/stigg/identity-handler";
import { stiggCatalogHandler } from "./providers/stigg/catalog-handler";
import { stiggAgreementHandler } from "./providers/stigg/agreement-handler";
import { stiggFieldDiscovery } from "./providers/stigg/discovery";
import { mockIdentityHandler } from "./providers/mock/identity-handler";
import { mockFieldDiscovery } from "./providers/mock/discovery";
import { hubspotIdentityHandler } from "./providers/hubspot/identity-handler";
import { hubspotAgreementHandler } from "./providers/hubspot/agreement-handler";
import { hubspotFieldDiscovery } from "./providers/hubspot/discovery";
import { salesforceIdentityHandler } from "./providers/salesforce/identity-handler";
import { salesforceFieldDiscovery } from "./providers/salesforce/discovery";
import { gmailCommunicationHandler } from "./providers/gmail/communication-handler";
import { gmailFieldDiscovery } from "./providers/gmail/discovery";
import { slackCommunicationHandler } from "./providers/slack/communication-handler";
import { slackFieldDiscovery } from "./providers/slack/discovery";

export const IDENTITY_FUNCTION = "identity";
export const CATALOG_FUNCTION = "catalog";
export const AGREEMENT_FUNCTION = "agreement";
export const BILLING_FUNCTION = "billing";
export const COMMUNICATION_FUNCTION = "communication";

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
  // Same again: Stigg's server key is pasted per integration, so there is
  // nothing deployment-level to configure.
  registerProvider(stiggProvider);
  // Gmail needs deployment-level OAuth credentials; registration is still
  // unconditional, and the picker greys it out until they are set.
  registerProvider(gmailProvider);
  // Slack is the same: a deployment-level OAuth app with user scopes only.
  registerProvider(slackProvider);
  if (isMockEnabled()) registerProvider(mockProvider);

  // --- functions ---------------------------------------------------------
  // Declaring scopes for a (function, provider) pair claims that the provider
  // can serve that function and that these are the scopes it would need. It
  // does not claim we have built the handler — the capability layer requires
  // both a handler and its declared target objects before offering the pair.
  //
  // Billing is now real on Stripe, Chargebee and Metrifox, and stays declared
  // on the mock so scope isolation ("authorizing for identity must never
  // request `billing.invoices.read`") keeps a subject. That keeps
  // `providerNamesForFunctions(["identity","billing"])` a genuine partial
  // intersection — hubspot, salesforce and stigg have identity but no billing
  // scopes — which is the only place the "a provider must cover the whole set"
  // rule is observable. `tests/unit/multi-function.test.ts` pins the result.
  // Agreement is the deliberate widening that comment used to ask for.
  const identityScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_IDENTITY_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_IDENTITY_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_IDENTITY_SCOPES],
    [STRIPE_PROVIDER_NAME, STRIPE_IDENTITY_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_IDENTITY_SCOPES],
    [STIGG_PROVIDER_NAME, STIGG_IDENTITY_SCOPES],
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
  // Chargebee and Stigg are on the list. Stigg is the first provider whose API
  // serves `feature` and `entitlement` natively — features are first-class and
  // an entitlement is a feature's configuration on a package, not an
  // approximation. The CRMs have product objects too (HubSpot line items,
  // Salesforce Product2/PricebookEntry) and declaring scopes for them here
  // would be a claim we have not checked.
  //
  // Independent of identity by construction: a product exists whether or not
  // anyone has bought it, and nothing in the catalog references a customer. So
  // this can be selected on its own, and `providerNamesForFunctions(["identity",
  // "catalog"])` is a real intersection rather than a formality.
  const catalogScopes: Array<[string, readonly string[]]> = [
    [STRIPE_PROVIDER_NAME, STRIPE_CATALOG_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_CATALOG_SCOPES],
    [STIGG_PROVIDER_NAME, STIGG_CATALOG_SCOPES],
  ];

  registerFunction({
    name: CATALOG_FUNCTION,
    label: "Catalog",
    description:
      "Products and the offerings that price them — what is for sale, at what amount, on what billing interval.",
    dataModels: ["product", "offering", "price", "feature", "entitlement"],
    scopesByProvider: scopeMap(catalogScopes),
  });

  // Agreement: the commercial spine, and the first function declared on four
  // real providers at once. That breadth is the point rather than a bonus —
  // the canonical model insists one agreement covers both a self-serve
  // subscription and a sales-led order form, and the scope sets are where that
  // claim first becomes checkable: Salesforce supplies Contract, Stripe
  // supplies subscriptions, HubSpot supplies deals. Stigg joins with a fifth
  // contract-like shape — the subscription it already supplies catalog and
  // identity for — and is the first provider whose lines type themselves
  // first-class (a plan line and its addons).
  //
  // Metrifox is subscriptions only. Its scope used to claim `orders:read` as
  // well, but the public API exposes `POST /api/v1/orders` and no read of any
  // kind, so the claim was removed rather than left as roadmap. Its agreements
  // are read by fanning out from the customer details payload, because there
  // is no subscription list endpoint either.
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
  // lines. Stripe, Chargebee and Stigg all produce them today; the table is
  // shaped for the other two regardless.
  //
  // `agreementEntitlement` and `agreementDiscount` are the fourth and fifth:
  // what this subscriber actually gets and what was taken off, both off the
  // same subscription record. They are the first agreement objects that can
  // legitimately be empty per subscription, which is why the writer's
  // completeness signal exists. Stigg builds the discount one and deliberately
  // not the entitlement one: its REST API exposes no effective entitlement
  // values per subscription, so the catalog function owns plan-level
  // entitlements and the agreement function leaves this object unbuilt rather
  // than misattributing a customer-wide aggregate.
  //
  // The rest of the twelve-object zoom-in (terms, amendments, acceptance,
  // renewals, concessions) is still additive and still unbuilt — modelling
  // amendments before anything reads them would be the opposite mistake.
  const agreementScopes: Array<[string, readonly string[]]> = [
    [HUBSPOT_PROVIDER_NAME, HUBSPOT_AGREEMENT_SCOPES],
    [SALESFORCE_PROVIDER_NAME, SALESFORCE_AGREEMENT_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_AGREEMENT_SCOPES],
    [STRIPE_PROVIDER_NAME, STRIPE_AGREEMENT_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_AGREEMENT_SCOPES],
    [STIGG_PROVIDER_NAME, STIGG_AGREEMENT_SCOPES],
  ];
  if (isMockEnabled()) {
    agreementScopes.push([MOCK_PROVIDER_NAME, MOCK_AGREEMENT_SCOPES]);
  }

  registerFunction({
    name: AGREEMENT_FUNCTION,
    label: "Agreement",
    description:
      "Subscriptions, order forms and contracts — what the customer agreed to, on what terms, and when it changes.",
    dataModels: [
      "agreement",
      "subscription",
      "agreementItem",
      "agreementEntitlement",
      "agreementDiscount",
    ],
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

  // Billing: the invoices a customer was sent and the money that moved. Real on
  // the three providers that already ship the functions an invoice hangs off —
  // Stripe, Chargebee and Metrifox — and declared on the mock only for scope
  // isolation.
  //
  // Metrifox is invoice-only: its public API exposes no invoice lines and no
  // payment list, so its handler declares one object even though the function
  // offers three. The capability layer reports that narrower coverage.
  //
  // The mock keeps its scopes so that authorizing for identity never requests a
  // billing scope, which is the observable form of the isolation rule; it gets
  // no handler, so it remains a deliberately unbuildable provider here.
  //
  // `dataModels` names three objects, and the order is the write order an
  // invoice's children need. `charge` is deliberately absent: the word means
  // three different things across these providers, and what it used to stand in
  // for — the billed amount on the invoice — is `invoiceLine`.
  const billingScopes: Array<[string, readonly string[]]> = [
    [STRIPE_PROVIDER_NAME, STRIPE_BILLING_SCOPES],
    [CHARGEBEE_PROVIDER_NAME, CHARGEBEE_BILLING_SCOPES],
    [METRIFOX_PROVIDER_NAME, METRIFOX_BILLING_SCOPES],
  ];
  if (isMockEnabled()) {
    billingScopes.push([MOCK_PROVIDER_NAME, MOCK_BILLING_SCOPES]);
  }

  registerFunction({
    name: "billing",
    label: "Billing",
    description: "Invoices, invoice lines, and payment history.",
    dataModels: ["invoice", "invoiceLine", "payment"],
    scopesByProvider: scopeMap(billingScopes),
  });

  registerFunction({
    name: "usage",
    label: "Usage",
    description: "Product usage events and metering data.",
    dataModels: ["usageEvent"],
    scopesByProvider: scopeMap([]),
  });

  // Communication is read-only conversation history. Gmail declares its
  // restricted `gmail.readonly` scope here; Slack declares user scopes only,
  // because it connects with a user token and reads exactly what the authorizing
  // teammate can see. Consent, the picker and the sync handlers agree from this
  // one list.
  registerFunction({
    name: COMMUNICATION_FUNCTION,
    label: "Communication",
    description:
      "Email messages and Slack conversation history attributed to customers.",
    dataModels: ["emailMessage", "slackMessage"],
    scopesByProvider: scopeMap([
      [GMAIL_PROVIDER_NAME, GMAIL_COMMUNICATION_SCOPES],
      [SLACK_PROVIDER_NAME, SLACK_COMMUNICATION_SCOPES],
    ]),
  });

  // --- handlers ----------------------------------------------------------
  // A function declared with scopes but no handler remains a reachable, honest
  // state for the scope registry, but the picker and connect API filter it out.
  // Each handler also declares the objects it writes, so capability can describe
  // a provider's actual coverage instead of repeating the function's roadmap.
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

  // Metrifox is an API-key provider with identity built first. Its customer
  // list is the same page the agreement and billing handlers start from, which
  // is why each run paginates it separately — see `agreement-handler.ts` and
  // `billing-handler.ts`.
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

  // Stigg joins as an identity provider, and (below) catalog and agreement
  // ones. Its discovery instance switches on the target object, so the same
  // instance is registered for all three functions rather than duplicated per
  // function.
  registerSyncHandler(
    IDENTITY_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggIdentityHandler
  );
  registerFieldDiscovery(
    IDENTITY_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggFieldDiscovery
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

  // Stigg's catalog handler, after Chargebee's. The discoverer is the same
  // instance the identity registration uses — the switch is on the object, not
  // the function — so this is an entry the (function, provider) key requires
  // rather than a second implementation.
  registerSyncHandler(
    CATALOG_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggCatalogHandler
  );
  registerFieldDiscovery(
    CATALOG_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggFieldDiscovery
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

  // Chargebee joins Stripe as an agreement provider. Its scopes were not
  // declared before this handler existed, unlike Stripe's, so the picker gains
  // a provider at the same moment the handler does.
  registerSyncHandler(
    AGREEMENT_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeAgreementHandler
  );
  registerFieldDiscovery(
    AGREEMENT_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeFieldDiscovery
  );

  // Stigg's agreement handler, after Chargebee's, and the same discoverer
  // instance again. One endpoint means one file: the subscription list carries
  // the lines and coupons inline, so there is nothing here for a fan-out.
  registerSyncHandler(
    AGREEMENT_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggAgreementHandler
  );
  registerFieldDiscovery(
    AGREEMENT_FUNCTION,
    STIGG_PROVIDER_NAME,
    stiggFieldDiscovery
  );

  // Metrifox joins as an agreement provider. Its scope was declared before a
  // handler existed, so the capability layer filtered it out of the picker;
  // the picker gains the provider at the same moment the handler does. The
  // discoverer is the instance the identity registration uses — it switches on
  // the target object, not the function.
  registerSyncHandler(
    AGREEMENT_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxAgreementHandler
  );
  registerFieldDiscovery(
    AGREEMENT_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxFieldDiscovery
  );

  // HubSpot's agreement function is deals, with their line items read from a
  // second paginated list. The scopes were declared long before this handler,
  // so the picker already offered it; only the sync becomes real here.
  registerSyncHandler(
    AGREEMENT_FUNCTION,
    HUBSPOT_PROVIDER_NAME,
    hubspotAgreementHandler
  );
  registerFieldDiscovery(
    AGREEMENT_FUNCTION,
    HUBSPOT_PROVIDER_NAME,
    hubspotFieldDiscovery
  );

  // Billing, on Stripe, Chargebee and Metrifox. The discoverer switches on the
  // target object, so the same instance serves billing and the functions above.
  registerSyncHandler(
    BILLING_FUNCTION,
    STRIPE_PROVIDER_NAME,
    stripeBillingHandler
  );
  registerFieldDiscovery(
    BILLING_FUNCTION,
    STRIPE_PROVIDER_NAME,
    stripeFieldDiscovery
  );

  registerSyncHandler(
    BILLING_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeBillingHandler
  );
  registerFieldDiscovery(
    BILLING_FUNCTION,
    CHARGEBEE_PROVIDER_NAME,
    chargebeeFieldDiscovery
  );

  // Metrifox's billing handler is invoice-only; the same discoverer instance
  // offers only the invoice section because its switch returns nothing for the
  // line and payment objects.
  registerSyncHandler(
    BILLING_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxBillingHandler
  );
  registerFieldDiscovery(
    BILLING_FUNCTION,
    METRIFOX_PROVIDER_NAME,
    metrifoxFieldDiscovery
  );

  // Gmail communication. The handler is the only streaming one today; its
  // `attributionsOf` hook is what lets the engine filter and write page by page.
  registerSyncHandler(
    COMMUNICATION_FUNCTION,
    GMAIL_PROVIDER_NAME,
    gmailCommunicationHandler
  );
  registerFieldDiscovery(
    COMMUNICATION_FUNCTION,
    GMAIL_PROVIDER_NAME,
    gmailFieldDiscovery
  );

  // Slack communication. Its handler is conversation-scoped: it requires
  // `slackConversationMappings` from the engine and reads only conversations a
  // human mapped to a customer.
  registerSyncHandler(
    COMMUNICATION_FUNCTION,
    SLACK_PROVIDER_NAME,
    slackCommunicationHandler
  );
  registerFieldDiscovery(
    COMMUNICATION_FUNCTION,
    SLACK_PROVIDER_NAME,
    slackFieldDiscovery
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
