# Integration Platform — function-scoped OAuth with a field mapping layer

Connect external business systems (CRM, billing, usage, support, communication)
by OAuth, and decide how their fields land in your own schema.

The distinguishing idea: **an integration declares which _functions_ it serves,
and that declaration determines the OAuth scopes requested.** You pick the
functions first, then the provider, then authorize — so the consent screen asks
for exactly the permissions those functions need and nothing more.

An integration serves a **set** of functions, not one. A single HubSpot
connection supplies identity from companies and contacts *and* support from
tickets; the scopes requested are the union across the selected set, resolved
before consent.

Currently implemented: the **identity** function on **HubSpot**, **Salesforce**,
**Metrifox**, **Stripe**, **Chargebee**, **Stigg**, and a built-in **mock
provider** so the whole thing runs with no credentials — plus **catalog**
(products, the offerings that price them, prices, and the features each
offering carries), **agreement** (subscriptions, their lines, the entitlements
they confer and the discounts on them on **Stripe**, **Chargebee** and
**Stigg**; deals and their line items on **HubSpot**), and **billing**
(invoices, their lines and the payments against them) on **Stripe** and
**Chargebee**.

The four functions are independent by design, and that independence is
observable: catalog needs no customer, identity needs no price, and an agreement
references both but syncs without either — keeping the row, retaining the
provider's ids, and linking itself once the other functions are connected.

Providers come in two credential kinds. HubSpot, Salesforce and the mock are
OAuth 2.0 authorization-code. Metrifox, Stripe and Chargebee authenticate with a
static API key — no authorization server, no consent screen, no refresh — so
`ProviderDefinition` carries a discriminated `auth` union rather than assuming
every provider has a token endpoint. The three are not the same shape either:
Metrifox uses an `x-api-key` header, Stripe uses `Authorization: Bearer` plus a
pinned API version, and Chargebee uses HTTP Basic with the site name as the
username, from a pasted `site:api_key` pair. All three are absorbed by one hook
on the session options, so nothing downstream branches on a provider name.

---

## Run it

