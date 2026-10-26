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
  "price",
  // camelCase matches the Prisma accessor (`prisma.feature`).
  "feature",
  // The offering × feature link ("this offering includes that feature, at this
  // limit"). Separate from `feature` — the definition — because one shared
  // feature can be attached to many offerings at different limits.
  "entitlement",
  "agreement",
  "subscription",
  // A line on an agreement, not on a subscription — the name is the design.
  // Salesforce has ContractLineItem, OrderItem and QuoteLineItem, and HubSpot
  // models what a deal sold as line items; a subscription is the odd case
  // where one offering link almost suffices. Naming this `subscriptionItem`
  // would name the object after one provider's case rather than what it is.
  "agreementItem",
  // The *effective* entitlement one agreement confers — Chargebee's
  // `subscription_entitlements`. Distinct from `entitlement`, which is the
  // catalog baseline ("the Pro offering includes 50 seats"): this is what the
  // subscriber actually gets, overrides already folded in. The two overlap by
  // construction and must never be summed.
  "agreementEntitlement",
  // A discount stated on an agreement. Stated values only — no computed net.
  "agreementDiscount",
  // Billing: the document, its lines, and the money that moved. Note there is
  // deliberately no `charge` member — the word means three incompatible things
  // (an invoice line here, Chargebee's one-off item type, Stripe's own Charge
  // object), so as a placeholder it would mislead more than it documented.
  "invoice",
  "invoiceLine",
  "payment",
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
 *
 * `scheduled` is the fourth distinction and the one Chargebee and Stigg forced:
 * an agreement that is agreed but does not start yet — Chargebee `future`,
 * Stigg `NOT_STARTED`. `draft` cannot hold it, because `draft` means *never
 * agreed* (which is what Stripe's `incomplete` maps to), and putting a signed
 * future subscription there would say the opposite of the truth.
 */
export const AGREEMENT_STATUSES = [
  "draft",
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired",
  "scheduled",
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
 * `charge` is the fourth member, and the first that is not subscription-shaped:
 * it is Chargebee's third line type, a one-off amount on the same subscription.
 * It belongs to *this* union because it answers the agreement's question — what
 * kind of line is this on the subscription — and a reader that handles `add_on`
 * already knows how to skip a `charge`.
 *
 * It does **not** mean an amount on an invoice. That is a different question —
 * what kind of line is this on the bill — answered by `INVOICE_LINE_TYPES`,
 * which has a `charge` member among `discount`, `credit` and others. The two
 * unions overlap by name and must never be substituted: an invoice's discount
 * line is a `discount` there and would be stored as the wrong column if it were
 * validated against this union.
 *
 * The three subscription-shaped members are knowingly not the whole vocabulary:
 * a contract line is none of the four and will stay null until an order-form
 * provider arrives with a word of its own — at which point adding a member
 * here is a line, exactly as `AGREEMENT_TYPES` argues for its own unbuilt
 * three.
 */
export const AGREEMENT_ITEM_TYPES = [
  "plan",
  "add_on",
  "usage",
  "charge",
] as const;

export type AgreementItemType = (typeof AGREEMENT_ITEM_TYPES)[number];

export function isAgreementItemType(v: unknown): v is AgreementItemType {
  return (
    typeof v === "string" &&
    (AGREEMENT_ITEM_TYPES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Invoice, payment and invoice line
// ---------------------------------------------------------------------------

/**
 * Where an invoice stands, in our vocabulary rather than any provider's.
 *
 * Mapping is the provider's job and the handler is the only place a provider's
 * word may appear:
 *
 *   Stripe `draft`        → `draft`
 *   Stripe `open`         → `open`
 *   Stripe `paid`         → `paid`
 *   Stripe `void`         → `void`
 *   Stripe `uncollectible`→ `uncollectible`
 *   Chargebee `pending`   → `draft`      (metered-or-deferred, not issued)
 *   Chargebee `posted`    → `open`
 *   Chargebee `payment_due` → `past_due` (being retried)
 *   Chargebee `not_paid`  → `past_due`   (all attempts failed)
 *   Chargebee `paid`      → `paid`
 *   Chargebee `voided`    → `void`
 *
 * Two asymmetries are worth stating. **Chargebee has no `uncollectible`** — it
 * writes off via `write_off_amount` rather than a status — so nothing maps to
 * that member from it. And **Stripe has no `past_due` *invoice* status**, even
 * though it has a `past_due` *subscription* one; the member exists for
 * Chargebee's two retry states.
 */
export const INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "past_due",
  "void",
  "uncollectible",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function isInvoiceStatus(v: unknown): v is InvoiceStatus {
  return (
    typeof v === "string" &&
    (INVOICE_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Where a money movement stands, in our vocabulary.
 *
 * `pending` is a member because a provider can genuinely be unresolved about a
 * movement without it having failed: Stripe's charge `pending`, and Chargebee's
 * `in_progress` and `needs_attention`. The last of those is the reason the
 * member matters — "the gateway connection dropped and nobody has reconciled
 * it" is not a failure, and reporting it as one would say a payment was lost
 * that may well have succeeded.
 *
 * `reversed` is distinct from `refunded`: a refund is money deliberately sent
 * back, a reversal is a movement voided (`voided`, `payment_reversal`).
 */
export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "reversed",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(v: unknown): v is PaymentStatus {
  return (
    typeof v === "string" &&
    (PAYMENT_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Which direction a payment row moves money.
 *
 * Not nullable, unlike every other enum on the billing tables: the provider
 * never leaves it blank, there is no third possibility, and the direction is
 * the first thing a reader needs. A row that cannot say which way the money
 * went is not a payment.
 */
export const PAYMENT_KINDS = ["payment", "refund"] as const;

export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export function isPaymentKind(v: unknown): v is PaymentKind {
  return (
    typeof v === "string" && (PAYMENT_KINDS as readonly string[]).includes(v)
  );
}

/**
 * What kind of line an invoice line is, in our vocabulary.
 *
 * A union of its own rather than `AGREEMENT_ITEM_TYPES`, which is the tempting
 * reuse and the wrong one. The two answer different questions: an agreement
 * item is a line on the *subscription* (`plan`, `add_on`, `usage`, `charge`),
 * while an invoice line is a line on the *bill*, which additionally includes
 * `discount`, `credit` and `adjustment` — none of which are subscription lines.
 * Reusing the other union would silently store an invoice's discount as a
 * `charge`, which is the wrong-column failure `AGREEMENT_ITEM_TYPES`' own
 * comment warns about.
 *
 * Only Stripe's `proration` populates it today, and only because Stripe states
 * it explicitly. Null means "the provider did not say", never a guess.
 */
export const INVOICE_LINE_TYPES = [
  "plan",
  "add_on",
  "usage",
  "charge",
  "proration",
  "discount",
  "credit",
  "adjustment",
] as const;

export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];

export function isInvoiceLineType(v: unknown): v is InvoiceLineType {
  return (
    typeof v === "string" &&
    (INVOICE_LINE_TYPES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Subscription billing period
// ---------------------------------------------------------------------------

/**
 * How often a subscription's primary line recurs.
 *
 * Deliberately not `BILLING_INTERVALS`, which includes `one_time`: a
 * subscription's cadence is never one-time, so a union that can say so is
 * wider than the fact it describes. A provider that reported a one-time
 * primary line would be reporting something that is not a subscription, and
 * the handler declines rather than fitting it to this list.
 */
export const SUBSCRIPTION_BILLING_PERIODS = [
  "day",
  "week",
  "month",
  "year",
] as const;

export type SubscriptionBillingPeriod =
  (typeof SUBSCRIPTION_BILLING_PERIODS)[number];

export function isSubscriptionBillingPeriod(
  v: unknown
): v is SubscriptionBillingPeriod {
  return (
    typeof v === "string" &&
    (SUBSCRIPTION_BILLING_PERIODS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Billing model
// ---------------------------------------------------------------------------

/**
 * How a line is priced, in our vocabulary rather than any provider's.
 *
 * Stripe states it across two fields (`billing_scheme` and `recurring.usage_type`)
 * and Chargebee keeps it on the item price as `pricing_model`; the handler is
 * the only place either spelling should appear. Stigg states `billingModel`
 * directly, and is the only provider that says `minimum_spend` or
 * `credit_based`. `flat_fee` and `per_unit` are distinct because a flat line
 * bills the same regardless of quantity, which is a different commitment from a
 * per-seat one.
 */
export const BILLING_MODELS = [
  "flat_fee",
  "per_unit",
  "tiered",
  "usage_based",
  "one_time",
  "minimum_spend",
  "credit_based",
] as const;

export type BillingModel = (typeof BILLING_MODELS)[number];

export function isBillingModel(v: unknown): v is BillingModel {
  return (
    typeof v === "string" && (BILLING_MODELS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Discount
// ---------------------------------------------------------------------------

/**
 * What kind of discount a provider stated.
 *
 * `free_items` is not a monetary discount at all but the same slot in the
 * provider's vocabulary (Chargebee's `offer_quantity`-style grants); keeping it
 * here means a handler can map it instead of dropping it.
 */
export const DISCOUNT_KINDS = [
  "percentage",
  "fixed_amount",
  "free_items",
] as const;

export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export function isDiscountKind(v: unknown): v is DiscountKind {
  return (
    typeof v === "string" && (DISCOUNT_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Where a stated discount stands.
 *
 * `removed` is a lifecycle state rather than an absence: the provider applied a
 * discount and later took it off, which is different from never having had one
 * and is worth keeping for the same reason `canceled` is.
 */
export const DISCOUNT_STATUSES = [
  "active",
  "expired",
  "removed",
  "scheduled",
] as const;

export type DiscountStatus = (typeof DISCOUNT_STATUSES)[number];

export function isDiscountStatus(v: unknown): v is DiscountStatus {
  return (
    typeof v === "string" && (DISCOUNT_STATUSES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Collection method
// ---------------------------------------------------------------------------

/**
 * How a subscription is paid for, in our vocabulary.
 *
 * Three words for what providers state in more: Stripe has
 * `charge_automatically`/`send_invoice`, Chargebee an `auto_collection` boolean,
 * and Stigg `payment_collection` including `NOT_REQUIRED`. `none` exists so
 * that last case is expressible — "no collection happens" is a fact, not a
 * missing value, and folding it into null would lose it.
 */
export const COLLECTION_METHODS = ["automatic", "manual", "none"] as const;

export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export function isCollectionMethod(v: unknown): v is CollectionMethod {
  return (
    typeof v === "string" && (COLLECTION_METHODS as readonly string[]).includes(v)
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
// Sync coverage
// ---------------------------------------------------------------------------

/**
 * What one target object did during a run.
 *
 * `complete` is deliberately tri-state. `true` means the handler declared the
 * list whole on every page it yielded; `false` means it declared at least one
 * page incomplete; `null` means it never made a completeness claim. The last
 * case is common for upsert-only root objects, and reporting it as `false`
 * would turn "we did not ask for a guarantee" into "the provider failed".
 */
export interface SyncObjectCoverage {
  object: TargetObject;
  mapped: boolean;
  yielded: boolean;
  pages: number;
  recordsRead: number;
  recordsWritten: number;
  complete: boolean | null;
  warnings: number;
  rejected: number;
  /**
   * True when the handler reached the shared page guard (1000 pages) without
   * declaring the list complete. The guard is a safety net, not a successful
   * end-of-data signal; reaching it is a coverage limitation even when the
   * handler returned normally.
   */
  atPageLimit: boolean;
}

/** Coverage for one function in a run, across every object it can write. */
export interface SyncFunctionCoverage {
  functionName: string;
  objects: SyncObjectCoverage[];
  /** Mapped objects the handler never yielded a page for. */
  omittedObjects: TargetObject[];
  /** Objects the registered handler supports but the user never mapped. */
  unmappedObjects: TargetObject[];
  pages: number;
  recordsRead: number;
  recordsWritten: number;
  warnings: number;
  rejected: number;
  error?: string;
}

/** The persisted coverage report for a run. */
export interface SyncRunCoverage {
  functions: SyncFunctionCoverage[];
  /** Run-level failure, separate from per-function rejected records. */
  error?: string;
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
