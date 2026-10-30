<!--
Sync Impact Report
==================
Version change: (none) → 1.0.0
Bump rationale: Initial ratification. The scaffold was unpopulated, so this amendment
establishes the project's governing principles, constraints, workflow gates and
governance process. MAJOR is not applicable to an initial adoption; 1.0.0 marks the
first complete, enforceable constitution.

Modified principles:
- Scaffold Principle 1 → I. Function-Scoped Least Privilege
- Scaffold Principle 2 → II. Provider Isolation Through Registries
- Scaffold Principle 3 → III. Stated Facts, Never Computed or Guessed
- Scaffold Principle 4 → IV. Single-Source, Versioned Mapping Contract
- Scaffold Principle 5 → V. Owner Isolation, Secret Safety and Durable Execution

Added sections:
- Technology & Deployment Constraints (replaces the second scaffold section)
- Development Workflow & Quality Gates (replaces the third scaffold section)
- Governance (populated the scaffold governance slot)

Removed sections: none.

Deferred TODOs: none. The ratification date is the initial adoption date of this
document. This report is temporary scratch material and is removed before commit.
-->

# Integration Platform Constitution

## Core Principles

### I. Function-Scoped Least Privilege

A connection MUST declare the functions it serves before a provider is selected and
before authorization begins. The requested scopes MUST equal the exact union of the
scopes registered for each selected `(function, provider)` pair, and MUST never
include a scope for an undeclared function.

- The consent step MUST display the scopes or data the connection will actually read,
  and MUST state honestly when a credential has no consent step (for example a static
  API key) rather than implying a narrowing guarantee that cannot be enforced.
- `OAuthToken.grantedScopes` MUST record what the provider actually granted. A
  requirement that exceeds the grant MUST surface as an explicit reconnect prompt
  (`requires_reauthorization`), never as an opaque mid-sync authorization failure.
- Adding a function to a live connection MUST be treated as widening consent and MUST
  follow the reconnect path.
- A function with no supporting provider MUST remain visible and be reported as
  unsupported; it MUST NOT be hidden or silently offered.

**Rationale**: The product's distinguishing guarantee is that permissions follow
declared purpose. Any code path that requests more than the declaration, or that
understates what was requested, defeats the feature even when data syncs successfully.

### II. Provider Isolation Through Registries

`src/core/` MUST remain framework-free: it MUST NOT import from `src/app/` or from
Next.js, and it MUST NOT import the Prisma client directly. Only `src/core/repositories/`
MAY import Prisma.

- Every provider MUST live under `src/core/providers/<provider>/` and be registered in
  `src/core/bootstrap.ts`. Orchestration, API routes, UI and shared sync code MUST NOT
  branch on a provider name.
- Provider handlers MUST receive their dependencies; they MUST NOT access the database.
- Adding a provider MUST require only a provider directory plus registration. If a
  genuinely new credential kind is introduced, its differences MUST be expressed as a
  discriminated `ProviderDefinition.auth` union and absorbed at one seam (for example
  session options), not propagated as provider-specific conditionals.
- A provider integration MUST ship with its own handler tests against a mocked or
  fake provider API.

**Rationale**: The project's extensibility claim ("adding is extending, not rebuilding")
is only true while provider variance is confined to provider directories and registry
registration. Provider-name branching is where that claim silently stops holding.

### III. Stated Facts, Never Computed or Guessed

Values that belong to a provider MUST be stored as stated by that provider. The system
MUST NOT compute a figure, lifecycle state or date that the provider did not state.

- Invoice totals, agreement totals and discount values MUST be stored as provided.
  Code MUST NOT sum `InvoiceLine`, `Payment`, `AgreementItem` or any other child rows to
  produce them, and redundancy MUST NOT be "fixed" by summing.
- CRM forecasts, close dates and create timestamps MUST NOT be promoted to agreement
  status, effective date or end date. Such raw facts MAY be retained in
  `providerMetadata`.
- Unknown provider vocabulary MUST follow an explicit policy: optional enums are
  warned about and stored null; a required discriminator is rejected or given a
  documented fallback; an unknown boolean writes nothing. Field transforms are
  formatting only and MUST NOT translate provider vocabulary.
