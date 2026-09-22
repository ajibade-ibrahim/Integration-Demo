/**
 * Splices the catalog, entitlement and agreement fixtures into the Stripe
 * fixture file.
 *
 * A generator rather than a hand-edited JSON blob because every subscription
 * here has to reference a price created earlier in the same run, and the
 * `${name:id}` placeholders are easy to typo and impossible to spot until the
 * CLI fails halfway through seeding a sandbox.
 *
 * Idempotent: re-running replaces the block it added last time rather than
 * appending a second copy.
 *
 * Renamed from `gen-agreement-fixtures.mjs` when it acquired the entitlement
 * block: it seeds the whole catalog now, and a name claiming otherwise is how
 * someone ends up writing a second generator beside it.
 *
 * Run with `npm run fixtures:gen`, then seed with
 * `stripe fixtures scripts/stripe-sandbox-fixtures.json`.
 */

import { readFileSync, writeFileSync } from "node:fs";

const FILE = "scripts/stripe-sandbox-fixtures.json";
const doc = JSON.parse(readFileSync(FILE, "utf8"));

const ref = (name, field = "id") => "${" + name + ":" + field + "}";
const post = (name, path, params) => ({ name, path, method: "post", params });
const remove = (name, path) => ({ name, path, method: "delete", params: {} });

/** Collection by invoice: needs no payment method, and is a real second method. */
const invoiced = { collection_method: "send_invoice", days_until_due: 30 };

// --- Catalog: products -----------------------------------------------------

const products = [
  post("prod_platform", "/v1/products", {
    name: "Platform",
    description: "The base subscription every plan starts from",
    metadata: { plan_family: "platform" },
  }),
  post("prod_seats", "/v1/products", {
    name: "Additional Seats",
    description: "Per-seat add-on, billed with the platform subscription",
    metadata: { plan_family: "platform", addon: "true" },
  }),
  post("prod_support", "/v1/products", {
    name: "Premium Support",
    description: "Billed quarterly, sold on its own",
    metadata: { plan_family: "services" },
  }),
  post("prod_integrations", "/v1/products", {
    name: "Integrations Add-on",
    metadata: { plan_family: "platform", addon: "true" },
  }),
];

// --- Catalog: prices -------------------------------------------------------

const prices = [
  // Nicknamed, so the agreement takes its name from a human's word for it.
  post("price_platform_monthly", "/v1/prices", {
    product: ref("prod_platform"),
    nickname: "Platform - Monthly",
    unit_amount: 4900,
    currency: "usd",
    recurring: { interval: "month" },
  }),
  // No nickname, so the name is synthesized from the money: "$490/year".
  post("price_platform_annual", "/v1/prices", {
    product: ref("prod_platform"),
    unit_amount: 49000,
    currency: "usd",
    recurring: { interval: "year" },
  }),
  // interval_count > 1: "$300/3 months", the pluralized branch.
  post("price_support_quarterly", "/v1/prices", {
    product: ref("prod_support"),
    unit_amount: 30000,
    currency: "usd",
    recurring: { interval: "month", interval_count: 3 },
  }),
  post("price_seats_monthly", "/v1/prices", {
    product: ref("prod_seats"),
    unit_amount: 1500,
    currency: "usd",
    recurring: { interval: "month" },
  }),
  post("price_integrations_monthly", "/v1/prices", {
    product: ref("prod_integrations"),
    unit_amount: 2500,
    currency: "usd",
    recurring: { interval: "month" },
  }),
  // Non-USD, so the symbol comes from Intl rather than a hardcoded dollar sign.
  post("price_platform_gbp", "/v1/prices", {
    product: ref("prod_platform"),
    unit_amount: 3900,
    currency: "gbp",
    recurring: { interval: "month" },
  }),
  // A zero-decimal currency. JPY has no minor unit, so 5000 means 5,000 yen
  // and not 50.00 - the one case formatMoney's Intl exponent lookup exists
  // for, and the one that reads plausibly while being 100x wrong if it breaks.
  post("price_platform_jpy", "/v1/prices", {
    product: ref("prod_platform"),
    unit_amount: 5000,
    currency: "jpy",
    recurring: { interval: "month" },
  }),
  // Tiered, so unit_amount is null and there is no single amount to format.
  // Drives the offering name and the agreement name to their last resort.
  post("price_seats_tiered", "/v1/prices", {
    product: ref("prod_seats"),
    currency: "usd",
    recurring: { interval: "month" },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 10, unit_amount: 1200 },
      { up_to: "inf", unit_amount: 900 },
    ],
  }),
  // Archived immediately below, to give the catalog an inactive offering.
  post("price_platform_legacy", "/v1/prices", {
    product: ref("prod_platform"),
    nickname: "Platform - Legacy",
    unit_amount: 3900,
    currency: "usd",
    recurring: { interval: "month" },
  }),
  post("price_platform_legacy_archive", `/v1/prices/${ref("price_platform_legacy")}`, {
    active: false,
  }),
];

