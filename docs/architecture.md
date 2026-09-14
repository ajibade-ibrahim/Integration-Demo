# Architecture

A map of the codebase for someone who has never opened it. The
[README](../README.md) explains *what the platform does* and *why the decisions
went the way they did*; [`data-model.md`](./data-model.md) covers the fifteen
tables. This document covers **where the code lives and how a request moves
through it**.

Read the first two sections and you can find anything. The rest is one section
per aspect, each answering a single question.

> **The diagrams below also exist as an interactive page** —
> [`docs/diagrams/index.html`](./diagrams/index.html). Same nine diagrams, but
> zoomable, hover-to-isolate, dark-mode, and with a live `resolveScopes()`
> matrix in §2. Open it in a browser; it needs no server.

---

## 1. The whole system in one picture

Four entry points, one framework-free core, one database. The core never
imports Next.js; the app layer never talks to Prisma directly (with two
documented exceptions, noted in §9).

```mermaid
flowchart TB
    subgraph entry["Entry points — every code path starts in one of these"]
        direction LR
        PAGES["<b>Server components</b><br/>src/app/**/page.tsx<br/><i>read state, render</i>"]
        ROUTES["<b>Route handlers</b><br/>src/app/api/**/route.ts<br/><i>mutate state</i>"]
        CRONR["<b>Cron route</b><br/>/api/cron/sync<br/><i>poked by scripts/worker.ts</i>"]
        SCRIPTS["<b>Scripts</b><br/>prisma/seed.ts<br/>scripts/*.mts"]
    end

    BOOT["<b>bootstrap()</b> — src/core/bootstrap.ts<br/>idempotent; every entry point calls it first"]

    subgraph registries["Registries — the extension seam"]
        direction LR
        FREG["functionRegistry<br/><i>identity, support,<br/>billing, usage, comms</i>"]
        PREG["providerRegistry<br/><i>hubspot, salesforce,<br/>metrifox, stripe, mock</i>"]
        HREG["handler + discovery<br/>keyed <b>function:provider</b>"]
    end

    subgraph services["Orchestration — provider-agnostic policy"]
        direction LR
        OAUTHS["oauth/oauth-service<br/><i>authorize, callback,<br/>refresh, revoke</i>"]
        KEYS["credentials/api-key-service<br/><i>validate, probe, store</i>"]
        ENGINE["sync/sync-engine<br/><i>guard, fetch, map,<br/>write, record</i>"]
        DISCO["sync/discovery-service<br/><i>source fields + cache</i>"]
        SCHED["sync/scheduler<br/><i>what is due</i>"]
        RESOLVE["identity/identity-resolver<br/><i>per user, after sync —<br/>one company from many rows</i>"]
    end

    subgraph pure["Pure logic — no I/O, no database, trivially testable"]
        direction LR
        SCHEMA["identity-schema.ts<br/><i>the target contract</i>"]
        MAPPER["field-mapper/<br/><i>validate, apply, serialize</i>"]
        CRYPTO["oauth/crypto.ts<br/><i>AES-256-GCM</i>"]
        IDENT["identity/<br/><i>normalize · evidence ·<br/>survivorship · assertions</i>"]
    end

    subgraph provs["Providers — one directory each, all interchangeable"]
        direction LR
        HS["hubspot/"]
        SF["salesforce/"]
        MF["metrifox/"]
        ST["stripe/"]
        MK["mock/"]
        HTTP["<b>providers/http.ts</b><br/>shared failure policy<br/>401 / 429 / 5xx"]
    end

    REPOS["<b>repositories/</b> — the modules that speak Prisma"]
    DB[("Postgres via Prisma<br/>15 tables")]

    entry --> BOOT
    BOOT --> registries
    entry --> services
    services --> registries
    services --> pure
    services --> provs
    provs --> HTTP
    services --> REPOS
    provs -.->|"no DB access:<br/>refresh arrives as a callback"| services
    REPOS --> DB

    style BOOT fill:#e8eef7,stroke:#4a6fa5
    style registries fill:#f2eef7,stroke:#7a5fa5
    style pure fill:#eef7ee,stroke:#5a8a5a
    style REPOS fill:#f7f1e8,stroke:#a5824a
```

**The one rule that shapes everything:** `src/core/` is framework-free. It has no
`next/*` imports, so the sync engine, the OAuth flow and every provider can be
exercised from a plain script or a test with no HTTP server running. `src/app/`
is a thin adapter — parse the request, call a core function, shape a response.

