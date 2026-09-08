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
**Metrifox**, **Stripe**, and a built-in **mock provider** so the whole thing
runs with no credentials.

Providers come in two credential kinds. HubSpot, Salesforce and the mock are
OAuth 2.0 authorization-code. Metrifox and Stripe authenticate with a static API
key — no authorization server, no consent screen, no refresh — so
`ProviderDefinition` carries a discriminated `auth` union rather than assuming
every provider has a token endpoint. The two are not the same shape either:
Metrifox uses an `x-api-key` header, Stripe uses `Authorization: Bearer` plus a
pinned API version. Both are absorbed by one hook on the session options, so
nothing downstream branches on a provider name.

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

1. **New integration** → select **Identity**. Note that selecting **Billing**
   yields an empty provider list and blocks the flow — functions with no
   provider support are honestly represented rather than hidden.
2. Pick **Mock CRM**. On the consent screen, confirm the scopes shown are
   exactly the identity scopes — no `billing.invoices.read`, no ticket scopes.
   This is the core feature made visible.
3. Authorize. The mapping editor is pre-filled with suggested defaults, so the
   integration can sync immediately.
4. **Sync now** on the detail page → 8 customers and 19 contacts appear under
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
4. **Sync now** → 7 customers and 10 contacts. The run reports `partial` with
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

Then set `STRIPE_PAGE_SIZE="3"` in `.env` and restart, so the ten seeded
customers span four pages with a ragged last one.

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
4. **Sync now** → a `partial` run: 8 of the 10 customers written, 2 rejected for
   a missing name, and 9 contacts — one of which keeps an unresolved customer
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
(`sk_…`) or, better, a restricted key (`rk_…`) with only *Customers → read* from
Developers → API keys, and paste it when the integration asks. A sandbox key
from `stripe sandbox create` works identically — the code cannot tell the
difference, which is the point of the sandbox.

> The same caveat applies to both: the key belongs to your account, so deleting
> the integration removes our copy but does not invalidate it. Rotate it in the
> provider's own dashboard if you want it dead. Nothing here can tell a test key
> from a live one, so which environment a key reaches is not something this
> platform determines or enforces.

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

[`src/core/identity-schema.ts`](src/core/identity-schema.ts) is the single
source of truth, read by the validator, the mapping UI's target dropdown, and
the sync engine's record validation — so they cannot drift.
`contact.associatedCustomerId` is marked read-only and never offered as a
target: it is derived by the sync engine, not user-mapped.

Source options come from the provider's own schema API (HubSpot's
`/crm/v3/properties/*`, Salesforce's `describe`), cached in `DiscoveredField`.
Free-text entry stays available, because a dropdown that cannot express a valid
mapping is worse than one with an escape hatch.

Transforms: `none | trim | lowercase | domainFromUrl | dateOnly`.
`domainFromUrl` is load-bearing — Salesforce's `Account.Website` is a full URL
and our target is a bare domain.

### Sync

One run at a time per integration. Customers are written before contacts, and
that ordering is not incidental:

> Providers return their **own** company id on a contact — HubSpot via an
> associations block, Salesforce via `AccountId` — never our internal UUID.
> Writing it straight into a foreign key produces a dangling reference. So
> customers are written first, building an `external → internal` index, and
> contacts resolve through it, falling back to a database lookup for customers
> written by earlier runs.

A contact whose company cannot be resolved is **kept** with a null link and a
warning, not rejected. `externalCustomerId` is retained so a later sync links it
automatically once that company arrives.

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
  identity-schema.ts     target field definitions; single source of truth
  registries/            function, provider, and handler registries
  field-mapper/          validate, apply, serialize
  oauth/                 service, AES-256-GCM crypto, state store
  integrations/          draft store, and creating a connection from a draft
  sync/                  engine, record writer, scheduler, clock, errors
  providers/             hubspot/, salesforce/, mock/, metrifox/, stripe/ — one each
  credentials/           API-key connect service
  repositories/          the only layer importing the Prisma client
src/auth.ts              Auth.js server config (credentials provider)
src/auth.config.ts       the edge-safe half, shared with the middleware
src/middleware.ts        default-deny authentication gate
src/lib/                 prisma client, password hashing, current-user
src/app/                 pages and API routes
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
`core/providers/stripe/`, two registration calls, and **no changes to any
orchestration code, route, or UI file** — even though its credential is shaped
differently from Metrifox's (`Authorization: Bearer` plus a pinned API version,
rather than an `x-api-key` header) and it pages by cursor rather than by page
number. The one thing it needed that Metrifox did not is a synthesized field:
Stripe's epoch-seconds `created` has to become an ISO string in the handler,
because no transform downstream can rescue it.

The nine tables, their cascade behaviour, and the `Integration.status`
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

- **Property tests** (fast-check) cover the seven invariants that carry real
  weight: scope isolation, provider filtering, mapping round-trip, target
  validation, absent-source-yields-null, upsert identity, pagination
  completeness.
- **Integration tests** (msw) cover pagination, 429 with and without
  `Retry-After`, 401 → refresh → retry, SOQL construction, and field discovery
  against mocked HubSpot and Salesforce APIs.
- Tests that need a database run inside a dedicated Postgres schema built by
  `tests/global-setup.ts` and named by `TEST_DATABASE_URL`; the dev database
  is never touched. That schema is dropped and recreated on every run, so the
  suite refuses to start unless the URL names a schema other than `public`.

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

### Still required before this is public

The database is the portable part. These are not:

- **Set `AUTH_SECRET`** (`npx auth secret`). Auth.js signs session cookies with
  it and refuses to start without one in production. Changing it invalidates
  every live session, which is the safe direction.
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
- **Single instance only.** The OAuth state store, the connect draft store and
  the sync in-flight lock are all in-process `globalThis` maps. Behind more than
  one instance, callbacks fail state validation, drafts vanish mid-connect, and
  two nodes can sync one integration at once.
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
- **`support`, `billing`, `usage`, and `communication` have no handlers.** They
  are registered so the function picker shows the real roadmap and so "no
  provider supports this yet" is a reachable state.