// --- Catalog: entitlement features and their attachments -------------------

// Two objects, not one. A feature is a *definition* and lives on the account;
// attaching it to a product is a separate call that creates a separate object
// (`prodft_...`), and it is the attachment that this integration syncs. The
// split is the reason `feat_api_access` below can appear on two products
// without the fixture file repeating its name or its lookup key.
const features = [
  post("feat_api_access", "/v1/entitlements/features", {
    name: "API access",
    lookup_key: "api-access",
    metadata: { surface: "public" },
  }),
  post("feat_premium_support", "/v1/entitlements/features", {
    name: "Premium support",
    lookup_key: "premium-support",
  }),
  // No metadata and a lookup key that differs from a slug of the name, so
  // nothing downstream can get away with deriving one from the other.
  post("feat_advanced_reporting", "/v1/entitlements/features", {
    name: "Advanced reporting",
    lookup_key: "reporting-v2",
  }),
  // Attached to nothing, deliberately. It must appear nowhere in our data:
  // a standalone Feature table is out of scope, and this fixture is what makes
  // that omission observable rather than merely claimed. If a feature ever
  // shows up here with no product, something started syncing definitions.
  post("feat_unattached", "/v1/entitlements/features", {
    name: "Beta sandbox",
    lookup_key: "beta-sandbox",
  }),
];

const attachments = [
  // Two features on one product: the ordinary case, and the one that proves the
  // per-product page is read past its first row.
  post("prodft_platform_api", `/v1/products/${ref("prod_platform")}/features`, {
    entitlement_feature: ref("feat_api_access"),
  }),
  post(
    "prodft_platform_reporting",
    `/v1/products/${ref("prod_platform")}/features`,
    { entitlement_feature: ref("feat_advanced_reporting") }
  ),
  post("prodft_support_premium", `/v1/products/${ref("prod_support")}/features`, {
    entitlement_feature: ref("feat_premium_support"),
  }),
  // The same feature on a second product. Two rows sharing one
  // `externalFeatureId`, which is the case that would have been a join row if a
  // Feature table existed — and the case that breaks if anything keys a row on
  // the feature id instead of the attachment id.
  post(
    "prodft_integrations_api",
    `/v1/products/${ref("prod_integrations")}/features`,
    { entitlement_feature: ref("feat_api_access") }
  ),
  // `prod_seats` gets none, which is not an omission: it is the empty-page case,
  // and the only fixture that proves the fan-out tolerates a product with
  // nothing attached rather than throwing or skipping the rest.
];

// --- A card, so one subscription bills automatically -----------------------

const payment = [
  post("pm_acme", "/v1/payment_methods", {
    type: "card",
    card: { token: "tok_visa" },
  }),
  post("pm_acme_attach", `/v1/payment_methods/${ref("pm_acme")}/attach`, {
    customer: ref("cus_acme"),
  }),
  post("cus_acme_default_pm", `/v1/customers/${ref("cus_acme")}`, {
    invoice_settings: { default_payment_method: ref("pm_acme") },
  }),
];

// --- Agreements: subscriptions --------------------------------------------