---

## 2. The one idea, and why the code is shaped around it

> **An integration declares which _functions_ it serves, and that declaration
> determines the OAuth scopes requested.**

That single sentence explains most of the structure. Because scopes depend on
*both* the function and the provider — HubSpot's scopes are granular, Salesforce's
`api` scope already covers everything — nothing can be keyed by function alone or
provider alone. So the central data structure is a **grid**:

```mermaid
flowchart LR
    subgraph grid["Everything provider-specific is keyed by function x provider"]
        direction TB
        G["<b>scopesByProvider</b><br/>function-registry.ts<br/><i>what consent asks for</i>"]
        H["<b>syncHandler</b><br/>handler-registry.ts<br/><i>how to fetch pages</i>"]
        I["<b>fieldDiscovery</b><br/>handler-registry.ts<br/><i>what can be mapped from</i>"]
        J["<b>defaultMappings</b><br/>defaults-registry.ts<br/><i>so it syncs immediately</i>"]
    end

    RS["<b>resolveScopes(functions, provider)</b><br/>= union of scopesByProvider<br/>across the selected functions"]

    G --> RS
    RS --> CONSENT["Consent screen shows<br/>exactly these scopes"]
    RS --> STORED["OAuthToken.grantedScopes<br/>records what was <i>actually</i> granted"]
    STORED --> DRIFT["checkReauthorization():<br/>function added later =><br/>explicit reconnect prompt,<br/>not an opaque mid-sync 403"]

    style RS fill:#f2eef7,stroke:#7a5fa5
```

Three consequences worth internalising before reading any file:

| Consequence | Where you see it |
|---|---|
| An integration serves a **set** of functions, not one | `IntegrationFunction` is one-to-many; `resolveScopes` takes an array |
| A function can be **declared without being built** | `billing`/`usage`/`communication` are registered with no handler, so "no provider supports this yet" is a real, reachable state |
| A provider is **added, not wired in** | New directory under `core/providers/` + one call in [`bootstrap.ts`](../src/core/bootstrap.ts). No orchestration code changes. |

---

## 3. Connecting — two credential kinds, one destination

The trickiest thing to hold in your head is that **there are two ways to get a
credential and they converge**. `ProviderDefinition.auth` is a discriminated
union (`kind: "oauth" | "apiKey"`), so the compiler forces every branch to be
handled rather than letting an API-key provider quietly assume a token endpoint.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant NEW as /integrations/new
    participant API as /api/integrations
    participant OA as oauth-service
    participant AK as api-key-service
    participant P as Provider
    participant FIN as createIntegrationFromDraft

    U->>NEW: pick functions, then a provider
    Note over NEW: providerNamesForFunctions()<br/>lists only providers covering<br/>ALL selected functions
    NEW->>API: POST - create a draft
    Note over API: nothing is written to the database:<br/>a rejected or abandoned connect<br/>must leave no row behind
    API-->>U: draftId + connectUrl

    alt auth.kind === "oauth" (HubSpot, Salesforce, Mock)
        U->>OA: GET /api/oauth/{provider}/start?draftId
        OA->>OA: resolveScopes() + issueState({kind:"draft"})
        OA-->>U: 302 to provider consent screen
        U->>P: grants consent
        P-->>OA: GET /callback?code&state
        OA->>OA: consumeState() - single-use, constant-time compare
        OA->>P: exchange code for tokens
        P-->>OA: access + refresh + granted scopes
    else auth.kind === "apiKey" (Metrifox, Stripe)
        U->>AK: POST /api/integrations/connect {draftId, apiKey}
        AK->>AK: validateKeyShape() - local, no network
        AK->>P: probeCredential() - prove it works
        P-->>AK: 200, or 401 and the key is never stored
        Note over AK: on 401 the draft survives,<br/>so the user re-pastes rather than<br/>re-choosing provider and functions
    end

    OA->>FIN: proven credential + draft
    AK->>FIN: proven credential + draft
    FIN->>FIN: createIntegration() - the row first exists here
    FIN->>FIN: saveToken() then markAuthorized() + seedMappingsIfEmpty()
    Note over FIN: any failure after the insert<br/>deletes the row again
    FIN-->>U: status = active, ready to sync
