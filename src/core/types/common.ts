/**
 * Const-union types standing in for database enums.
 *
 * These columns are stored as `String` and validated here, a shape inherited
 * from when the tests ran on SQLite, which has no enum support through Prisma.
 * Postgres does, so native enums are now available — see the header of
 * prisma/schema.prisma for why that is a separate change. Keeping each union
 * and its runtime guard adjacent means the two cannot drift.
 */

// ---------------------------------------------------------------------------
// Integration status
// ---------------------------------------------------------------------------

export const INTEGRATION_STATUSES = [
  "pending_authorization",
  "active",
  "expired",
  "requires_reauthorization",
  "error",
] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export function isIntegrationStatus(v: unknown): v is IntegrationStatus {
  return (
    typeof v === "string" &&
    (INTEGRATION_STATUSES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Customer type
// ---------------------------------------------------------------------------

export const CUSTOMER_TYPES = [
  "prospect",
  "customer",
  "partner",
  "vendor",
] as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export function isCustomerType(v: unknown): v is CustomerType {
  return (
    typeof v === "string" && (CUSTOMER_TYPES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Target object
// ---------------------------------------------------------------------------

/**
 * Every internal record type a function can write to. Field mapping targets are
 * qualified by one of these, so a contact field can never be mapped onto a
 * customer record.
 *
 * Flat and global, while *which* of them a given function may write is not —
 * that lives in `src/core/object-schema.ts`, keyed by function name. The split
 * matters: this union is what `FieldMapping.targetObject` is validated against,
 * and a stored rule has to stay recognisable regardless of which function owns
 * it. Membership of this list means "a real object"; it does not mean "mappable
 * from the function you are currently editing".
 */
export const TARGET_OBJECTS = [
  "customer",
  "contact",
  "product",
  "offering",
  // Not `"feature"`, deliberately. This is Stripe's *attachment* of a feature
  // to a product, and `"feature"` is the name the standalone Feature object
  // should have if it is ever synced — a wrong discriminator is the expensive
  // retrofit in this codebase, so the better name is reserved rather than spent.
  // camelCase is new to this union and matches the Prisma accessor
  // (`prisma.productFeature`), which is what `findByExternalId`'s switch reads.
  "productFeature",
  "agreement",
  "subscription",
  // A line on an agreement, not on a subscription — the name is the design.
  // Salesforce has ContractLineItem, OrderItem and QuoteLineItem, and HubSpot
  // models what a deal sold as line items; a subscription is the odd case
  // where one offering link almost suffices. Naming this `subscriptionItem`
  // would be the discriminator mistake `productFeature` avoided, one table up.
  "agreementItem",
] as const;

export type TargetObject = (typeof TARGET_OBJECTS)[number];

export function isTargetObject(v: unknown): v is TargetObject {
  return (
    typeof v === "string" && (TARGET_OBJECTS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Billing interval
// ---------------------------------------------------------------------------

/**
 * How often an offering recurs.
 *
 * `one_time` is a member rather than a null, because "this price does not
 * recur" is a fact about the offering and not an absence of information. A null
 * `interval` means the provider told us nothing; `one_time` means it told us
 * there is no recurrence, and those two must not read alike in the UI.
 */
export const BILLING_INTERVALS = [
  "day",
  "week",
  "month",
  "year",
  "one_time",
] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export function isBillingInterval(v: unknown): v is BillingInterval {
  return (
    typeof v === "string" && (BILLING_INTERVALS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Agreement type and status
// ---------------------------------------------------------------------------

/**
 * Which kind of agreement a row is, and therefore which detail table holds the
 * rest of it.
 *
 * The discriminator exists from the first commit that writes an agreement, and
 * that timing is the whole point: it is the column named in `bootstrap.ts` as
 * the expensive retrofit. A subscription table built without it is one that
 * order forms and contracts have to be grafted onto later, against rows that
 * already exist and cannot say what they are.
 *
 * Only `subscription` has a provider behind it today. The other three are
 * declared because the cost of declaring them is a line each, and the cost of
 * *not* having declared them is a data migration.
 */
export const AGREEMENT_TYPES = [
  "subscription",
  "order_form",
  "contract",
  "deal",
] as const;

export type AgreementType = (typeof AGREEMENT_TYPES)[number];

export function isAgreementType(v: unknown): v is AgreementType {
  return (
    typeof v === "string" && (AGREEMENT_TYPES as readonly string[]).includes(v)
  );
}

/**
 * Where an agreement stands, in our vocabulary rather than any provider's.
 *
 * Deliberately not Stripe's eight subscription statuses. Stripe distinguishes
 * `incomplete` from `incomplete_expired` and `unpaid` from `past_due`;
 * Salesforce Contract has `Draft`/`Activated`/`Expired`; HubSpot deals have
 * user-defined pipeline stages. Mapping each onto this set is the provider's
 * job, and it is the only place a provider's vocabulary should appear.
 *
 * `expired` and `canceled` are both terminal but are not the same fact: a
 * contract that ran its term to the end is not a customer who left.
 */
export const AGREEMENT_STATUSES = [
  "draft",
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired",
] as const;

export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export function isAgreementStatus(v: unknown): v is AgreementStatus {
  return (
    typeof v === "string" &&
    (AGREEMENT_STATUSES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Agreement item type
// ---------------------------------------------------------------------------

/**
 * What kind of line an agreement item is, for providers that say.
 *
 * Most do not, and the column is nullable for that reason: null means "not
 * told", never "plan". Stripe's subscription items are undifferentiated — the
 * first is the base plan by convention alone — so its handler writes `usage`
 * for a metered price and leaves everything else unset rather than guessing.
 * Chargebee and Stigg both type their items first-class, which is what this
 * union is waiting for.
 *
 * The three members are subscription-shaped, and knowingly so: they are the
 * vocabulary of the only provider with a handler today. A contract line is
 * none of the three and will stay null until an order-form provider arrives
 * with a word of its own — at which point adding a member here is a line,
 * exactly as `AGREEMENT_TYPES` argues for its own unbuilt three.
 */
export const AGREEMENT_ITEM_TYPES = ["plan", "add_on", "usage"] as const;

export type AgreementItemType = (typeof AGREEMENT_ITEM_TYPES)[number];

export function isAgreementItemType(v: unknown): v is AgreementItemType {
  return (
    typeof v === "string" &&
    (AGREEMENT_ITEM_TYPES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Sync run status
// ---------------------------------------------------------------------------

export const SYNC_RUN_STATUSES = [
  "running",
  "success",
  "partial",
  "failed",
  "discarded",
] as const;

export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export function isSyncRunStatus(v: unknown): v is SyncRunStatus {
  return (
    typeof v === "string" &&
    (SYNC_RUN_STATUSES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Kinds of key an account can be matched on, **strongest first**.
 *
 * The array order is the strength ranking, which is why this is an ordered
 * const rather than a Set: when two accounts both match, the one matched on the
 * stronger kind wins. A hard foreign id beats an email beats a shared domain.
 *
 * `external_ref` is a foreign system's own id for the same company, e.g. a
 * Stripe customer id held on a Metrifox record. `domain` is deliberately
 * weakest — it identifies a company, while an email identifies a billing
 * relationship, so subsidiaries sharing a domain must not outrank a pair of
 * distinct addresses that separate them.
 */
export const IDENTITY_KEY_KINDS = ["external_ref", "email", "domain"] as const;

export type IdentityKeyKind = (typeof IDENTITY_KEY_KINDS)[number];

export function isIdentityKeyKind(v: unknown): v is IdentityKeyKind {
  return (
    typeof v === "string" &&
    (IDENTITY_KEY_KINDS as readonly string[]).includes(v)
  );
}

/** Rank of a key kind — lower is stronger. */
export function identityKeyStrength(kind: IdentityKeyKind): number {
  return IDENTITY_KEY_KINDS.indexOf(kind);
}

/**
 * What sort of address a key holds.
 *
 * Stored for explainability, never as a filter: role addresses like
 * `billing@` are exactly what the spec says to seed the identity table from,
 * so excluding them would discard the best evidence available. A `freemail`
 * classification is what keeps a consumer domain from ever becoming a *domain*
 * key; the email itself still matches fine.
 */
export const EMAIL_CLASSES = ["corporate", "role", "freemail"] as const;

export type EmailClass = (typeof EMAIL_CLASSES)[number];

export function isEmailClass(v: unknown): v is EmailClass {
  return (
    typeof v === "string" && (EMAIL_CLASSES as readonly string[]).includes(v)
  );
}

/** Where a key came from, for provenance in the UI and in issues. */
export const IDENTITY_EVIDENCE_SOURCES = [
  "customer_email",
  "customer_domain",
  /** Legacy `customFields.email` / `customFields.primary_email`. */
  "customer_custom_field",
  "contact_email",
  /** The customer's own provider id, contributed automatically. */
  "self_reference",
  /** A `crossRef.<provider>` mapping rule. */
  "mapped_cross_ref",
  /** An uploaded id crosswalk. */
  "imported_crosswalk",
] as const;

export type IdentityEvidenceSource =
  (typeof IDENTITY_EVIDENCE_SOURCES)[number];

export function isIdentityEvidenceSource(
  v: unknown
): v is IdentityEvidenceSource {
  return (
    typeof v === "string" &&
    (IDENTITY_EVIDENCE_SOURCES as readonly string[]).includes(v)
  );
}

/** What started a resolution pass. */
export const IDENTITY_RUN_TRIGGERS = ["sync", "scheduled", "manual"] as const;

export type IdentityRunTrigger = (typeof IDENTITY_RUN_TRIGGERS)[number];

export function isIdentityRunTrigger(v: unknown): v is IdentityRunTrigger {
  return (
    typeof v === "string" &&
    (IDENTITY_RUN_TRIGGERS as readonly string[]).includes(v)
  );
}

/**
 * A human's verdict on whether two customers are the same company.
 *
 * `distinct` matters as much as `same`. Any matcher's worst failure is a false
 * merge, and without a negative verdict a shared role address on a shared
 * agency domain would re-merge on every pass with nothing the user could do
 * about it.
 */
export const IDENTITY_ASSERTION_KINDS = ["same", "distinct"] as const;

export type IdentityAssertionKind = (typeof IDENTITY_ASSERTION_KINDS)[number];

export function isIdentityAssertionKind(
  v: unknown
): v is IdentityAssertionKind {
  return (
    typeof v === "string" &&
    (IDENTITY_ASSERTION_KINDS as readonly string[]).includes(v)
  );
}

/**
 * What went wrong, or went ambiguously, during a resolution pass.
 *
 * A discriminated union rather than one shape with optional fields, for the
 * reason `ProviderAuth` is: each kind carries genuinely different evidence, and
 * the compiler should refuse a renderer that reads `fieldName` off a key
 * conflict. The alternative — eight optional properties, three of them set at
 * any moment — pushes that check to runtime and to the reader.
 *
 * None of these abort a pass. They are the pass reporting what it could not
 * decide, in the same spirit as `RecordIssue` on a sync run: an ambiguity a
 * human can settle is worth surfacing, and worth *not* guessing at.
 */
export const IDENTITY_ISSUE_KINDS = [
  /** Two accounts claim one key. Never auto-merged; a human decides. */
  "key_claimed_elsewhere",
  /** A `distinct` assertion refused a grouping some key would have made. */
  "blocked_by_assertion",
  /** Equal-priority sources disagree on a field's value. */
  "field_conflict",
  /** A concurrent pass inserted the same key first. */
  "key_race_lost",
] as const;

export type IdentityIssueKind = (typeof IDENTITY_ISSUE_KINDS)[number];

export function isIdentityIssueKind(v: unknown): v is IdentityIssueKind {
  return (
    typeof v === "string" &&
    (IDENTITY_ISSUE_KINDS as readonly string[]).includes(v)
  );
}

export type IdentityIssue =
  | {
      kind: "key_claimed_elsewhere";
      /** Always set: every issue must be explicable without a lookup. */
      reason: string;
      customerId: string;
      keyKind: IdentityKeyKind;
      keyValue: string;
      /** The account the customer was linked to, chosen deterministically. */
      winningAccountId: string;
      /** Accounts that keep their claim on the key regardless. */
      losingAccountIds: string[];
    }
  | {
      kind: "blocked_by_assertion";
      reason: string;
      customerId: string;
      otherCustomerId: string;
      keyKind: IdentityKeyKind;
      keyValue: string;
    }
  | {
      kind: "field_conflict";
      reason: string;
      accountId: string;
      fieldName: string;
      /** The competing values, index-aligned with `integrationIds`. */
      values: string[];
      integrationIds: string[];
    }
  | {
      kind: "key_race_lost";
      reason: string;
      customerId: string;
      keyKind: IdentityKeyKind;
      keyValue: string;
    };

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A raw record as returned by a provider, before mapping. */
export type RawRecord = Record<string, unknown>;

/** A problem with one source record. Never aborts the run on its own. */
export interface RecordIssue {
  sourceRecordId: string;
  targetObject: TargetObject;
  reason: string;
  fieldName?: string;
  /** `warning` keeps the record; `rejected` drops it. */
  severity: "warning" | "rejected";
}
