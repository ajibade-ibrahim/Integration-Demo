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
 * The internal record types the identity function writes to. Field mapping
 * targets are qualified by one of these, so a contact field can never be
 * mapped onto a customer record.
 */
export const TARGET_OBJECTS = ["customer", "contact"] as const;

export type TargetObject = (typeof TARGET_OBJECTS)[number];

export function isTargetObject(v: unknown): v is TargetObject {
  return (
    typeof v === "string" && (TARGET_OBJECTS as readonly string[]).includes(v)
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