```

The ordering above is the point: every credential is proven *before* an
`Integration` row exists. A first connect that fails leaves nothing to clean up.
Reconnecting an integration that already exists is the one path that keeps the
old behaviour — it sets `status = error` and preserves the row, because by then
it may carry edited mappings and synced records that a delete would destroy.

**What differs, and what deliberately does not:**

| | OAuth | API key |
|---|---|---|
| Credential arrives | Redirect + consent | Paste box |
| Configured per | Deployment (`.env` client id/secret) | Integration |
| Expiry / refresh | Yes — proactive, 5 min leeway | Never; `isNonExpiring` keeps it off the refresh path |
| 401 during sync | Refresh, retry once | Terminal — `refreshAccessToken` is *withheld* from the handler |
| Encryption at rest | AES-256-GCM | The same code path |
| Everything after the credential | — identical — | — identical — |

That last row is the payoff: pagination, mapping, writing, and the failure
policy have no idea which kind of credential they are running on.

---

## 4. Mapping — how a provider field becomes one of ours

[`identity-schema.ts`](../src/core/identity-schema.ts) is a single object read by
three consumers that would otherwise drift apart. Target paths are
**object-qualified** (`customer.name`, `contact.email`) so a contact field can
never be mapped onto a customer record and still validate.

```mermaid
flowchart LR
    subgraph src["Source side - what the provider offers"]
        DISCO["discovery-service<br/><i>reads provider schema API,<br/>caches 1h in DiscoveredField</i>"]
        FREE["free-text entry<br/><i>escape hatch when the<br/>dropdown cannot express it</i>"]
    end

    subgraph rule["FieldMappingRule - one row per target field"]
        R["sourceFieldPath<br/>+ targetObject<br/>+ targetFieldPath<br/>+ transform"]
    end

    subgraph tgt["Target side - the contract"]
        IS["<b>identity-schema.ts</b>"]
        C1["validateMappings()"]
        C2["mapping editor dropdown"]
        C3["sync-engine record validation"]
        IS --> C1
        IS --> C2
        IS --> C3
    end

    T["<b>transforms</b><br/>none - trim - lowercase<br/>domainFromUrl - dateOnly"]

    DISCO --> R
    FREE --> R
    R --> C1
    R --> T
    T --> OUT["<b>MappedRecord</b><br/>fields + customFields<br/><i>absent source yields null,<br/>never a missing key</i>"]

    style IS fill:#eef7ee,stroke:#5a8a5a
```

Two details that surprise people:

- **A mapped-but-absent source field writes `null`, not nothing.** The output
  shape depends on the rule set, never on which fields a particular record
  happened to carry.
  ([`field-mapper.ts:178`](../src/core/field-mapper/field-mapper.ts#L178))
- **`readPath` walks own properties only.** Source paths are user-editable, so
  `constructor` or `__proto__` would otherwise reach up the prototype chain.
  ([`field-mapper.ts:142`](../src/core/field-mapper/field-mapper.ts#L142))

**Three kinds of target path, not one.** `resolveTargetField` returns a
`FieldDefinition`, the sentinel `"customField"`, or the sentinel `"crossRef"` —
a union rather than a boolean, so adding the third made the compiler point at
every consumer that had to handle it.

| Pattern | Means | Validated against |
|---|---|---|
| `name`, `email`, `domain` | A real column | `identity-schema.ts` |
| `customFields.<key>` | A single-segment JSON key | the pattern only — the key is whatever the user wants |
| `crossRef.<provider>` | "this company is *that* id over there" | **`providerRegistry`** — `crossRef.nonsense` cannot be saved |

The last one needed the only UI addition: the target dropdown is built from
`mappableFields()`, which returns `FieldDefinition[]` and cannot express a
cross-reference, so a "Same company in…" option is backed by a *provider*
dropdown rather than the free-text box custom fields get. A custom-field key is
arbitrary; a cross-reference segment must name a registered provider or it fails
validation.

---

## 5. Sync — the pipeline, and the one ordering that matters

```mermaid
flowchart TB
    START["executeSync(integrationId)"] --> G1{"status === active?"}
    G1 -->|no| FAIL1["failed - connect it first"]
    G1 -->|yes| G2{"already in flight?"}
    G2 -->|yes| DISC["<b>discarded</b><br/><i>the second caller is told,<br/>not silently ignored</i>"]
    G2 -->|no| LOCK["claim lock, create SyncRun(running)"]

    LOCK --> TOK["getValidToken()<br/><i>refreshes if within 5 min of expiry</i>"]
    TOK --> LOOP["for each declared function:<br/>requireSyncHandler(fn, provider)<br/>+ findMappings(fn)"]

    LOOP --> FETCH["<b>handler.fetchPages()</b><br/><i>async iterable - pages are mapped<br/>as they arrive, never buffered whole</i>"]
    FETCH --> MAP["applyMappings() per record"]

    MAP --> WC["<b>1. writeCustomers()</b><br/>upsert on integrationId + externalSourceId<br/>builds the external-to-internal index"]
    WC --> WK["<b>2. writeContacts()</b><br/>resolve association through the index,<br/>then fall back to a DB lookup"]
    WK --> RELINK["<b>3. relinkOrphanedContacts()</b><br/><i>contacts stranded by earlier runs<br/>get linked once their company arrives</i>"]

    RELINK --> STATUS{"any rejected records?"}
    STATUS -->|no| OK["<b>success</b>"]
    STATUS -->|yes| PART["<b>partial</b><br/><i>wrote 19 of 20 - the reason for<br/>the 20th is stored and shown</i>"]

    OK --> REL["release lock, markLastSync()"]
    PART --> REL

    style WC fill:#f7f1e8,stroke:#a5824a
    style WK fill:#f7f1e8,stroke:#a5824a
    style DISC fill:#f7eeee,stroke:#a55a5a
