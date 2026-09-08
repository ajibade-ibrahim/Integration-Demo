# Data model

Generated from [`prisma/schema.prisma`](../prisma/schema.prisma) and the
const-union types in [`src/core/types/common.ts`](../src/core/types/common.ts).
Eleven tables. Nine form one ownership spine — **everything hangs off
`Integration`** — and two hold a connect that has not finished yet, described
under [Scratch tables](#scratch-tables-for-a-connect-in-progress).

> **Also available as an interactive page** —
> [`docs/diagrams/data-model.html`](./diagrams/data-model.html): the entity diagram
> with hover-to-isolate, a control that shows what a delete cascades through, and
> the status lifecycle. Open it in a browser; it needs no server.

---

## Entity relationships

```mermaid
erDiagram
    User ||--o{ Integration : "owns"
    User ||--o{ IntegrationDraft : "has configured, not yet connected"

    Integration ||--o{ IntegrationFunction : "declares"
    Integration ||--o| OAuthToken : "authorized by"
    Integration ||--o{ FieldMapping : "configured by"
    Integration ||--o{ DiscoveredField : "caches source fields in"
    Integration ||--o{ Customer : "syncs"
    Integration ||--o{ Contact : "syncs"
    Integration ||--o{ SyncRun : "audited by"

    Customer |o--o{ Contact : "employs, link nullable"

    User {
        string id PK
        string email UK
        string passwordHash "scrypt, nullable — null cannot sign in"
        datetime createdAt
    }

    IntegrationDraft {
        string id PK "unguessable, not a UUID — it is the connect handle"
        string userId FK
        string providerName
        string functionNames "JSON array"
        string instanceLabel
        datetime expiresAt "30 minutes"
        datetime createdAt
    }

    OAuthState {
        string state PK "the value handed to the provider"
        string subjectKind "draft | integration"
        string subjectId "a draft id or an integration id — no FK, see below"
        datetime expiresAt "30 minutes"
        datetime createdAt
    }

    Integration {
        string id PK
        string userId FK
        string providerName "hubspot, salesforce, metrifox, stripe, mock"
        string status "IntegrationStatus, see state diagram"
        string instanceLabel "user-facing label"
        int syncIntervalHours "default 24, clamped 1..168"
        datetime authorizationTimestamp "null until consent completes"
        datetime lastSyncTimestamp "null until first run"
        boolean pendingTokenRevocation "revocation failed on delete"
        datetime createdAt
        datetime updatedAt
    }

    IntegrationFunction {
        string id PK
        string integrationId FK
        string functionName "identity, support, billing, usage, communication"
        datetime addedAt
    }

    OAuthToken {
        string integrationId PK "also the FK, so at most one per integration"
        string accessTokenEnc "AES-256-GCM, never logged or returned"
        string refreshTokenEnc "null for non-refreshable grants"
        datetime expiresAt
        string grantedScopes "space-joined, what consent actually gave"
        string providerMetadata "JSON, Salesforce instance_url lives here"
        datetime updatedAt
    }

    FieldMapping {
        string id PK
        string integrationId FK
        string functionName "part of the mapping identity"
        string targetObject "customer, contact"
        string sourceFieldPath "dot path into the provider payload"
        string targetFieldPath "unqualified, e.g. domain"
        string transform "none, trim, lowercase, domainFromUrl, dateOnly"
        datetime createdAt
    }

    DiscoveredField {
        string id PK
        string integrationId FK
        string functionName
        string targetObject
        string path "provider field path"
        string label "provider display name"
        string type "provider-reported type"
        datetime fetchedAt
    }

    Customer {
        string id PK
        string integrationId FK
        string externalSourceId "provider-assigned, upsert key"
        string name
        string domain
        string industry
        datetime createDate
        string type "CustomerType, nullable"
        string customFields "JSON object, max 50 keys"
        datetime updatedAt
    }

    Contact {
        string id PK
        string integrationId FK
        string externalSourceId "provider-assigned, upsert key"
        string name
        string email
        string jobTitle
        string phone
        string customerId FK "resolved internal parent, nullable"
        string externalCustomerId "provider company id, pre-resolution"
        string customFields "JSON object"
        datetime updatedAt
    }

    SyncRun {
        string id PK
        string integrationId FK
        string status "SyncRunStatus"
        string trigger "manual, scheduled"
        datetime startedAt
        datetime completedAt "null while running"
        int customerCount
        int contactCount
        int attempt "default 1"
        string errorsJson "JSON array of RecordIssue"
    }
```

### Reading the spine

`Integration` is the tenancy boundary. Every synced record, mapping rule,
discovered field, and run carries `integrationId` — which is why deleting one
integration is a clean cascade, and why no query leaks another integration's
data by omission.

`User` sits above it only for ownership, and that ownership is enforced: every
request-scoped read of an integration goes through `findIntegrationForUser`,
which puts `userId` in the `where` clause. The unscoped `findIntegration`
survives for the scheduler, which sweeps every user and has none in scope.

As shipped there is still one seeded account (see
[Known limitations](../README.md#known-limitations)) — but it is a real one now,
authenticated by Auth.js against `passwordHash`.

Two relationships carry the design load:

- **`Integration` → `IntegrationFunction` is one-to-many, not one-to-one.** A
  single HubSpot connection can serve `identity` *and* `support`. The OAuth
  scopes requested are the union across these rows, which is why the function
  set has to be known before authorization.
- **`Customer` → `Contact` is optional on the contact side.** Providers hand
  back their *own* company id, never our UUID. Customers are written first to
  build an `external → internal` index; a contact whose company will not resolve
  is kept with `customerId = null` and its `externalCustomerId` retained, so a
  later sync links it once that company arrives.

---

## Scratch tables for a connect in progress

`IntegrationDraft` and `OAuthState` are the two tables that are not user data.
Both are written by one request and read by a later one, both carry a 30-minute
`expiresAt`, and losing either costs the user a retry and nothing else.

- **`IntegrationDraft`** holds a provider and function set the user has chosen
  but not yet proven a credential for. It exists so that no `Integration` row is
  created until a credential is accepted — a rejected key leaves nothing behind.
  Consumed on success only, so a mistyped key can be re-pasted against the same
  draft.
- **`OAuthState`** holds an issued `state` value awaiting its callback, the CSRF
  defence for the authorization flow. Single-use, and the delete *is* the read:
  two concurrent callbacks bearing one state race on one row and exactly one
  wins.

Both were `Map`s on `globalThis` until they were not. Being written by `/start`
and read by `/callback` — or written by the create call and read by the connect
page — means an in-process store is invisible to every request but the one that
wrote it as soon as a second instance exists, which is how they failed on a
serverless host: every callback rejected, every draft "expired" on arrival.

`OAuthState.subjectId` deliberately has no foreign key, because it names a row
in one of two tables depending on `subjectKind`. Reading it back treats anything
other than `"draft"` as an integration, which is the branch that fails safely: it
looks for an integration that will not be found, rather than building one out of
a draft id.

---

## Referential actions

| Parent | Child | On parent delete |
|---|---|---|
| `User` | `Integration`, `IntegrationDraft` | `Cascade` |
| `Integration` | `IntegrationFunction`, `OAuthToken`, `FieldMapping`, `DiscoveredField`, `Customer`, `Contact`, `SyncRun` | `Cascade` |
| `Customer` | `Contact` | `SetNull` — the contact survives, unlinked |

`Customer` → `Contact` is deliberately not a cascade: losing a company record
should not silently delete the people attached to it.

---

## Uniqueness — where identity actually lives

| Table | Constraint | Why |
|---|---|---|
| `User` | `email` | The stable handle the demo looks the user up by. |
| `Customer` | `(integrationId, externalSourceId)` | The upsert key. Re-running a sync updates rather than duplicates. |
| `Contact` | `(integrationId, externalSourceId)` | Same. |
| `IntegrationFunction` | `(integrationId, functionName)` | A function is declared once per integration. |
| `FieldMapping` | `(integrationId, functionName, targetObject, targetFieldPath)` | One rule per target field. Function and target object are part of the identity, because two functions on one integration can write to the same object. |
| `DiscoveredField` | `(integrationId, functionName, targetObject, path)` | Cache key. |
| `OAuthToken` | `integrationId` as the primary key | Structurally at most one live token per integration. |

Indexes beyond those: `Integration(userId)` and `Integration(status)` for the
scheduler sweep, `FieldMapping(integrationId)` and
`(integrationId, functionName)`, `Customer(integrationId)`,
`Contact(integrationId)` and `Contact(customerId)`,
`SyncRun(integrationId, startedAt)` for run-history ordering, and
`IntegrationFunction(functionName)`. The scratch tables add
`IntegrationDraft(userId)`, `OAuthState(subjectKind, subjectId)` for the two
discard-by-subject paths, and `expiresAt` on both, which is what the sweep on
each write path scans.

---

## Columns that are strings but are not really strings

Both are modelled as `String` and constrained in application code. The reason
is historical: the tests used to run on SQLite, where Prisma supports neither
`enum` nor `Json`, so avoiding both was what let one schema serve SQLite
locally and Postgres in deployment.

Everything now runs Postgres, which supports both, so that constraint is gone
and promoting these columns to native `enum` / `jsonb` is available. It is a
data migration plus a sweep through the repositories and the type layer rather
than a schema edit, so it has not been done here — the guards below are still
the source of truth.

### Enum-shaped

| Column | Legal values | Guard |
|---|---|---|
| `Integration.status` | `pending_authorization`, `active`, `expired`, `requires_reauthorization`, `error` | `isIntegrationStatus` |
| `Customer.type` | `prospect`, `customer`, `partner`, `vendor`, or null | `isCustomerType` |
| `FieldMapping.targetObject` | `customer`, `contact` | `isTargetObject` |
| `SyncRun.status` | `running`, `success`, `partial`, `failed`, `discarded` | `isSyncRunStatus` |
| `FieldMapping.transform` | `none`, `trim`, `lowercase`, `domainFromUrl`, `dateOnly` | [`transforms.ts`](../src/core/field-mapper/transforms.ts) |

Each guard lives beside its union in
[`src/core/types/common.ts`](../src/core/types/common.ts), so the type and its
runtime check cannot drift.

### JSON-shaped

Read and written only through
[`json-column.ts`](../src/core/repositories/json-column.ts).

| Column | Default | Shape |
|---|---|---|
| `Customer.customFields` | `{}` | `Record<string, unknown>`, max 50 keys |
| `Contact.customFields` | `{}` | `Record<string, unknown>` |
| `OAuthToken.providerMetadata` | `{}` | Provider extras from the token response, e.g. Salesforce `instance_url` |
| `SyncRun.errorsJson` | `[]` | `RecordIssue[]` — `{ sourceRecordId, targetObject, reason, fieldName?, severity }` |
| `IntegrationDraft.functionNames` | none | `string[]` — the function names chosen, deduped and sorted before storage |

---

## `Integration.status` lifecycle

The one column with real behaviour behind it. Every write goes through
`updateStatus` or `markAuthorized` in
[`integration-repository.ts`](../src/core/repositories/integration-repository.ts).

```mermaid
stateDiagram-v2
    [*] --> active : credential proven, then the row is created

    active --> requires_reauthorization : second 401, no refresh token, or refresh failed
    active --> error : reconnect rejected, or credential write failed

    requires_reauthorization --> active : reconnected
    error --> active : reconnected

    pending_authorization --> active : rollback window only
    pending_authorization --> expired : orphaned over 30 min, scheduler sweep
```

**`pending_authorization` is nearly unreachable, and that is the point.** A row
used to be inserted as soon as the user picked a provider, which meant every
failed or abandoned connect left one behind to be deleted by hand. The
configuration is now held as a draft
([`draft-store.ts`](../src/core/integrations/draft-store.ts)) and the row is
created only once a credential is proven, so an integration is `active` from the
moment it exists. The only way to observe `pending_authorization` is a crash
inside `createIntegrationFromDraft`, between the insert and `markAuthorized`,
where the compensating delete also failed to run — which is what the scheduler
sweep still exists to retire.

A failed *reconnect* is the deliberate exception: it sets `error` and keeps the
row, because an established integration may hold edited mappings and synced
records.

Only `active` integrations sync. The scheduler
([`scheduler.ts`](../src/core/sync/scheduler.ts)) skips everything else, and
`POST /api/integrations/[id]/sync`, the fields route, and the mapping page each
gate on it independently rather than trusting the caller.

`expired` is narrower than it sounds: it means *abandoned before authorization
ever completed*, not *token past `expiresAt`*. An expired access token on a live
integration is a refresh attempt; only a **failed** refresh moves the
integration, and it moves to `requires_reauthorization`.