- Absence MUST NOT be treated as deletion. Upserts MUST preserve rows a provider stops
  returning unless the object is explicitly reconciled, and reconciliation MUST have
  documented gates that distinguish a truncated page from a genuinely shorter list.
- A per-record failure MUST NOT abort the run. The run MUST complete as `partial` with
  the rejected record and reason visible to the user.

**Rationale**: A computed or guessed value is indistinguishable from a stated one once
stored, and it is confidently wrong in exactly the cases users rely on. The rule is
what makes provider data trustworthy after it lands.

### IV. Single-Source, Versioned Mapping Contract

`src/core/object-schema.ts` MUST remain the single source of truth for target fields,
read by the validator, the mapping UI and the sync writer. Copies of target definitions
or parallel validation paths MUST NOT be introduced.

- Target paths MUST be object-qualified (`customer.name`, `contact.email`,
  `customer.customFields.<key>`) so a field cannot be validated against the wrong object.
- Function ownership of objects and write order MUST be declared in the schema
  (`FUNCTION_OBJECTS`, `FUNCTION_WRITE_ORDER`). Rules for an object outside the owning
  function MUST be refused, and parents MUST be written before children.
- Children MUST resolve parents through the run's external-to-internal index, falling
  back to the database for parents from earlier runs. An unresolved optional parent is
  kept with a null link and a warning; a required foreign key follows the documented
  reject policy.
- Every rule set MUST carry a content version (`v1-<sha256>`) derived from the rules,
  not their row order. A sync MUST record that version before its first provider
  request. `MAPPING_RULE_VERSION` MUST be bumped whenever a deploy changes what an
  existing rule means.
- Stored mappings MUST NOT be rewritten by a deploy. Default changes MUST be applied by
  a documented, idempotent, dry-run-by-default migration; `seedMappingsIfEmpty` MUST
  continue to preserve any existing user edit.

**Rationale**: Mapping is the contract between arbitrary provider payloads and the
project's schema. One registry prevents validator, UI and writer drift; versioning keeps
past runs explainable after the contract moves.

### V. Owner Isolation, Secret Safety and Durable Execution

Every read and write MUST be scoped to the owning user. Isolation failure is the
highest-severity defect in this system because it exposes one owner's customer data to
another.

- Authentication MUST default to deny, and HTTP API routes MUST be the only path that
  mutates data.
- Provider credentials MUST be encrypted at rest with AES-256-GCM using a
  deployment-supplied `TOKEN_ENCRYPTION_KEY`. There MUST be no built-in fallback key.
  Credentials MUST never be rendered in the UI or written to logs.
- The application MUST refuse to start without required secrets, and
  `TOKEN_ENCRYPTION_KEY` MUST be documented as non-rotatable because existing ciphertext
  is only readable under the key that wrote it.
- OAuth callbacks MUST use single-use, expiring state; a callback without a code the
  platform issued MUST be refused. The scheduled sync endpoint MUST require
  `CRON_SECRET` in production.
- Mock and fake providers MUST be environment-gated and disabled by default.
- Deleting a connection MUST proceed even if provider revocation fails; the unconfirmed
  revocation MUST be surfaced, and identity resolution MUST run against the surviving
  records.
- Exactly one sync run per integration MUST be authoritative. A run MUST claim a
  durable lease carrying owner, expiry, heartbeat and fencing token; a stale worker MUST
  stop before starting another page, function, write or reconciliation and MUST NOT
  overwrite a newer run.
- Timing and retry schedules MUST be injected through the `Clock` abstraction so they
  are asserted deterministically in tests.

**Rationale**: Credentials, tenant boundaries and concurrent workers are the failure
modes that lose or leak data at scale. Lease fencing and default-deny scoping are
non-negotiable because both fail silently when approximated.

## Technology & Deployment Constraints

- **Language**: TypeScript with `strict` and `noUncheckedIndexedAccess` enabled. Type
  errors MUST fail the build; suppressions MUST be justified at the line.