```

**Why customers are written before contacts.** Providers return their *own*
company id on a contact — HubSpot in an associations block, Salesforce as
`AccountId` — never our internal UUID. Writing that into a foreign key produces
a dangling reference. Customers go first to build the `external → internal`
index; a contact that still cannot be resolved is **kept with a null link and a
warning**, its `externalCustomerId` retained so a later run links it. That
ordering is why [`record-writer.ts`](../src/core/sync/record-writer.ts) exists as
its own module rather than living inline in the engine.

**Per-record failures never abort a run.** A `RecordIssue` carries
`severity: "warning" | "rejected"` — a malformed email rejects the contact
(a broken primary identifier poisons later matching), an unrecognised customer
type only warns. A malformed *account* email is the deliberate opposite: warned
about and nulled rather than rejected, because a customer's identity is `name` +
`externalSourceId` and discarding a whole company over one bad field is worse
than an empty column.

**Then identity resolution runs, outside all of this** — see §6. It is a
separate per-user pass, wrapped so that it cannot fail the sync that triggered
it.

---

## 6. Identity — one company out of three rows

Sync is **per integration**. Identity resolution is **per user**, and that
difference is the whole reason it is a separate pass rather than a step inside
`executeSync`: one real company appears as three `Customer` rows in three
connections, so no single integration can see the group. `sync-engine.ts` gains
no import from this; the two call sites go through
[`resolve-after-sync.ts`](../src/core/identity/resolve-after-sync.ts), which
holds the one policy that matters — **a sync is never reported failed because
resolution hiccuped**.

```mermaid
flowchart TB
    TRIG["after a sync · scheduler tick · POST /api/identity/resolve"] --> GUARD{"pass already<br/>running for this user?"}
    GUARD -->|yes| DISC["<b>discarded</b><br/><i>runId null, no row written —<br/>a discard is contention,<br/>not an execution</i>"]
    GUARD -->|no| REAP0["<b>0. reap</b> empty accounts<br/><i>a shell still holding a key claim<br/>permanently blocks the right<br/>account from forming</i>"]

    REAP0 --> EV["<b>1. build evidence</b> — pure<br/>email · domain · contact emails ·<br/>self-reference · cross-refs"]
    EV --> ASRT["<b>1.5 cluster by <code>same</code> assertions</b><br/><i>union-find over customers,<br/>before any key matching</i>"]

    ASRT --> MATCH{"candidate accounts<br/>for this cluster's keys"}
    MATCH -->|"0"| NEW["create one, link, insert keys"]
    MATCH -->|"1"| LINK["link, insert only<br/>keys it lacks"]
    MATCH -->|"≥2"| CONF["<b>conflict — never merge</b><br/>strongest key kind, then oldest,<br/>then smallest id wins the link;<br/>losing keys stay put, issue raised"]

    NEW --> SURV
    LINK --> SURV
    CONF --> SURV["<b>2. survivorship</b> — pure<br/><i>per field, the highest-priority<br/>member that actually supplies a value</i>"]
    SURV --> REAP1["<b>3. reap again</b><br/><i>shells this pass emptied would<br/>otherwise hold their claims<br/>until the next one</i>"]

    VETO["<code>distinct</code> assertion"] -.->|"vetoes, per candidate account"| MATCH

    style DISC fill:#f7eeee,stroke:#a55a5a
    style SURV fill:#eef7ee,stroke:#5a8a5a
    style CONF fill:#f7f1e8,stroke:#a5824a