const subscriptions = [
  // Charges a card automatically: the other collection_method, and the only
  // subscription here whose first invoice is actually paid.
  post("sub_acme_platform", "/v1/subscriptions", {
    customer: ref("cus_acme"),
    items: [{ price: ref("price_platform_monthly") }],
    metadata: { contract_ref: "ACME-2026-01" },
  }),
  // Three priced lines on one subscription, only the first of which is linked.
  // The fixture that must produce a warning rather than a tidy-looking row
  // billing $49 when the customer is actually paying $86.50.
  post("sub_northwind_multi", "/v1/subscriptions", {
    customer: ref("cus_northwind"),
    items: [
      { price: ref("price_platform_monthly") },
      { price: ref("price_seats_monthly"), quantity: 25 },
      { price: ref("price_integrations_monthly") },
    ],
    ...invoiced,
  }),
  post("sub_dutchman_trial", "/v1/subscriptions", {
    customer: ref("cus_dutchman"),
    items: [{ price: ref("price_platform_monthly") }],
    trial_period_days: 14,
  }),
  // No nickname on an annual price: "$490/year".
  post("sub_ridgeline_annual", "/v1/subscriptions", {
    customer: ref("cus_ridgeline"),
    items: [{ price: ref("price_platform_annual") }],
    ...invoiced,
  }),
  // active *and* cancelling: one column value, two opposite commercial facts.
  post("sub_halcyon_cancelling", "/v1/subscriptions", {
    customer: ref("cus_halcyon"),
    items: [{ price: ref("price_platform_monthly") }],
    cancel_at_period_end: true,
    ...invoiced,
  }),
  // Canceled by the delete at the end of this list. Absent from
  // /v1/subscriptions unless the handler asks for status=all, which is the
  // entire reason that parameter is there.
  post("sub_tessellate_canceled", "/v1/subscriptions", {
    customer: ref("cus_tessellate"),
    items: [{ price: ref("price_support_quarterly") }],
    ...invoiced,
  }),
  // First payment never completed: Stripe says `incomplete`, we say `draft`.
  post("sub_unicode_incomplete", "/v1/subscriptions", {
    customer: ref("cus_unicode"),
    items: [{ price: ref("price_platform_monthly") }],
    payment_behavior: "default_incomplete",
  }),
  // Belongs to a customer our writer rejects for having no name, so the
  // agreement lands with externalCustomerId set and customerId null - the
  // unresolved-customer count on /agreements, reachable from a fixture.
  post("sub_email_only_orphan", "/v1/subscriptions", {
    customer: ref("cus_email_only"),
    items: [{ price: ref("price_seats_monthly") }],
    ...invoiced,
  }),
  post("sub_consumer_jpy", "/v1/subscriptions", {
    customer: ref("cus_consumer_email"),
    items: [{ price: ref("price_platform_jpy") }],
    ...invoiced,
  }),
  post("sub_long_name_gbp", "/v1/subscriptions", {
    customer: ref("cus_long_name"),
    items: [{ price: ref("price_platform_gbp") }],
    ...invoiced,
  }),
  // Tiered price, no nickname, no unit_amount: the agreement name falls all
  // the way through to the subscription id.
  post("sub_shared_tiered", "/v1/subscriptions", {
    customer: ref("cus_shared_email"),
    items: [{ price: ref("price_seats_tiered"), quantity: 5 }],
    ...invoiced,
  }),
  remove(
    "sub_tessellate_cancel",
    `/v1/subscriptions/${ref("sub_tessellate_canceled")}`
  ),
];

// Order is execution order for `stripe fixtures`, and two dependencies make it
// load-bearing: a price names a product, and an attachment names both a product
// and a feature. Catalog first, therefore, with the attachments after the
// features they reference.
const added = [
  ...products,
  ...prices,
  ...features,
  ...attachments,
  ...payment,
  ...subscriptions,
];
const addedNames = new Set(added.map((fixture) => fixture.name));

// Drop any previously generated block, so this is a rewrite and not an append.
const kept = doc.fixtures.filter((fixture) => !addedNames.has(fixture.name));

// Inserted *before* the deliberately-bad customer rather than appended, so it
// stays last and everything above it is created before Stripe gets a chance to
// reject it - the invariant converging-fixtures.test.ts pins.
const badIndex = kept.findIndex(
  (fixture) => fixture.name === "cus_no_name_no_email"
);
if (badIndex === -1) {
  throw new Error("cus_no_name_no_email is missing; refusing to guess where to splice");
}

kept.splice(badIndex, 0, ...added);
doc.fixtures = kept;

writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `${added.length} fixtures spliced at index ${badIndex}; ${doc.fixtures.length} total`
);
