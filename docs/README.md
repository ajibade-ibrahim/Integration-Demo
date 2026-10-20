# Documentation

This folder explains the Integration Platform in everyday language. You do not
need a technical background to follow it.

Start here. This page covers **what the platform does**, **which systems it can
connect to**, and **the words used in these documents**. The other documents go
deeper:

| Document | Answers |
|---|---|
| [`architecture.md`](./architecture.md) | **How it works** — what happens when you connect a system, choose what to bring in, and refresh the data. |
| [`data-model.md`](./data-model.md) | **What it stores** — the information kept behind the scenes, described group by group. |
| [`revenue-graph.md`](./revenue-graph.md) | **Where this is headed** — the revenue-graph framework mapped onto what this platform already builds, with the gaps named. |
| [`diagrams/index.html`](./diagrams/index.html) | **How it looks** — interactive, clickable diagrams of the architecture, the revenue graph and all 28 stored tables, with zoom, pan and a working permissions picker. |

---

## What this platform does

Every business runs on several other people's systems: a place where sales
tracks companies (a CRM), a system that bills customers, a system that measures
usage, and so on. Each one holds a slightly different picture of the same
customer, in its own format.

This platform is the middle layer. You connect it to those systems once, decide
which information you want from each, and it keeps a clean, combined copy in one
database that you control. Think of it as a universal adapter: each system gets
its own plug, and you choose which jobs each plug should do.

Two things make it more than a copy machine:

1. **You decide what an integration is *for* before you connect it.** You pick
   purposes ("companies and contacts", "invoices", "subscriptions"), and the
   platform asks the system for exactly the permissions those purposes need —
   nothing more. This is the idea the whole product is built around.
2. **It can tell when different systems are talking about the same company.**
   One business seen through three systems becomes three records. The platform
   recognizes them as one company and shows them as one — while keeping the
   original records untouched.

## The idea that shapes everything

> **You choose purposes first. The permissions requested follow from that choice.**

- A **purpose** is a kind of data and the job of keeping it up to date. The
  platform currently defines seven: *Identity, Catalog, Agreement, Billing,
  Support, Usage, Communication*.
- A **system** (called a **provider**) is one of the outside services —
  HubSpot, Stripe, and so on.
- One connection can serve **several purposes at once**. A single HubSpot
  connection can bring in companies *and* tickets, so the permission request is
  the combination of everything you asked for.
- Adding a purpose later asks the system for more permission, so the platform
  tells you to reconnect instead of failing mysteriously halfway through a
  refresh.

## What you can connect today

Seven systems are supported. Six are real products; one is a built-in practice
system.

| System | Type | How you connect it | What it brings in today |
|---|---|---|---|
| **HubSpot** | CRM | Sign in and approve access | Companies, contacts, deals and their line items |
| **Salesforce** | CRM | Sign in and approve access | Accounts and contacts |
| **Metrifox** | Billing / usage | Paste an API key from your dashboard | Customers and their people |
| **Stripe** | Billing | Paste a secret or restricted API key | Customers, catalog, subscriptions, invoices, payments |
| **Chargebee** | Billing | Paste a read-only key (`site:key`) | Customers, catalog, subscriptions, invoices, payments |
| **Stigg** | Billing | Paste a server API key | Customers, catalog, subscriptions |
| **Mock CRM** *(built-in)* | Practice | Click through a built-in approval screen | Made-up companies and contacts — lets the whole flow be demonstrated with no credentials |

"Sign in and approve access" means the standard permission screen from the
system itself (technically called **OAuth**). "Paste an API key" means the
system gave you a long-lived password to copy; there is no approval screen to
show, so the platform proves the key works before saving anything.

## The four kinds of data — and what is ready

The platform defines seven purposes. Four of them can actually sync data today;
the other three are shown because the products and the plan are real, but no
system is connected to them yet.

| Purpose | What it brings in | Ready today |
|---|---|---|
| **Identity** | Companies and the people who work at them: names, websites, emails, industries, job titles | HubSpot, Salesforce, Metrifox, Stripe, Chargebee, Stigg, Mock |
| **Catalog** | What you sell: products, their offerings, prices, the features each offering includes | Stripe, Chargebee, Stigg |
| **Agreement** | What customers signed up for: subscriptions, their priced lines, the features they receive, discounts — and HubSpot deals with their line items | Stripe, Chargebee, Stigg, HubSpot |
| **Billing** | Invoices, the lines on each invoice, and payments and refunds | Stripe, Chargebee |
| **Support** | Tickets, conversations, satisfaction scores | *Planned — shown but not syncing* |
| **Usage** | Usage events and metering data | *Planned — shown but not syncing* |
| **Communication** | Email, calls, and messaging history | *Planned — shown but not syncing* |