```

### The two conflicts, and why only one of them is a hierarchy

This is the distinction the whole design rests on, and conflating them is the
easiest way to build something dangerous.

| | The question | Resolved by `identityPriority`? |
|---|---|---|
| **Key conflict** | "Is this the same company?" — two accounts both claim `billing@acme.example` | **No.** Never auto-merged; the winner is deterministic, losing keys stay put, and a `key_claimed_elsewhere` issue asks a human. |
| **Value conflict** | "What is this company called?" — HubSpot says `Acme Manufacturing Inc`, Stripe says `Acme Corp` | **Yes.** This is the only thing the rank is for. |

**Priority changes what an account says, never who is in it.** If reordering
sources could repartition accounts, then nudging a number to fix a displayed
name would silently regroup someone's customer list — and nobody would connect
the two events. `identity-surfacing.test.ts` asserts the placements and the key
rows are *identical* across a priority change, not merely equivalent.

**A null is not an opinion.** Stripe has no `industry`, `domain` or `type` field
at all; HubSpot has no account-level `email`. So "the top-ranked source's row
wins wholesale" would be destructive — putting Stripe at priority 1 would blank
three columns on every account it touches. Each field is contested only among
the members that actually carry it, which is what lets the hierarchy compose:
Stripe wins `email`, HubSpot wins `industry`, neither erases the other.

`createDate` is the one declared exception, taking the **earliest** value rather
than the highest-priority one — if the CRM saw a company in 2019 it existed in
2019. Declared rather than special-cased, as `conflictPolicy` on the field
definition in `identity-schema.ts`, so the rule lives next to the field it
governs.

### Three ways a foreign id arrives

The spec calls Metrifox's `payments_stripe_customers` the join that makes one
customer account possible, and **no Metrifox endpoint exposes it**. So
`external_ref` — the strongest key kind — needs supply routes that do not depend
on a fetch.

| Route | Shape | Where |
|---|---|---|
| **Self-reference** | Free. Every customer contributes `<provider>:<scope>:<externalSourceId>` from data already in hand | `evidence.ts` |
| **Mapped field** | `crossRef.<provider>` target path, parallel to `customFields.<key>` — reuses the mapping editor, validation and transforms wholesale | `identity-schema.ts`, `Customer.crossRefs` |
| **Imported crosswalk** | Pasted or uploaded `<local id>,<foreign id>` pairs — the honest answer for a table no API serves | `identity/crosswalk.ts`, `Customer.importedCrossRefs` |

**The scope segment is not optional.** HubSpot object ids are portal-scoped, so
a bare `hubspot:12345` self-key would merge company `12345` in two different
portals into one company. Every provider declares
`externalIdScope: "global" | "tenant"`; a tenant-scoped one takes its scope from
the token's `providerMetadata`, and **if no scope value is available it emits no
self-key at all**. Failing closed costs a join, which is visible and
recoverable; guessing costs a false merge, which looks exactly like the matcher
working well.

That is not hypothetical: HubSpot's token response carries no `hub_id` (it is
only readable from an endpoint `parseTokenResponse` cannot call), so HubSpot
contributes no self-key today. Salesforce is scoped by `organizationId` rather
than `instance_url`, because legacy pod hostnames like `na1.salesforce.com` were
shared by thousands of unrelated orgs.

### What the resolver will not do

Three refusals, each deliberate, each tested:

- **It never writes an assertion, only reads them.** That is what makes a human
  verdict sticky across a pass that otherwise recomputes everything.
- **It merges on evidence and never splits on the absence of it.** Withdrawing
  an imported crosswalk stops the pair being supplied; it does not take apart
  the account it already made. Only a `distinct` assertion separates records
  that are already grouped.
- **It never auto-merges two multi-member accounts.** A false merge is the worst
  failure any matcher has and it has no user-facing undo, so two rival accounts
  contest and raise an issue instead. The human routes — "same company" and "not
  this company" on the Accounts tab — are how a merge actually happens.

---

## 7. Failing well — two nested retry loops

This is the part most worth understanding before debugging a flaky sync, because
the two loops are easy to confuse. The inner one lives in
[`providers/http.ts`](../src/core/providers/http.ts) and retries **one request**;
the outer one lives in the sync engine and retries **the whole run**.

```mermaid
flowchart TB
    REQ["provider request"] --> ST{"status"}

    ST -->|"200"| OK["page returned"]

    ST -->|"401"| R1{"refreshAccessToken<br/>available?"}
    R1 -->|"no - API key"| REAUTH
    R1 -->|yes| RF["refresh, retry once"]
    RF --> SECOND{"401 again?"}
    SECOND -->|yes| REAUTH["<b>ReauthorizationRequiredError</b><br/>status = requires_reauthorization<br/><i>not retryable: no amount of<br/>waiting fixes a dead grant</i>"]
    SECOND -->|no| OK

    ST -->|"429"| WAIT["wait Retry-After, or the fallback<br/>retry the <b>same</b> request<br/><i>so pagination resumes at the<br/>same cursor, not from page 1</i>"]
    WAIT --> BOUND{"both waits used?"}
    BOUND -->|no| REQ
    BOUND -->|yes| RETRYABLE

    ST -->|"5xx"| RETRYABLE["<b>RetryableSyncError</b><br/>bubbles to the run-level loop"]
    ST -->|"other"| HARD["<b>fail the run</b><br/><i>everything already written stays written</i>"]

    RETRYABLE --> OUTER["<b>outer loop</b> - sync-engine<br/>exponential backoff,<br/>bounded by SYNC_MAX_ATTEMPTS"]
    OUTER -->|attempts left| REQ
    OUTER -->|exhausted| FAILED["SyncRun = failed<br/><i>integration stays active -<br/>one bad run must not<br/>block the schedule</i>"]

    style REAUTH fill:#f7eeee,stroke:#a55a5a
    style OUTER fill:#e8eef7,stroke:#4a6fa5