Needs a Postgres server. Any one will do — a local install, Supabase, or Neon —
and there is no SQLite fallback on purpose; see [Deploying](#the-database) for
why one engine everywhere is worth the server.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL, DIRECT_URL,
                              # TEST_DATABASE_URL, TOKEN_ENCRYPTION_KEY
                              # and AUTH_SECRET
psql -U postgres -c "CREATE DATABASE integration_demo"
npx prisma db push
npm run seed
npm run dev
```

`DIRECT_URL` is required even against a local server with no pooler — Prisma
reads it while parsing the schema, so an unset value fails `prisma generate`
outright. Point it at the same place as `DATABASE_URL`.

Open <http://localhost:3000> and sign in. `npm run seed` prints the demo
account's password, or set `DEMO_USER_PASSWORD` before running it to choose one.

With `ENABLE_MOCK_PROVIDER=true` you can then walk the entire flow — function →
provider → OAuth → mapping → synced data — without any provider credentials.

Generate both secrets with:

```bash
npx auth secret   # AUTH_SECRET, written straight into .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY
```

There is deliberately no fallback key. A dev default that silently becomes a
production default is how token encryption turns into decoration, so the app
refuses to start without a real one.

---

## The credential-free walkthrough

1. **New integration** → select **Identity**. Selecting **Billing** now offers
   Stripe and Chargebee, while **Usage** and **Support** are still honestly
   empty — functions with no provider support are represented rather than
   hidden.
2. Pick **Mock CRM**. On the consent screen, confirm the scopes shown are
   exactly the identity scopes — no `billing.invoices.read`, no ticket scopes.
   This is the core feature made visible.
3. Authorize. The mapping editor is pre-filled with suggested defaults, so the
   integration can sync immediately.
4. **Sync now** on the detail page → 11 customers and 22 contacts appear under
   **Synced data**.
5. The run reports `partial` with two issues: one contact rejected for a
   malformed email, one kept with an unresolved company link. Both are
   deliberate fixtures.
6. Re-run the sync and confirm the counts do not double — records upsert on
   `(integrationId, externalSourceId)`.
7. Change a mapping (try removing `domainFromUrl` from `customer.domain`) and
   re-sync to watch the stored values change.

### The Metrifox walkthrough — the API-key path

Set both of these in `.env`, then restart:

```
ENABLE_METRIFOX_FAKE="true"
METRIFOX_API_BASE="http://localhost:3000/api/fake/metrifox"
METRIFOX_PAGE_SIZE="3"
```

The fake is served over real HTTP from a route in this app, so the real client
runs unchanged — real headers, real pagination, real status codes, the real
failure policy.

1. **New integration** → **Identity** → **Metrifox**. It is offered even with no
   credentials in `.env`, tagged `API key`, because its credential arrives per
   integration rather than per deployment.
2. Step 3 reads *"Data this integration will read"*, not *"Permissions that will
   be requested"* — an API key has no consent step to narrow, so claiming
   otherwise would overstate the guarantee.
3. Create it. You land on a paste box rather than a redirect. Try
   `sk_test_abcd1234_denied` first (the fake returns 401 — the key is never
   stored), then `sk_test_abcd12345678`. Note what the failure does *not* do:
   check the integrations list after the rejection and it is unchanged. Nothing
   is created until a key is accepted, so a bad paste leaves nothing to delete —
   and the paste box keeps your provider and function choices for the retry.
4. **Sync now** → 9 customers and 11 contacts. The run reports `partial` with
   three deliberate rejections: a customer with a blank name, a contact with a
   malformed email, and a contact with no name at all.
5. Look at the Contacts tab. Metrifox has no contacts endpoint — these are
   flattened out of each customer's nested `contact_people[]` and given a
   synthesized id. Two of Acme's people share the mailbox `ap@acme.example`, and
   both survive: the second gets a `#1` suffix rather than overwriting the first.
6. Re-sync and confirm the counts do not move. That is the property that matters
   most here: `Contact` is unique on `(integrationId, externalSourceId)`, so an
   unstable synthesized id would not error — it would quietly duplicate every
   contact and orphan the old rows.

### The Stripe walkthrough — a real API, no account required

Metrifox is demonstrated against a fake served from inside this app. Stripe is
demonstrated against **Stripe itself**, because its CLI will provision a
throwaway sandbox and seed it:

```bash
stripe sandbox create --from-git --non-interactive   # prints a secret_key; expires in 7 days
stripe fixtures scripts/stripe-sandbox-fixtures.json
stripe customers list --limit 3                      # confirm the data landed
```

Then set `STRIPE_PAGE_SIZE="3"` in `.env` and restart, so the thirteen seeded
customers span five pages with a ragged last one.

The fixtures are chosen the way the Metrifox ones are — **the awkward records are
the point**, so the per-record issue reporting has something honest to report:

| Fixture | What it is there to do |
| --- | --- |
| `cus_no_name_no_email` | Rejected for a missing name, with no contact synthesized |
| `cus_email_only` | No name, so the **customer** is rejected too — but its contact survives, named from the email's local part, and is kept with an unresolved customer link |
| `cus_shared_email` | Shares `billing@acme.example` with `cus_acme`. Two contacts, no collision and no `#1` suffix — the contrast with Metrifox, whose ids key on the mailbox |
| `cus_no_email` | A contact with a name and no address |
| `cus_consumer_email` | Why `email` is not a default source for `customer.domain` |
| `cus_long_name` | Exactly 256 characters — Stripe's own maximum for `name`, and one over our 255-char column, so exactly one character is truncated |
| `cus_unicode` | Non-ASCII name and address |

The deliberately-bad record is seeded **last**, so if Stripe ever starts
rejecting it at creation time the rest of the fixture run has already succeeded.

> Two limits of the source API are worth knowing, because both bound what a
> fixture can demonstrate at all:
>
> - **Stripe normalizes `name: "   "` to `null`** on create, so there is no
>   whitespace-only-name fixture — it would be an exact duplicate of
>   `cus_no_name_no_email`. The handler's trim guard still exists, because a
>   provider *can* send whitespace, and is covered in
>   `tests/unit/stripe-ids.test.ts` instead.
> - **Stripe caps `name` at 256 characters**, one more than our 255-char column.
>   So truncation against this provider is real but can only ever lose a single
>   character; a Stripe customer name cannot arrive long enough to lose more.

1. **New integration** → **Identity** → **Stripe**. Offered with no credentials
   in `.env` and tagged `API key`, for the same reason Metrifox is.
2. Step 3 lists exactly one thing this integration reads: `customers:read`. Not
   `contacts:read` — the contrast with Metrifox is deliberate. Metrifox really
   does read contact data, nested inside each customer. Stripe has no contact
   resource at all, so claiming to read one would be claiming to read something
   that does not exist.
3. Create it. Try a **publishable** key (`pk_test_…`) first: it is refused
   locally, with no network call, because a publishable key cannot authenticate
   any request. Then try a bogus `sk_test_…`: Stripe answers 401 and the key is
   not stored. Then paste the sandbox key.
4. **Sync now** → a `partial` run: 11 of the 13 customers written, 2 rejected for
   a missing name, and 12 contacts — one of which keeps an unresolved customer
   link, because the customer it belongs to was one of the rejected pair. That
   last outcome is worth sitting with: our `customer.name` is required and Stripe
   supplied none, so a checkout signup that only ever gave an email cannot land
   as a customer. Metrifox behaves the same way for the same reason.
5. Look at the Contacts tab. Stripe has no contacts — each of these is
   *constructed* from its customer's own `name`, `email` and `phone`, with the id
   `cus_…:contact`. Unlike Metrifox's email-derived contact ids, that slot is
   constant: there is exactly one contact per Stripe customer, so nothing needs
   disambiguating, and an id derived from the email would re-key the row the
   first time someone corrects an address.
6. Check the **Create date** column is populated. That is not free: Stripe sends
   `created` as Unix epoch seconds, which the record writer's date parse reads as
   an invalid date and stores as null. The handler synthesizes an ISO `created_at`
   alongside it, and the mapping editor offers the raw `created` too — labelled,
   rather than hidden, so a user reaching for the field Stripe's own docs name
   has been warned instead of getting a silently empty column.
7. Re-sync and confirm the counts do not move.

#### Catalog and agreements — the products, prices, features and subscriptions

The same fixture file seeds four products, ten prices, four entitlement
features with four attachments, and eleven subscriptions.
They are generated rather than hand-written, because every subscription has to
reference a price created earlier in the same run and a mistyped `${…:id}`
placeholder only shows up halfway through seeding a sandbox:

```bash
npm run fixtures:gen      # rewrites the catalog/agreement block in the fixture file
stripe fixtures scripts/stripe-sandbox-fixtures.json
npm run fixtures:verify   # runs the real handlers against the sandbox
```

`fixtures:verify` is the one worth knowing about. Each fixture below exists to
drive a *specific* branch, and nothing in the test suite can tell whether it
still does — retune one price and the branch it covered goes quiet. So the
verifier runs the real catalog and agreement handlers against the seeded
sandbox and reports each branch by name. It reads no database and writes
nothing, and it refuses to run against a key without `_test_` in it.

| Fixture | What it is there to do |
| --- | --- |
| `price_platform_monthly` | The only nicknamed price — the agreement takes its name from a human's word for it rather than from the money |
| `price_platform_annual` | No nickname, so the name is synthesized: `$490/year` |
| `price_support_quarterly` | `interval_count: 3`, the pluralized branch: `$300/3 months` |
| `price_platform_gbp` | Non-USD, so the symbol comes from `Intl` and not a hardcoded `$` |
| `price_platform_jpy` | A **zero-decimal** currency. 5000 minor units is ¥5,000, not ¥50.00 — the one case `formatMoney`'s exponent lookup exists for, and the one that reads plausibly while being 100× wrong |
| `price_seats_tiered` | Tiered, so `unit_amount` is null and there is no single amount to format. Drives both names to `Custom pricing/month` |
| `price_platform_legacy` | Archived immediately after creation, so the catalog has an inactive offering to render |
| `feat_api_access` | Attached to **two** products, so one definition reaches us twice and must land on one `Feature` row — while the two attachments are two `Entitlement` rows. The case that breaks if anything keys the link on the feature id instead of the attachment id |
| `feat_advanced_reporting` | Lookup key `reporting-v2`, deliberately not a slug of its name — the two columns are independent, and deriving one from the other would pass every test where they happen to agree |
| `feat_unattached` | Attached to nothing. Must appear **nowhere** in our data: definitions are read off attachments, so a feature with no product has no attachment to travel with. This is what makes that a checked claim rather than a remembered one |
| `prod_seats` (no attachment) | The empty-page case — the only fixture proving the per-product fan-out tolerates a product with nothing attached |
| `sub_acme_platform` | The only subscription that bills a card, so `collection_method` is not constant |
| `sub_northwind_multi` | **Four priced lines on one subscription.** Only the first is linked, so this must produce a warning rather than a tidy row reading `$49/month` for a customer paying considerably more |
| `sub_dutchman_trial` | `trialing`, with a trial end date — a state with a deadline attached |
| `sub_halcyon_cancelling` | `active` **and** cancelling at period end: one column value, two opposite commercial facts |
| `sub_tessellate_canceled` | Created then canceled. **Absent from `/v1/subscriptions` unless the handler asks for `status=all`** — the churn check |
| `sub_unicode_incomplete` | Stripe's `incomplete`, which we store as `draft`, with `raw_status` keeping Stripe's own word |
| `sub_email_only_orphan` | Belongs to `cus_email_only`, which our writer rejects for having no name — so the agreement lands with `externalCustomerId` set and `customerId` null, and the unresolved-customer count on `/agreements` is reachable from a fixture |

Then, continuing the walkthrough with **Catalog** and **Agreement** added to the
integration:

1. `/integrations/[id]/mapping?function=agreement` shows **five** sections —
   Agreement, Subscription, Agreement item, Agreement entitlement and Agreement
   discount — and no Customer, Contact, Product or Offering. Five tables, because
   the mapping layer addresses one table per target object.
2. **Sync now** → the run reports `{ agreement: 11, subscription: 11 }` and a
   `partial` status. The warnings are the point: one subscription carries four
   priced lines, and one names a customer that was rejected.
3. `/agreements` — status and effective date from the parent row, period and
   trial dates from the joined child, and unresolved-customer and unresolved-
   offering counts reported separately, plus a multi-item disclosure per row.
4. Confirm `$300/3 months` shows as `canceled` rather than missing. That row is
   the whole reason the handler sends `status=all`; without it a subscription
   canceled at Stripe stays `active` here forever, because this system has no
   absence detection to notice a row that stopped arriving.
5. Confirm the **Renews** column is populated. Not free either, and for a
   subtler reason than the epoch dates one function over: Stripe **moved
   `current_period_end` off the subscription and onto each subscription item**.
   Reading only the old location leaves the column null on every row, the sort
   order meaningless and the index unused, with nothing raising an error —
   a subscription may legitimately have no period. `periodBoundary` reads
   whichever location the account's API version uses.
6. Re-sync and confirm the counts do not move.

And for the catalog, which rides along on the same sync:

1. `/integrations/[id]/mapping?function=catalog` shows **five** sections —
   Product, Offering, Price, **Feature** and **Entitlement** — and no Customer
   or Agreement.
2. **Sync now** → the run reports `{ product: 4, offering: 4, price: 10,
   feature: 3, entitlement: 4 }`.

   Four offerings for four products, because Stripe has no separate item object:
   each product *is* what gets sold, so it is written once as a Product and once
   as the Offering its prices and entitlements attach to, under two ids that are
   equal by construction.

   Three features for four definitions: `feat_unattached` belongs to no product,
   so nothing reads it. Four entitlements for four attachments — the link is
   emitted per attachment even when the definition behind it was already seen.
3. `/catalog` → **Features**. Platform lists two, Premium Support one,
   Integrations one, Additional Seats none — and `beta-sandbox` appears nowhere.

   `api-access` appears **once**, with two offerings listed beside it, even
   though Stripe sent it attached to two products. That is the difference between
   the definition table and the denormalized attachment it replaced: grouping
   happens once, at read time, keyed on `(integrationId, lookupKey ?? id)`.
4. Re-sync and confirm the same rows, not eight.
5. Detach a feature in Stripe and re-sync. **The rows persist**, and that is the
   known gap rather than a bug: the entitlement pass is upsert-only with no
   absence detection, so a detached feature stays until the integration is
   deleted. It is the same limitation `status=all` works around for
   subscriptions, and there is no equivalent parameter here.

> **An integration connected before this existed syncs no features or
> entitlements**, and does so without making a single extra request. Stored
> mapping rules are not rewritten by a deploy, so nothing points at the new
> objects — and rather than fetch rows the writer would reject for a missing
> name, the handler checks `requestedSourcePaths` and skips the pass entirely.
> Press **Reset to suggested** in the mapping editor to pick up the shipped
> defaults.
>
> This is not the only place a mapping decides whether a request is made:
> Stripe's billing handler gates its invoice, line and payment passes on
> `requestedSourcePaths`, Chargebee's agreement handler gates its entitlement
> and discount passes, and this catalog handler gates the per-product feature
> fan-out. But the fan-out is where it earns its keep, because features cost
> *one request per product* where products and prices cost two requests total.

> **Two statuses no fixture can reach.** `past_due` and `paused` both need time
> to pass — a renewal that fails dunning, or a trial that ends with no payment
> method — so they need a [test clock](https://docs.stripe.com/billing/testing/test-clocks)
> rather than a create call. The status *map* covers them in
> `tests/unit/stripe-agreement.test.ts`; what the sandbox does not demonstrate
> is Stripe actually producing them.

### The billing walkthrough — invoices, lines and payments

Same Stripe sandbox, same key, **Billing** added to the integration. There are
no invoice fixtures: Stripe raises the first invoices itself when a subscription
is created, so this walkthrough reads what the provider produced rather than
what we seeded.

1. `/integrations/[id]/mapping?function=billing` shows **three** sections —
   Invoice, Invoice line and Payment.
2. **Sync now** → the run reports `{ invoice: n, invoiceLine: n, payment: n }`.
   `n` is whatever the sandbox actually holds, which is the point: the totals on
   an invoice are **stated by the provider, never computed**, so our numbers
   should agree with Stripe's dashboard to the cent without either side summing
   anything.
3. `/billing` → the invoices your customers were sent, each expandable into its
   lines and the payments against it. Payments carry a `kind`, so a refund reads
   as money moving backwards rather than as a negative invoice.
4. Note what is *missing*. `sub_acme_platform` bills a card, so its
   authorization is settled and written; the `send_invoice` subscriptions have an
   authorization that never became a movement, and **no row is written for it at
   all**. So this table's counts will not match Stripe's transaction count —
   correct and intended, and the reason `Invoice.amountPaidMinor` is stored
   rather than summed from `Payment`.
5. Re-sync and confirm the counts do not move. Invoice lines are the one
   reconciled object on this function: a line the invoice no longer has is
   deleted, behind two gates, because a line list truncated by a page bound looks
   exactly like a shorter invoice.

### The identity walkthrough — one company out of three rows

The other walkthroughs each end at "the records landed". This one is about
what happens *across* them: one real company connected through three systems is
three unrelated `Customer` rows until something resolves them onto one account.

Connect the mock provider, Metrifox and Stripe, sync each, then open
**Customers → Accounts**.

| Company | How the three rows find each other |
| --- | --- |
| **Ridgeline Utilities** | Metrifox meets Stripe on a shared billing **email**; it meets the CRM on a shared **domain**. Stripe has no website field at all, which is why email is a key kind and not just domain |
| **Halcyon Foods** | The CRM has no account-level address, so the join runs through one of its **contacts** — the universal route, since every provider that maps `contact.email` makes it reachable |
| **Tessellate Labs** | Different name, different domain, different address in Stripe. **No email or domain key can reach it.** Only the crosswalk can — see below |

Things worth looking at while you are there:

- Each field carries a **provider chip** naming the connection that supplied it.
  Stripe wins the email, the CRM wins the industry, and neither erases the
  other: a field is contested only among the sources that actually carry a
  value, so a null never wins.
- Ridgeline is named differently by all three at equal priority, so the account
  reports a **field conflict** rather than presenting an arbitrary pick as a
  decision. Set a **Source priority** on one integration (its detail page) and
  the resolved values follow it — while the grouping does not move at all. That
  separation is the safety property the whole design rests on.
- Ridgeline's **Created** date is the earliest of the three, not the
  highest-priority one. If the CRM saw the company in 2021 and Stripe in 2023,
  it existed in 2021.
- **“Not this company”** and **“Same company as…”** record a human verdict that
  every later pass honours. They are the only inputs the resolver will never
  revise on its own, which is also why each one is listed with an undo.

#### The crosswalk — Tessellate, and `payments_stripe_customers`

The spec calls Metrifox's `payments_stripe_customers` the join that makes one
`customer_account_id` possible, and **no Metrifox endpoint exposes it**. So
there are two supply routes, both on the integration's detail page:

```bash
stripe customers list --limit 20   # find the id of "Tessellate Labs (UK)"
```

- **Mapped field.** Set `METRIFOX_FAKE_STRIPE_IDS="TESSELLATE-010=cus_…"` and
  restart. The fake then serves that id on the fixture, the default
  `stripe_customer_id → crossRef.stripe` mapping picks it up, and the next
  resolution joins the two. (The value cannot be a fixture: Stripe assigns
  `cus_…` at creation time.)
- **Imported crosswalk.** Or paste `TESSELLATE-010,cus_…` into **Import a
  crosswalk** on the Metrifox integration, which is the honest answer for a
  table no API serves. Both ends are asked for rather than guessed — a wrong
  guess would join two unrelated companies using the strongest evidence the
  matcher has.

Either way the account then shows two members with no address in common, which
is the whole point of the `external_ref` key kind.

> Already-connected integrations keep the mappings they were seeded with —
> `seedMappingsIfEmpty` bails when any rule exists — so neither the
> `crossRef.stripe` default nor the account-email one reaches a connection made
> before they shipped. `npm run mappings:retarget` is the migration for both;
> see [Migrating existing connections](#migrating-existing-connections).

### With real credentials

**HubSpot** — create a developer app, set the redirect URI to
`http://localhost:3000/api/oauth/hubspot/callback`, set `HUBSPOT_CLIENT_ID` and
`HUBSPOT_CLIENT_SECRET`.

**Salesforce** — a Developer Edition org, Connected App with the same callback
shape. Set `SALESFORCE_LOGIN_HOST=test.salesforce.com` for sandboxes.

**Metrifox** — no app to register and no redirect URI. Create a key in the
Metrifox dashboard under Developers → API Keys, unset `ENABLE_METRIFOX_FAKE`,
and paste the key when the integration asks for it. It is checked against the
live API before it is saved, and encrypted at rest by the same AES-256-GCM path
as an OAuth token.

**Stripe** — no app to register and no redirect URI either. Use a secret key
(`sk_…`) or, better, a restricted key (`rk_…`) with only the read access your
selected functions need, from Developers → API keys, and paste it when the
integration asks. A sandbox key from `stripe sandbox create` works identically —
the code cannot tell the difference, which is the point of the sandbox.

**Chargebee** — also no app to register and no redirect URI. Create a
**read-only** API key under Settings → Configure Chargebee → API Keys, and paste
it as `site:api_key` (for example `my-site-test:chb_123456789`). The site name
is not decoration: Chargebee's API is served from `https://{site}.chargebee.com`,
so it is half the credential and half the base URL. It is checked against
`/api/v2/customers` before it is saved, and the site it resolves to is stored as
tenant scope — which is also what stops one site's customer ids from matching
another's in identity resolution.

> The same caveat applies to all three: the key belongs to your account, so
> deleting the integration removes our copy but does not invalidate it. Rotate it
> in the provider's own dashboard if you want it dead. Nothing here can tell a
> test key from a live one, so which environment a key reaches is not something
> this platform determines or enforces.

---

## How it works

For a map of the codebase itself — the layer diagram, the connect/sync/retry
flows, and where to look to change any given thing — see
[`docs/architecture.md`](docs/architecture.md).

### Scope resolution

The heart of the feature is one pure function:

```ts
resolveScopes(functionNames: string[], providerName: string): string[]
```

It returns the union of `scopesByProvider.get(provider)` across the selected
functions. Scopes are held per **(function, provider)** pair, which is what lets
two providers differ instructively: HubSpot's scopes are granular, so adding
`support` genuinely widens the request; Salesforce's `api` scope already spans
Case, so its set is unchanged.

Adding a function to a live integration widens its requirement past what the
user consented to. `OAuthToken.grantedScopes` records what was actually granted,
so the mismatch surfaces as an explicit reconnect prompt rather than an opaque
mid-sync 403.

### Field mapping

Target paths are **object-qualified** — `customer.name`, `contact.email`,
`customer.customFields.<key>`. A flat namespace would let a contact field be
mapped onto a customer record and validate cleanly.

[`src/core/object-schema.ts`](src/core/object-schema.ts) is the single source of
truth, read by the validator, the mapping UI's target dropdown, and the sync
engine's record validation — so they cannot drift. It composes the per-object
definitions in `identity-schema.ts`, `catalog-schema.ts`,
`agreement-schema.ts` and `billing-schema.ts`.
`contact.associatedCustomerId` is marked read-only and never offered as a
target: it is derived by the sync engine, not user-mapped.

It also records **which function owns which object, and in what order** — which
is the other half of the guarantee. Without the ownership, a `catalog` rule set
could contain customer rules, validate cleanly, save, and then write nothing on
every sync; a mapping that silently does nothing is considerably worse than one
that is refused. The order is load-bearing for the same reason: a price resolves
its offering through an index built while offerings are written, and an invoice
line resolves its invoice the same way.

Source options come from the provider's own schema API (HubSpot's
`/crm/v3/properties/*`, Salesforce's `describe`), cached in `DiscoveredField`.
Free-text entry stays available, because a dropdown that cannot express a valid
mapping is worse than one with an escape hatch.

Transforms: `none | trim | lowercase | domainFromUrl | dateOnly`.
`domainFromUrl` is load-bearing — Salesforce's `Account.Website` is a full URL
and our target is a bare domain.

### Sync

One run at a time per integration, and **one function at a time within it**.
`functionsInWriteOrder` sorts the declared functions as `identity → catalog →
agreement → billing`, and each function's own objects are written parents-first:

| Function | Objects, in write order |
|---|---|
| `identity` | `customer`, `contact` |
| `catalog` | `product`, `offering`, `price`, `feature`, `entitlement` |
| `agreement` | `agreement`, `subscription`, `agreementItem`, `agreementEntitlement`, `agreementDiscount` |
| `billing` | `invoice`, `invoiceLine`, `payment` |

That ordering is not incidental:

> Providers return their **own** id for a parent — HubSpot via an associations
> block, Salesforce as `AccountId`, Stripe as a product id on a price — never our
> internal UUID. Writing that straight into a foreign key produces a dangling
> reference. So parents go first, building an `external → internal` index, and
> children resolve through it, falling back to a database lookup for parents
> written by earlier runs.

Ordering the *functions* is newer and equally load-bearing. An agreement
references a customer from `identity` and an offering from `catalog`, so running
it first leaves both links dangling until the next sync. Billing sits last for
the same reason one level up: an invoice resolves all three.

A child whose parent cannot be resolved is **kept** with a null link and a
warning, not rejected — `externalCustomerId` is retained so a later sync links it
automatically. Two children are exceptions, both because their foreign key is
required and rejecting: an `agreementItem`, an `agreementEntitlement`, an
`agreementDiscount` and an `invoiceLine` all come off one provider record as one
payload, so a missing parent can only mean the parent was itself refused. A
`payment` is the other way — `SetNull`, because a refund has no invoice to begin
with.

Per-record failures never abort a run. A run that wrote 19 of 20 records is
reported `partial`, with the reason for the twentieth visible in the UI.

### Provider HTTP failure policy

Shared by both providers, in [`src/core/providers/http.ts`](src/core/providers/http.ts):

| Status | Response |
|---|---|
| 401 | Refresh the token, retry once. A second 401 means the grant is dead → `requires_reauthorization`, stop. |
| 429 | Wait (`Retry-After` if given, else `RATE_LIMIT_FALLBACK_MS`) and retry the same request, so pagination resumes at the same cursor. Bounded at two waits before escalating. |
| 5xx | Retryable at the run level. |
| other | Fail the run; everything already written stays written. |

All timing is injected via a `Clock`, so retry schedules are asserted instantly
in tests rather than waited out.

### Scheduling

Next.js has no scheduler. `POST /api/cron/sync` runs every integration that is
due per its interval (default 24h, clamped 1–168h) and expires any integration
orphaned in `pending_authorization` for over 30 minutes. That sweep is close to
a no-op now: an integration is only created once its credential is proven, so an
abandoned connect leaves a draft that expires in memory rather than a row.
Drive it with a platform cron, or locally:

```bash
npm run worker           # polls /api/cron/sync every 60s
```

Set `CRON_SECRET` to require a bearer token; it is mandatory in production,
because otherwise the route is an unauthenticated endpoint that makes outbound
API calls on every integration in the database.

The primary demo path remains the manual **Sync now** button.

---

## Layout

```
src/core/                framework-free domain — no Next.js imports
  object-schema.ts       the composed target registry; single source of truth
  identity-schema.ts     customer + contact field definitions
  catalog-schema.ts      product + offering + price + feature + entitlement
  agreement-schema.ts    agreement, subscription, item, entitlement, discount
  billing-schema.ts      invoice + invoice line + payment field definitions
  price-format.ts        money and recurrence, formatted once for both callers
  registries/            function, provider, and handler registries
  field-mapper/          validate, apply, serialize
  identity/              cross-integration resolution — evidence, survivorship,
                         assertions, the pass; all pure but the resolver itself
  oauth/                 service, AES-256-GCM crypto, state store
  integrations/          draft store, and creating a connection from a draft
  sync/                  engine, record writer, scheduler, clock, errors
  providers/             hubspot/, salesforce/, metrifox/, stripe/, chargebee/,
                         mock/ — one each
  credentials/           API-key connect service
  repositories/          the only layer importing the Prisma client
src/auth.ts              Auth.js server config (credentials provider)
src/auth.config.ts       the edge-safe half, shared with the middleware
src/middleware.ts        default-deny authentication gate
src/lib/                 prisma client, password hashing, current-user
src/app/                 pages and API routes; /, /integrations, /customers,
                         /catalog, /agreements, /billing
tests/                   unit/, property/, integration/
```

`src/core` never imports from `src/app`. Adding a provider means adding a
directory under `core/providers/` and one registration call in
[`bootstrap.ts`](src/core/bootstrap.ts) — no orchestration code changes, as long
as it shares a credential kind with one already here. Metrifox did not: adding
the first API-key provider meant splitting `ProviderDefinition.auth` into a
union and teaching the connect flow, the session client, and the refresh path
about a credential that never expires.

Stripe was the test of that claim, and it held: six files under
`core/providers/stripe/` when it was first added (nine today, once catalog,
agreement and billing joined), two registration calls, and **no changes to any
orchestration code, route, or UI file** — even though its credential is shaped
differently from Metrifox's (`Authorization: Bearer` plus a pinned API version,
rather than an `x-api-key` header) and it pages by cursor rather than by page
number. The one thing it needed that Metrifox did not is a synthesized field:
Stripe's epoch-seconds `created` has to become an ISO string in the handler,
because no transform downstream can rescue it.

**Chargebee held it again, across three functions at once.** Nine files under
`core/providers/chargebee/` and three registration calls, with the same zero
orchestration churn — despite a third API-key shape (HTTP Basic with the site
name as the username, from a pasted `site:api_key` pair), four handlers, and a
`tenant`-scoped external id keyed on the site. It also shipped an identity
handler alongside the commercial ones, which is the first provider to do that
without the CRMs being its motivation.

The twenty-eight tables, their cascade behaviour, and the `Integration.status`
lifecycle are diagrammed in [`docs/data-model.md`](docs/data-model.md).
The layering, registries, and request flows are diagrammed in
[`docs/architecture.md`](docs/architecture.md).
Both render as Mermaid; for a zoomable, interactive version open
[`docs/diagrams/index.html`](docs/diagrams/index.html) in a browser.

---

## Tests

```bash
npm test                 # tsc --noEmit, then vitest
```

The typecheck runs **first and gates the tests**. Vitest transpiles without
typechecking, so a suite can pass green over a build that does not compile.

68 files across three suites, and the split follows the layering rather than the
subject area — `tests/unit/` is pure logic, `tests/property/` is the invariants
that are tedious to argue by example, `tests/integration/` is handlers against
mocked provider APIs plus the resolution pass against a real database.

- **Property tests** (fast-check) cover the invariants that carry real weight:
  scope isolation, provider filtering, mapping round-trip, target validation,
  absent-source-yields-null, upsert identity, pagination completeness, and —
  separately, because they are the ones most likely to break silently — identity
  resolution's **totality**, **idempotence**, **order-independence** and the
  claim that precedence never repartitions an account.
- **Integration tests** (msw) cover pagination, 429 with and without
  `Retry-After`, 401 → refresh → retry, SOQL construction, and field discovery
  against mocked HubSpot and Salesforce APIs, plus one file per commercial
  function per provider — catalog, agreement and billing for Stripe and
  Chargebee, agreement for Stigg and HubSpot deals — and the writers behind them.
- Tests that need a database run inside a dedicated Postgres schema built by
  `tests/global-setup.ts` and named by `TEST_DATABASE_URL`; the dev database
  is never touched. That schema is dropped and recreated on every run, so the
  suite refuses to start unless the URL names a schema other than `public`.
  Because Vitest runs files in parallel forks against that one schema, an
  unscoped `findFirst` in a test is a cross-test hazard rather than a style
  preference — `tests/integration/identity-helpers.ts` builds an isolated tenant
  per test for that reason.

`fixtures:verify` sits outside the suite entirely and is worth knowing about.
Each sandbox fixture exists to drive a *specific* branch, and nothing in the tests
can tell whether it still does — retune one price and the branch it covered goes
quiet. So the verifier runs the real catalog, agreement and billing handlers
against a seeded sandbox and reports each branch by name. It reads no database
and writes nothing, and it refuses to run against a key without `_test_` in it.

Property tests were checked by mutation — deliberately breaking the code to
confirm the test fails. Two survived initially and the tests were strengthened
until they didn't.

---

## Deploying

### The database

Postgres everywhere — local development, the test suite and deployment all run
the same engine, so deploying is `npm run build` and nothing else.

That uniformity is the point rather than a convenience. Prisma’s datasource
`provider` must be a literal rather than `env()`, and the generated client is
provider-specific: a client built for `postgresql` refuses a `file:` URL
outright. One schema file can therefore only ever serve one engine. An earlier
version of this repo ran SQLite locally and generated a Postgres variant of the
schema at build time to bridge the gap. It worked, but it made `npm run build`
quietly wrong for deployment, it left a developer’s generated client in
whichever mode they had last built, and it meant the schema the tests ran
against was never quite the schema production used.

Any Postgres will do — a local server, Supabase, or Neon. Nothing in the code
names a vendor.

```bash
psql -U postgres -c "CREATE DATABASE integration_demo"   # once
npm run db:push                                          # create the tables
npm run seed                                             # demo data
```

Two connection strings are needed, and both are required:

| Variable | Points at | Used by |
|---|---|---|
| `DATABASE_URL` | The pooler, in deployment | The app. Needs `?pgbouncer=true` behind a transaction pooler. |
| `DIRECT_URL` | An unpooled connection | `prisma db push` / `migrate` only. |

`DIRECT_URL` is required **even when there is no pooler anywhere**, which is
the one genuinely surprising part. Prisma resolves `env()` while *parsing* the
schema, so leaving it unset fails `prisma generate`, `prisma validate` and
`npm run build` with P1012 before anything tries to open a connection. Against
a plain local server, set it to the same value as `DATABASE_URL`.

The reason it exists at all: migrations take advisory locks and run DDL,
neither of which survives transaction-mode pooling. For the same reason,
`pgbouncer=true` on the pooled URL is not optional on Supabase or Neon —
without it Prisma issues prepared statements the pooler cannot carry across the
connections it multiplexes, and queries then fail *intermittently* rather than
outright, which is a miserable thing to debug.

Pooled and direct URLs differ by **port** on Supabase (6543 and 5432) and by
**hostname** on Neon (a `-pooler` suffix, same port). One easily missed
substring between “works” and “migrations hang”, so check it first when a push
stalls. On Supabase, prefer the session pooler host over `db.<ref>.supabase.co`
for `DIRECT_URL` — the latter resolves to IPv6 only, which many hosts and CI
runners cannot reach.

> `db:push` uses `prisma db push`, which has no migration history. That is
> fine for a demo with no data worth protecting; anything real wants
> `prisma migrate deploy` and a committed `prisma/migrations/`.

### Migrating existing connections

Two mapping defaults changed after connections already existed, and
`seedMappingsIfEmpty` can deliver neither: it returns early when an integration
has any rule at all, which is exactly what stops a reconnect from trampling a
user's edits. So the change has to be pushed rather than pulled.

```bash
npm run mappings:retarget                 # dry run — prints every change
npm run mappings:retarget -- --apply
```

| Change | Was | Is |
|---|---|---|
| The account email became a column | `customFields.email` / `customFields.primary_email` | `customer.email` |
| Metrifox gained the Stripe join | *(nothing)* | `stripe_customer_id → crossRef.stripe` |

It **rewrites** the email rule rather than adding one. `validateMappings` is
perfectly happy with the old and new targets side by side — they are different
paths, so the duplicate check never fires — and the result is the same address
written to two places on every record of every sync, with nothing failing
loudly to say so.

It also moves the addresses **already synced** into the column. Without that
the script appears to do nothing: the retargeted rule only takes effect on the
next sync, and a tenant that has stopped syncing would keep a null column
indefinitely. Nothing is deleted — a `customFields` key is dropped only once
the same address is in the column, and one that cannot be moved is left exactly
where it is and named individually in the output.

That output is also the gate on removing the legacy `customFields` fallback in
`identity/evidence.ts`: each record the script could not move is a join that
removal would cost.

Dry run by default, idempotent, and safe to re-run. The decisions are pure and
live in [`src/core/identity/mapping-retarget.ts`](src/core/identity/mapping-retarget.ts)
with tests, because a migration is the one kind of code that runs against real
data once and is then never exercised again.

### Still required before this is public

The database is the portable part. These are not:

- **Run `npm run db:push` against the deployed database after every schema
  change.** The build command is `prisma generate && next build`, which builds a
  client for the schema in the repo but never touches the database — so a new
  table exists in the generated types and not in Postgres, and the first query
  against it fails at runtime rather than at build. Point `DATABASE_URL` and
  `DIRECT_URL` at the deployment and push before the deploy goes live.
- **Set `AUTH_SECRET`** (`npx auth secret`). Auth.js signs session cookies with
  it and refuses to start without one in production. Changing it invalidates
  every live session, which is the safe direction — and note the converse, since
  it bites in development: keeping `AUTH_SECRET` while recreating the database
  leaves live cookies naming user rows that no longer exist. Sessions stay valid,
  the integration list comes back empty, and connecting fails on the
  `Integration.userId` foreign key. Log out and back in after a database reset.
- **Run `npm run seed` once** with `DEMO_USER_PASSWORD` set, or read the password
  it generates and prints. There is no registration page, so this is the only
  account until you add one.
- **Set `TOKEN_ENCRYPTION_KEY` to a freshly generated value**, and understand it
  cannot be rotated: existing ciphertext is only readable under the key that
  wrote it. The app refuses to start without it, by design.
- **Set `CRON_SECRET`.** `/api/cron/sync` already returns 503 in production
  without one.
- **Leave `ENABLE_MOCK_PROVIDER` and `ENABLE_METRIFOX_FAKE` unset.** Both are
  env-gated, but the mock OAuth routes issue tokens to anyone who asks.
- **Point `APP_BASE_URL` at the real origin** and re-register the redirect URIs
  with HubSpot and Salesforce to match.
- **Raise `SYNC_RETRY_DELAY_MS` and `RATE_LIMIT_FALLBACK_MS`.** They are lowered
  in `.env.example` so failures are observable in a demo, not because two
  seconds is a sane retry delay against a real API.
- **The sync in-flight lock is still in-process.** OAuth state and connect drafts
  moved to tables (`OAuthState`, `IntegrationDraft`) precisely so they survive a
  second instance — each is written by one request and read by another, so
  in-process they broke the moment the reader landed anywhere else. The lock in
  `sync-engine.ts` is a `globalThis` `Set` and did not move: behind more than one
  instance, two nodes can sync one integration at once. That fails safe, so it is
  a known limit rather than a blocker.
- **Not serverless without changes.** `POST /api/integrations/[id]/sync` returns
  202 and leaves the sync running after the response, which a platform that
  freezes the function on response will kill mid-run.

---

## Notable decisions

**Salesforce streams like HubSpot.** The original spec called for fetching all
pages before mapping. That buffers an entire org in memory for no benefit, so
both handlers yield pages as they arrive.

**SOQL field names are whitelisted.** Mapping rules hold source paths the user
typed, and Salesforce's REST query API has no parameter binding for field names.
A source path of `Name FROM Account WHERE Id != null--` would otherwise be a
working injection. See [`soql.ts`](src/core/providers/salesforce/soql.ts).

**A malformed email rejects a contact; an unrecognised customer type only
warns.** Email is a person's primary identifier and a broken one poisons later
matching. An org-specific picklist value that doesn't match our enum is routine
and shouldn't cost the whole record.

**Deletion proceeds even if revocation fails.** A provider outage must not
strand an integration the user asked to remove. The unconfirmed revocation is
flagged and surfaced so they can revoke from the provider's side.

---

**A discount stores stated values only, never a computed total.** There is no
net, no post-discount figure, and no amount column on the agreement to reconcile
one against. A discount is an assertion the provider made about a price, and the
moment we start computing what it comes to we own an arithmetic the provider
never agreed to. A subscription's true total is the provider's to state — which
is also why nothing here ever sums `AgreementItem` or `InvoiceLine`.

**Invoice totals are stated, never computed.** Both providers define
`amount_due` as `total − paid − credits − credit notes`, and credit notes are
out of scope, so reproducing the arithmetic would put a confidently wrong number
on the row the moment one of those moved. Nothing is ever summed from `Payment`
either, and a reader must not "fix" the redundancy by summing lines.

## Known limitations

- **One account, and no way to create a second from the UI.** Sign-in is real
  (Auth.js, credentials, scrypt-hashed), and every integration is scoped to its
  owner — but the only account is the one `npm run seed` creates. There is no
  registration page, no password reset, and no email verification. Adding a
  social login is additive: a provider in `src/auth.ts` plus
  `@auth/prisma-adapter` and its `Account` table.
- **HubSpot contact names.** HubSpot has no single name property; the suggested
  mapping uses `firstname` only. Each rule writes one source field, so surnames
  are not imported unless mapped to a custom field. The mapping page says so.
- **Custom-field mapping is per-key and manual.** No bulk "import all custom
  properties".
- **Stripe contacts are inferred, not fetched.** Stripe has no contact resource,
  so each contact is constructed from its customer's own `name`, `email` and
  `phone` — one per customer, and none at all for a customer with neither a name
  nor an email. It is the honest maximum available from that API, not a full
  contact list.
- **An under-permissioned Stripe restricted key fails the run rather than
  prompting for a new key.** A key lacking customer read access is caught at
  connect time by the credential probe, which treats 403 as a rejection. If the
  permission is revoked *after* connection, the shared HTTP client special-cases
  401 only, so the mid-run 403 surfaces as a failed sync. The remedy is a new key
  from Stripe's dashboard either way.
- **A Chargebee invoice spanning several subscriptions has no agreement link.**
  Its `line_items` can belong to more than one, so the handler leaves
  `agreementId` null and records `subscription_id: "consolidated"` in
  `providerMetadata` — the honest record of why, rather than linking the whole
  invoice to whichever subscription happened to come first.
- **`support`, `usage`, and `communication` have no handlers.** They
  are registered so the function picker shows the real roadmap and so "no
  provider supports this yet" is a reachable state. `agreement` and `billing` are
  no longer on this list: Stripe and Chargebee both ship handlers for all three
  commercial functions.
- **Salesforce declares `agreement` scopes but ships no agreement handler.**
  The scopes are there because the canonical model insists one agreement covers
  a sales-led order form and a self-serve subscription alike, and declaring a
  pair is what makes that claim checkable before the handler exists. Selecting
  Agreement on Salesforce today offers the function and then says plainly that
  no provider supports it yet. HubSpot was in the same state and now syncs deals
  and their line items; its product catalog remains unbuilt, so deal lines keep
  their provider product id without resolving to an offering.