A few honest details behind that table:

- **Agreement is partly planned.** Salesforce, Metrifox and the Mock CRM
  appear when you choose Agreement, but only Stripe, Chargebee, Stigg and
  HubSpot actually sync it. The platform says so plainly instead of hiding them.
- **Support, Usage and Communication have no system behind them at all.** They
  are in the picker so the roadmap is visible, and so "no provider supports
  this yet" is a state the software can genuinely report.
- **The same data can arrive from several systems.** Customers from Stripe,
  Metrifox and a CRM are separate records until the company-matching step
  combines them (see below).

## The journey of one connection

1. **Choose purposes.** Tick Identity, Billing, and so on. This is the only step
   that decides permissions.
2. **Choose a system.** Only systems that can cover *all* the purposes you
   ticked are offered.
3. **Give permission.** Sign in to the system and approve the request, or paste
   a key. Nothing is saved until the system has proven the permission works — a
   mistyped key or a canceled approval leaves no half-finished connection
   behind. If you are pasting a key and it is rejected, you can try again
   without re-choosing everything.
4. **Check the translation rules.** The platform arrives pre-filled with
   sensible rules ("HubSpot's *Website* becomes our *Domain*"), so it can work
   immediately. You can change them at any time; see
   [translation rules](./architecture.md#5-translation-rules).
5. **Bring the data in.** Press *Sync now*, or let the schedule do it — once a
   day by default, adjustable from one hour to one week. You can re-run at any
   time; records are updated, never duplicated.

A **refresh** (called a **sync** or **run**) fetches the latest data from the
system, translates it using your rules, and saves it. Each refresh reports what
it did: *success*, *partial* (some records were skipped, with a reason for
each), *failed*, or *discarded* (a refresh for that connection was already
running). See
[`architecture.md`](./architecture.md#6-what-happens-during-a-refresh) for the
full story.

## One company out of many systems

This is the platform's second distinctive feature. A real company — say,
"Ridgeline Utilities" — might exist as a *company* in HubSpot, a *customer* in
Stripe, and a *customer* in Metrifox. Those are three unrelated records, because
each system uses its own identification.

After every refresh, the platform runs a **company-matching pass** over all of
one owner's records. It looks for shared evidence — the same email address, the
same website domain, the same person's email, or an explicit cross-reference —
and groups matching records under one combined company profile. Things worth
knowing:

- **Priority decides descriptions, never membership.** Each connection has a
  priority setting (lower number wins). It decides whose name, industry, or
  website is shown when systems disagree about a *value*. It can never change
  which records are grouped together — so adjusting a number to fix a displayed
  name can never silently regroup your customers.
- **It prefers to ask rather than guess.** When two companies both claim the
  same email address, the platform does not merge them. It flags the clash for a
  person to review.
- **A person's decision is final.** On the Accounts screen you can record "same
  company" or "not this company". Those decisions outrank every automatic
  match and survive every later refresh.
- **Blank beats wrong.** If the top-priority system simply has no industry on
  file, it does not blank the industry that another system supplied. Each detail
  is won by the highest-priority system that actually has something to say.

## What happens to your data

- **Credentials are encrypted** before they are stored, using the same
  industrial-strength method used for passwords. They are never shown on a
  screen or written to a log.
- **Each owner's data is kept separate.** Every connection, record, and
  combined company profile belongs to one sign-in account, and every database
  query is restricted to that account. Two owners can each have a customer with
  the same email without them ever being mixed.
- **The platform only asks for the permissions your chosen purposes need.**
  Choose Identity, and it will not request invoice access.
- **Money figures are copied, never calculated.** Amounts (invoice totals,
  payments) are stored exactly as the billing system states them, so the numbers
  always match the source system. The platform deliberately does not do its own
  arithmetic on them.
- **The built-in practice system is off by default.** Mock CRM only appears when
  a deployment deliberately switches it on, and it is meant for demonstrations,
  not production.

## Where to see it in the app

| Screen | What it shows |
|---|---|
| **Integrations** | Every connected system, its status, and its "Sync now" button |
| **Integration detail** | Connection health, priority setting, cross-reference import, run history, and the mapping editor |
| **Synced data** | Customers, Contacts, and the **Accounts** tab where records from different systems appear as one company |
| **Catalog** | Products, offerings, prices, features and entitlements |
| **Agreements** | Subscriptions and contracts, with their lines, entitlements and discounts |
| **Billing** | Invoices, their lines, and payments |

## Honest limits today

- **One sign-in account, created at setup.** There is no sign-up or password-reset
  screen yet; every connection belongs to the single account created when the
  database is first prepared.
- **Support, Usage and Communication sync nothing yet**, and Agreement is only
  live for Stripe, Chargebee, Stigg and HubSpot (deals and line items).
- **Stripe has no separate people records.** Its contacts are assembled from the
  customer's own name, email and phone — one per customer — which is the best
  that system offers, not a full contact list.
- **Removing a connection does not always cancel access at the provider.** For
  sign-in connections the platform asks the provider to revoke access, but it
  cannot guarantee a provider will answer. For API keys there is nothing to
  revoke — the key belongs to your account — so delete it in the provider's own
  dashboard when you want it dead.
- **A feature removed from a plan can linger.** For catalog entitlements the
  platform has no way to notice that something stopped arriving, so a removed
  feature stays in the stored catalog until the connection is deleted. This is a
  known gap, not an error.

## Words used in this documentation

| Word | Meaning in plain language |
|---|---|
| **Provider** | An outside system the platform connects to — HubSpot, Stripe, and so on. |
| **Integration** (or **connection**) | One configured link to one provider account, with one set of permissions and one label you choose. |
| **Function** (or **purpose**) | A kind of job the connection does — Identity, Catalog, Agreement, Billing, Support, Usage, Communication. |
| **Scope** (or **permission**) | What the outside system allows the platform to read. Requested based on the chosen functions. |
| **OAuth** | The "sign in and approve" style of connection: you approve access on the provider's own screen. No password is shared with this platform. |
| **API key** | A long-lived password the provider issues. Used for systems that do not offer an approval screen. |
| **Credential** | Whatever proves the connection is allowed in — an approved sign-in or an API key. Encrypted before storage. |
| **Field mapping** | A translation rule: "take *this* field from the provider, optionally clean it up, and store it as *that* field of ours." |
| **Transform** | The optional clean-up in a mapping rule — trim spaces, lowercase an email, turn a full web address into just the domain, or keep only the date. |
| **Sync** (or **run**) | One refresh: fetch, translate, save, and report. |
| **Record** | One stored item — a customer, a contact, an invoice. |
| **Customer** | A company as one system sees it. Several customer records can become one **account**. |
| **Account** (Customer Account) | The combined company profile built by matching customer records from different systems. |
| **Identity resolution** | The company-matching pass that builds accounts after each refresh. |
| **Catalog / Offering / Price** | What you sell (catalog): a product; a purchasable version of it (offering); a specific amount, currency and billing rhythm for that offering (price). |
| **Feature / Entitlement** | A reusable capability (feature, e.g. "api-access") and the statement that an offering includes it, at some limit (entitlement). |
| **Agreement** | A commercial commitment: a subscription, an order form, a contract, or a deal. |
| **Subscription** | The recurring-billing details of a subscription-type agreement — periods, trial, cancellation, next renewal. |
| **Invoice / Invoice line / Payment** | The bill, one itemized row on the bill, and a money movement (a payment or a refund). |
| **Reconcile** | On refresh, compare a stored list against what the provider currently says and remove entries that are genuinely gone. Used for invoice lines and the three agreement detail lists. |
| **Crosswalk / cross-reference** | An explicit note that record X in one system is record Y in another — used when names and emails alone cannot prove the match. |
| **Priority** | A per-connection ranking (lower wins) that decides which system's version of a shared field is displayed. It never affects which records are grouped together. |
| **Revenue graph** | The framework's name for the living model of every customer — their agreements, entitlements, usage, money and health. This platform builds its data layer: identity, catalog, agreements and billing. See [`revenue-graph.md`](./revenue-graph.md). |

---

*For the engineering view of the same system — where the code lives, how the
pieces are arranged, and the database schema itself — see the repository's
[`README.md`](../README.md) and [`prisma/schema.prisma`](../prisma/schema.prisma).*