```

All waiting goes through an injected `Clock`
([`sync/clock.ts`](../src/core/sync/clock.ts)), so tests assert retry *schedules*
instantly instead of sitting through them.

---

## 8. Where do I look for X?

| I want to change… | Open |
|---|---|
| Which scopes a function asks a provider for | [`bootstrap.ts`](../src/core/bootstrap.ts) — every registration is in this one file |
| The fields a mapping may write to | [`identity-schema.ts`](../src/core/identity-schema.ts) — validator, UI and engine all read it |
| How a provider paginates or shapes its query | `core/providers/<name>/identity-handler.ts` and `api.ts` |
| What the mapping editor offers as sources | `core/providers/<name>/discovery.ts` |
| The pre-filled mapping a new integration starts with | `core/providers/<name>/defaults.ts` |
| Retry / rate-limit behaviour | [`providers/http.ts`](../src/core/providers/http.ts) (per request) or [`sync-engine.ts`](../src/core/sync/sync-engine.ts) (per run) |
| Anything touching the database | `core/repositories/` |
| The status lifecycle | [`integration-repository.ts`](../src/core/repositories/integration-repository.ts); diagram in [data-model.md](./data-model.md#integrationstatus-lifecycle) |
| What runs on a schedule | [`sync/scheduler.ts`](../src/core/sync/scheduler.ts), driven by `/api/cron/sync` |
| What counts as evidence that two records are one company | [`identity/evidence.ts`](../src/core/identity/evidence.ts) — pure; every key the matcher will ever see is emitted here |
| Which source wins a contested field | [`identity/survivorship.ts`](../src/core/identity/survivorship.ts), ranked by `Integration.identityPriority` |
| How an email or domain is normalized before matching | [`identity/normalize.ts`](../src/core/identity/normalize.ts) — and `EMAIL_PATTERN` lives here, imported by the record writer, so validating and matching cannot drift |
| Which domains are refused as match keys | [`identity/free-email-domains.ts`](../src/core/identity/free-email-domains.ts) |
| Moving existing connections onto a changed default | [`identity/mapping-retarget.ts`](../src/core/identity/mapping-retarget.ts) + `npm run mappings:retarget` |

### The provider directory, as a template

Every provider is the same five-to-six files. That uniformity is the point —
adding one is filling in a known shape, not designing anything.

| File | Role | Required? |
|---|---|---|
| `provider.ts` | `ProviderDefinition` — name, label, `auth` union member, scope constants | yes |
| `identity-handler.ts` | `fetchPages()`, `externalIdOf()`, `externalCustomerIdOf()` | yes, to sync |
| `api.ts` | Base URL, page size, endpoint paths — env-overridable so tests can retarget them | in practice |
| `discovery.ts` | Reads the provider's schema API for the source dropdown | optional — absent means free-text only |
| `defaults.ts` | Suggested starting mappings | optional — absent means an empty editor |
| `fixtures.ts` / `fake.ts` | Canned data, and/or the static field list discovery unions with | mock and Metrifox have both; Stripe has `fixtures.ts` and no fake, because its CLI seeds a real sandbox instead |

---

## 9. Layering rules — and the two places reality bends

```mermaid
flowchart TB
    A["src/app/ - pages, route handlers"] --> B["src/core/ - orchestration"]
    B --> C["src/core/repositories/"]
    C --> D[("Prisma / Postgres")]
    B --> E["src/core/providers/"]
    E --> F["outbound HTTP"]

    A -.->|"never"| D
    E -.->|"never"| D
    B -.->|"never"| A

    style A fill:#e8eef7,stroke:#4a6fa5
    style C fill:#f7f1e8,stroke:#a5824a