- **Application**: Next.js App Router with React; Auth.js credentials sessions; Prisma
  ORM. The stack MUST NOT be swapped without a constitution amendment.
- **Database**: PostgreSQL everywhere — development, tests and deployment. SQLite and
  build-time schema providers MUST NOT return; a Prisma client generated for one engine
  cannot serve another, and divergent engines make local success meaningless.
- **Connection strings**: both `DATABASE_URL` and `DIRECT_URL` MUST be configured.
  `DIRECT_URL` is required even without a pooler because Prisma resolves it while
  parsing the schema. Deployment behind a transaction pooler MUST include
  `?pgbouncer=true`.
- **Scheduling**: The app has no in-process scheduler. Syncs MUST be triggered by the
  cron endpoint or the provided worker. The asynchronous 202 sync response MUST NOT be
  deployed to a platform that freezes functions on response without an explicit
  amendment and a replacement execution model.
- **Schema changes**: `npm run db:push` MUST be run against the deployed database after
  every schema change, because the build generates a client but never touches the
  database. Data worth protecting requires committed Prisma migrations.
- **Configuration**: `.env.example` is the canonical list. Production MUST set
  `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` and real provider credentials;
  demo-only retry delays and fake providers MUST be raised or disabled.

## Development Workflow & Quality Gates

- **Typecheck gates tests**: `npm test` MUST run `tsc --noEmit` before Vitest, and the
  test task MUST fail if typechecking fails. Vitest alone is not acceptable verification.
- **Test layering**: `tests/unit/` covers pure logic, `tests/property/` covers
  invariants with fast-check, and `tests/integration/` covers handlers against mocked
  provider APIs plus database-backed resolution and read models.
- **Database tests**: Tests requiring a database MUST use `TEST_DATABASE_URL` with a
  non-`public` schema created and dropped by `tests/global-setup.ts`. The development
  database MUST never be touched. Because files run in parallel forks against one
  schema, tests MUST build an isolated tenant rather than relying on an unscoped query.
- **Invariants**: Changes to scope resolution, mapping round-trips, upsert identity,
  pagination completeness or identity resolution MUST preserve the corresponding
  property tests. Property tests that survive deliberate mutation MUST be strengthened,
  not accepted.
- **Provider changes**: A new or changed provider MUST include handler integration
  tests and, where a sandbox exists, fixtures whose branches are verified by
  `npm run fixtures:verify`.
- **Cross-layer changes**: A change to `src/core/object-schema.ts`, write order or
  function ownership MUST update its consumers together and MUST ship tests proving
  validator, UI options and writer still agree.
- **Review**: Every plan MUST pass the Constitution Check before Phase 0 research and
  again after Phase 1 design. Any violation MUST be recorded in Complexity Tracking with
  the simpler alternative that was rejected.
- **Documentation**: User-visible behaviour changes MUST update the README walkthroughs
  or `docs/` diagrams alongside the code.

## Governance

This constitution supersedes conflicting practices, local conventions and convenience
shortcuts. Where the code and this document disagree, the disagreement is a defect to
resolve, not a precedent.

- **Amendment procedure**: Amendments MUST be proposed as a constitution revision,
  reviewed like code, and include the version change, rationale, affected principles and
  any migration plan for existing connections or stored data. Dependent templates and
  commands read this document at runtime and are not edited by constitution amendments.
- **Versioning policy**: Semantic versioning applies. MAJOR for removal or redefinition
  of a principle; MINOR for a new principle or materially expanded guidance; PATCH for
  clarifications and non-semantic wording fixes. The version line MUST match the
  amendment report.
- **Compliance review**: Pull requests and plan reviews MUST verify compliance with the
  five principles. Deviations MUST be either corrected or explicitly justified under
  Complexity Tracking with the rejected simpler alternative. Security, tenant isolation
  and least-privilege violations MUST NOT be waived by justification.
- **Runtime guidance**: `README.md` and `docs/architecture.md` are the authoritative
  implementation guides. They MAY explain this constitution but MUST NOT override it.

**Version**: 1.0.0 | **Ratified**: 2026-10-29 | **Last Amended**: 2026-10-29