```

Enforced by convention, not by tooling. Two accurate caveats, since the point of
this document is that you can trust it:

1. **`sync-engine.ts` and `record-writer.ts` import `prisma` directly**
   ([sync-engine.ts:10](../src/core/sync/sync-engine.ts#L10),
   [record-writer.ts:12](../src/core/sync/record-writer.ts#L12)) for `SyncRun`
   bookkeeping and the record upserts. So "repositories are the *only* layer
   importing the Prisma client" is the intent, with these two as the exception.
2. **`app/integrations/[id]/page.tsx` imports `prisma`**
   (`src/app/integrations/[id]/page.tsx:16`) for a read the repositories do not
   expose. It is the only app-layer file that does.

The identity pass is the counter-example that shows the rule is affordable:
`identity-resolver.ts` orchestrates a whole multi-phase write and imports no
Prisma client at all, going through
[`identity-repository.ts`](../src/core/repositories/identity-repository.ts) for
every query. That file exists so **every write and every match query is scoped
by `userId` in one reviewable place** — a single missing `userId` merges two
tenants' companies, which is the severe failure in this schema. Account *reads*
for the Accounts tab deliberately live in `synced-data-repository.ts` instead: a
read-only projection for a page is not part of the matcher, and putting it in
the guarded file would only enlarge the surface being guarded.

Everything else holds: no `src/core` file imports from `src/app`, and no
provider file imports the database or the OAuth service — token refresh reaches
providers as a **callback on `HandlerContext`**, which is precisely what lets
`tests/integration/` exercise real pagination and 401-refresh-retry paths against
msw with no Prisma client in the process.

### Two singletons on `globalThis`, and two tables that used to be singletons

The sync in-flight lock hangs off `globalThis`, and the Prisma client does too
outside production. Next compiles route modules separately and re-evaluates them
on hot reload, so a plain module-level `Set` would let two concurrent requests
each believe they held the sync lock. For Prisma the failure mode is a leaked
connection pool per reload, which is why production gets a plain instance
instead.

The OAuth state store and the connect draft store were on `globalThis` for the
same reason and are now tables (`OAuthState`, `IntegrationDraft`). Hot reload was
only half the problem: both are written by one request and read by another, so on
a host that runs more than one instance the second request reaches an instance
that never saw the write. Every callback fails state validation, and every draft
is "expired" by the time its connect page renders. A table answers both, and the
single-use property of state comes out stronger — `consumeState` deletes the row
it reads, so two concurrent callbacks race on one row and exactly one wins.

What remains genuinely single-instance is the sync lock, which fails safe: the
worst case is one integration synced twice at once, not a broken connect.

---

## 10. What runs where

```mermaid
flowchart LR
    subgraph browser["Browser"]
        CC["7 client components<br/><i>new/form - mapping/editor -<br/>sync-panel - key-form - delete-button -<br/>accounts-panel - identity-panel</i>"]
    end

    subgraph server["Next.js server"]
        RSC["Server components<br/><i>render from the DB directly</i>"]
        RH["Route handlers<br/><i>the only mutation surface</i>"]
        FAKE["/api/fake/metrifox/*<br/>/api/oauth/mock/*<br/><i>in-app fakes over real HTTP</i>"]
    end

    subgraph outside["Outside the app"]
        W["scripts/worker.ts<br/><i>polls every 60s</i>"]
        EXT["HubSpot - Salesforce -<br/>Metrifox - Stripe"]
    end

    CC -->|fetch| RH
    RSC -->|direct read| DB[("Postgres")]
    RH --> DB
    RH --> EXT
    W -->|"POST /api/cron/sync<br/>bearer CRON_SECRET"| RH
    RH -.->|"when the fakes<br/>are enabled"| FAKE

    style FAKE fill:#eef7ee,stroke:#5a8a5a
```

Pages read state; route handlers change it. The mock provider and the Metrifox
fake are served **over real HTTP from routes inside this app**, so the real
clients run completely unchanged — real headers, real pagination, real status
codes, real failure policy. That is why the whole flow is walkable with no
credentials at all.

---

## 11. Adding things — the two recipes

**A new provider** that shares an existing credential kind:

1. `mkdir src/core/providers/<name>/` and fill in the template from §8.
2. Add scope constants and export a `ProviderDefinition`.
3. In [`bootstrap.ts`](../src/core/bootstrap.ts): `registerProvider`, add the
   provider to the relevant function's `scopesByProvider`, then
   `registerSyncHandler` and `registerFieldDiscovery`.
4. Register defaults in
   [`defaults-registry.ts`](../src/core/providers/defaults-registry.ts).

No orchestration code changes. Introducing the *first* provider of a new
credential kind is a different matter — Metrifox required splitting
`ProviderDefinition.auth` into a union and teaching the connect flow, the session
client and the refresh path about a credential that never expires. The second
API-key provider is a directory and a registration call again — Stripe was that
test, and it needed no orchestration, route or UI change, despite a differently
shaped credential (`Authorization: Bearer` plus a pinned API version, absorbed
by `authHeaders` on the session options) and cursor rather than page-number
pagination.

**A new function:** `registerFunction` with its `scopesByProvider`, and it
appears in the picker immediately — with no handler it correctly reports that no
provider supports it yet. Add a handler per provider to make it real, plus a
target schema alongside `identity-schema.ts` if it writes new record types.

---

## 12. How the tests are layered

The three suites map onto the layers above, which is the fastest way to know
where a new test belongs.

| Suite | Exercises | Needs |
|---|---|---|
| `tests/unit/` | Pure logic — mapper, crypto, SOQL, clock, scheduler policy, identity normalization, survivorship, assertions, crosswalk parsing, the mapping migration | nothing |
| `tests/property/` | The invariants that carry weight: scope isolation, provider filtering, mapping round-trip, target validation, absent-source-yields-null, upsert identity, pagination completeness, and identity's own set below | fast-check |
| `tests/integration/` | Handlers against mocked provider APIs — pagination, 429 with and without `Retry-After`, 401 then refresh then retry, field discovery — plus the resolution pass against a real database | msw, plus a throwaway Postgres schema built by `tests/global-setup.ts` |

`identity-resolution.property.test.ts` carries the properties that would be
tedious to argue by example: **totality** (every customer ends with an account),
**idempotence** (a second pass changes no partition *and* no account id),
**order-independence** (shuffling input rows yields the same partition), and
that **precedence never repartitions**.

Two things about the suite's shape are deliberate and easy to undo by accident:

- **Vitest runs test files in parallel forks against one shared Postgres
  schema.** An unscoped `findFirst` in a test is therefore a cross-test hazard,
  not a style preference. `tests/integration/identity-helpers.ts` builds an
  isolated tenant per test for exactly this reason.
- **The scheduler tick is not driven end to end.** `runScheduledSyncs` sweeps
  every integration in the database by design, so a test tick would sync and
  resolve tenants another file is mid-assertion on. `distinctOwners` is exported
  and unit-tested instead, and `resolveAfterSync` is covered against a real
  database.

`npm test` runs `tsc --noEmit` **first, as a gate**: Vitest transpiles without
typechecking, so a suite can otherwise pass green over a build that does not
compile.
