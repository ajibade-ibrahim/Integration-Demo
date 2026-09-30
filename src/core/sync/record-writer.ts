/**
 * Turning mapped records into rows: validation, upsert, and resolving each
 * child record's association to its parent.
 *
 * The association is the subtle part, and it is the same shape at every edge.
 * Providers hand back their *own* id for the parent — a company id on a contact
 * (HubSpot via an associations block, Salesforce via `AccountId`), a product id
 * on a price, a price id on an agreement's line — never our internal UUID.
 * Writing that straight into a foreign key produces a dangling reference. So
 * parents are written first, building an external→internal index, and children
 * resolve through it.
 *
 * Three families live here: customers and contacts for `identity`; products,
 * offerings, prices, feature definitions and their entitlements for `catalog`;
 * agreements, subscriptions and their line items for `agreement`. They share
 * `resolveAssociation` and the relink pass rather than each growing their own,
 * because a second copy of that cache-then-fall-back logic is exactly where the
 * database fallback gets quietly omitted — and the symptom of omitting it is a
 * link that vanishes on the second sync, which is not a thing anyone notices
 * quickly.
 *
 * The agreement family is where the shape stops being uniform, in two ways
 * worth knowing before reading it:
 *
 *   - An agreement has **two** parents, a customer and an offering, and neither
 *     is primary. It resolves two indexes rather than one, and an unresolved
 *     half is a warning on that half alone. The catalog's `entitlement` join is
 *     the same shape one function over — an offering and a feature — and is
 *     written the same way.
 *   - Both of its parents are written by *other functions*, so neither index
 *     has anything in it when the agreement writer runs. The database fallback
 *     is not an optimization there, it is the only path.
 */

import { prisma } from "@/lib/prisma";
import {
  isAgreementItemType,
  isAgreementStatus,
  isAgreementType,
  isBillingInterval,
  isBillingModel,
  isCollectionMethod,
  isCustomerType,
  isDiscountKind,
  isDiscountStatus,
  isSubscriptionBillingPeriod,
  type RecordIssue,
  type TargetObject,
} from "../types/common";
import { MAX_CUSTOM_FIELDS, OBJECT_SCHEMAS } from "../object-schema";
import type { MappedRecord } from "../types/mapping";
import type { ExternalRefs } from "../types/registry";
import { readJsonObject, writeJsonObject } from "../repositories/json-column";
// Imported rather than defined here: identity resolution matches on the same
// addresses this writer validates, and two definitions of "a valid address"
// would let the writer store something the matcher silently refuses to join on.
import { EMAIL_PATTERN } from "../identity/normalize";

export interface WriteOutcome {
  written: number;
  issues: RecordIssue[];
}

/**
 * One source record, mapped and ready to write.
 *
 * `externalRefs` holds the provider's own ids for whatever this record hangs
 * off, keyed by which relationship each is — `{ customer }` for a contact,
 * `{ product }` for an offering, `{ customer, offering }` for an agreement.
 *
 * A map rather than one id because an agreement has two parents and neither is
 * the primary one. A missing key and a present-but-undefined value mean the
 * same thing — this record claims no such relationship — so a handler may
 * return either, and root objects return an empty object.
 */
export interface CollectedRecord {
  externalSourceId: string | undefined;
  externalRefs?: ExternalRefs;
  mapped: MappedRecord;
}

/** Trim to a field's max length, returning null for blanks. */
function normalize(value: string | null, maxLength?: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
}

function maxLengthOf(object: TargetObject, field: string): number | undefined {
  return OBJECT_SCHEMAS[object].fields.find((f) => f.name === field)?.maxLength;
}

/** Cap the custom-field map and its values at the documented limits. */
function boundedCustomFields(
  customFields: Record<string, string>
): Record<string, string> {
  const entries = Object.entries(customFields).slice(0, MAX_CUSTOM_FIELDS);
  return Object.fromEntries(entries);
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface CustomerWriteResult extends WriteOutcome {
  /** Provider id → our internal id, for resolving contact associations. */
  externalToInternal: Map<string, string>;
}

export async function writeCustomers(
  integrationId: string,
  records: readonly CollectedRecord[]
): Promise<CustomerWriteResult> {
  const issues: RecordIssue[] = [];
  const externalToInternal = new Map<string, string>();
  let written = 0;

  for (const { externalSourceId, mapped } of records) {
    // Without a provider id there is no upsert key, so the record cannot be
    // reconciled on a later sync and must be refused.
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "customer",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("customer", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "customer",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    // An unrecognised type is dropped rather than failing the record — the rest
    // of the customer is still worth having, and org-specific picklist values
    // are common.
    const rawType = normalize(mapped.fields["type"] ?? null);
    let type: string | null = null;
    if (rawType !== null) {
      if (isCustomerType(rawType)) {
        type = rawType;
      } else {
        issues.push({
          sourceRecordId: externalSourceId,
          targetObject: "customer",
          reason: `Unrecognised type '${rawType}'; left unset`,
          fieldName: "type",
          severity: "warning",
        });
      }
    }

    // A malformed account email is warned about and nulled, *not* rejected —
    // the opposite of the contact policy a hundred lines down, and deliberately
    // so. A contact is rejected because an address is a person's primary
    // identifier; a customer's identity is `name` + `externalSourceId`, so
    // discarding an entire company over one bad field is worse than an empty
    // column. Same treatment `type` gets just above.
    let email = normalize(
      mapped.fields["email"] ?? null,
      maxLengthOf("customer", "email")
    );
    if (email !== null && !EMAIL_PATTERN.test(email)) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "customer",
        reason: `'${email}' is not a valid email address; left unset`,
        fieldName: "email",
        severity: "warning",
      });
      email = null;
    }

    const data = {
      name,
      domain: normalize(mapped.fields["domain"] ?? null, maxLengthOf("customer", "domain")),
      email,
      industry: normalize(
        mapped.fields["industry"] ?? null,
        maxLengthOf("customer", "industry")
      ),
      createDate: parseDate(mapped.fields["createDate"] ?? null),
      type,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      // No bound needed: `applyMappings` only fills this from a target path
      // naming a registered provider, and mapping targets are unique, so the
      // object has at most one key per provider and each value is already
      // clamped to MAX_CUSTOM_FIELD_VALUE_LENGTH.
      crossRefs: writeJsonObject(mapped.crossRefs),
    };

    const row = await prisma.customer.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    externalToInternal.set(externalSourceId, row.id);
    written += 1;
  }

  return { written, issues, externalToInternal };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function writeContacts(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternal: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalCustomerId = externalRefs?.customer;
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "contact",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("contact", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "contact",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    // A malformed email fails the record: it is the primary identifier for a
    // person, and storing a broken one poisons any later matching.
    const email = normalize(
      mapped.fields["email"] ?? null,
      maxLengthOf("contact", "email")
    );
    if (email !== null && !EMAIL_PATTERN.test(email)) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "contact",
        reason: `'${email}' is not a valid email address`,
        fieldName: "email",
        severity: "rejected",
      });
      continue;
    }

    const customerId = await resolveCustomer(
      integrationId,
      externalCustomerId,
      externalToInternal
    );

    // A contact whose company we cannot resolve is still worth keeping — it is
    // a real person, and a later sync may resolve the link once that company
    // arrives. `externalCustomerId` is retained precisely so that can happen.
    if (externalCustomerId !== undefined && customerId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "contact",
        reason: `Company '${externalCustomerId}' not found; contact saved without a link`,
        fieldName: "associatedCustomerId",
        severity: "warning",
      });
    }

    const data = {
      name,
      email,
      jobTitle: normalize(
        mapped.fields["jobTitle"] ?? null,
        maxLengthOf("contact", "jobTitle")
      ),
      phone: normalize(mapped.fields["phone"] ?? null, maxLengthOf("contact", "phone")),
      customerId,
      externalCustomerId: externalCustomerId ?? null,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    await prisma.contact.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
    });

    written += 1;
  }

  return { written, issues };
}

/**
 * Map a provider company id to our internal customer id.
 *
 * Checks the index built during this run first, then falls back to the database
 * for a customer written by an earlier run — without that fallback, a contact
 * whose company did not change would lose its link on every subsequent sync.
 */
async function resolveCustomer(
  integrationId: string,
  externalCustomerId: string | undefined,
  externalToInternal: Map<string, string>
): Promise<string | null> {
  return resolveAssociation(
    integrationId,
    "customer",
    externalCustomerId,
    externalToInternal
  );
}

/** Parent models a child record can be associated with by foreign id. */
type ParentModel =
  | "customer"
  | "product"
  | "offering"
  | "price"
  | "feature"
  | "agreement";

/**
 * Look a parent up by the provider's own id.
 *
 * An exhaustive switch, and it has to be exhaustive rather than merely a
 * switch. `prisma[model]` would need a cast to `any` and would take the
 * compiler's word for the `where` shape with it. A ternary chain — which this
 * was while there were two models — compiles silently when a third is added
 * and resolves it against whichever table the final branch happened to name,
 * so `agreement` would have quietly looked itself up in `product`. Written
 * this way, adding a member fails the build until it is handled.
 */
async function findByExternalId(
  integrationId: string,
  model: ParentModel,
  externalSourceId: string
): Promise<{ id: string } | null> {
  const where = {
    integrationId_externalSourceId: { integrationId, externalSourceId },
  };
  const select = { id: true };

  switch (model) {
    case "customer":
      return prisma.customer.findUnique({ where, select });
    case "product":
      return prisma.product.findUnique({ where, select });
    case "offering":
      return prisma.offering.findUnique({ where, select });
    case "price":
      return prisma.price.findUnique({ where, select });
    case "feature":
      return prisma.feature.findUnique({ where, select });
    case "agreement":
      return prisma.agreement.findUnique({ where, select });
  }
}

/**
 * Map a provider's own id for a parent record to our internal id.
 *
 * Checks the index built during this run first, then falls back to the database
 * for a parent written by an earlier run — without that fallback, a child whose
 * parent did not change would lose its link on every subsequent sync.
 *
 * Shared by every association in this file — contact→customer,
 * offering→product, price→offering, entitlement→offering, entitlement→feature,
 * agreement→customer, agreement→offering, agreementItem→offering,
 * agreementItem→price and subscription→agreement. They differ only in which
 * table they read, and having written the same cache-then-fall-back logic once
 * per edge is how one of them ends up quietly missing the fallback.
 *
 * **One index per model, never one shared between them.** The index is keyed by
 * the provider's id alone, so a single map passed for two models would let a
 * customer id collide with a product id that happened to match — unlikely
 * across Stripe's prefixed ids, guaranteed nowhere. Callers that resolve two
 * parents pass two maps.
 */
async function resolveAssociation(
  integrationId: string,
  model: ParentModel,
  externalId: string | undefined,
  index: Map<string, string>
): Promise<string | null> {
  if (externalId === undefined || externalId === "") return null;

  const fromThisRun = index.get(externalId);
  if (fromThisRun !== undefined) return fromThisRun;

  const existing = await findByExternalId(integrationId, model, externalId);

  if (existing !== null) {
    // Cache it so a batch of children sharing a parent hits the DB once.
    index.set(externalId, existing.id);
    return existing.id;
  }
  return null;
}

/**
 * Retry associations left unresolved by earlier runs.
 *
 * Run after customers are written: a contact that arrived before its company
 * gets linked as soon as that company exists, without waiting for the contact
 * itself to change.
 */
export async function relinkOrphanedContacts(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.contact.findMany({
    where: {
      integrationId,
      customerId: null,
      externalCustomerId: { not: null },
    },
    select: { id: true, externalCustomerId: true },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    if (orphan.externalCustomerId === null) continue;

    const customer = await prisma.customer.findUnique({
      where: {
        integrationId_externalSourceId: {
          integrationId,
          externalSourceId: orphan.externalCustomerId,
        },
      },
      select: { id: true },
    });

    if (customer !== null) {
      await prisma.contact.update({
        where: { id: orphan.id },
        data: { customerId: customer.id },
      });
      relinked += 1;
    }
  }
  return relinked;
}

// ---------------------------------------------------------------------------
// Catalog
//
// Products then offerings, mirroring customers then contacts: the parent is
// written first so the child can resolve its association through the index that
// produces. The shape is deliberately the same — an offering whose product we
// cannot find is kept with its `externalProductId` retained, exactly as an
// unlinkable contact is, so a later sync can complete the link.
// ---------------------------------------------------------------------------

/** Parse a whole number from a mapped field, or null if it is not one. */
function parseInteger(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // `Number`, not `parseInt`: `parseInt("49.99")` is 49, which would turn a
  // major-unit price into a plausible-looking minor-unit one — wrong by a factor
  // of a hundred, with nothing in the data to show for it. A non-integer is
  // refused here and warned about by the caller.
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}

/**
 * Parse a boolean from a mapped field.
 *
 * Accepts the spellings providers actually send. Anything else is null rather
 * than false — "we were not told" and "no" are different answers, and
 * `Product.active` is nullable precisely so it can hold the difference.
 */
function parseBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      return null;
  }
}

/**
 * Serialize a handler's provider bag for a `providerMetadata` column.
 *
 * The handler maps a JSON *string* — `JSON.stringify` of its provider bag — so
 * this parses that string back and re-serializes it through the same
 * `writeJsonObject` and bound `customFields` uses. Parsing rather than storing
 * the raw string unexamined is what makes a malformed value degrade to `{}`
 * instead of a row whose JSON column will not parse for any later reader.
 *
 * Over-long or over-count values are dropped silently, which the column comment
 * says: a provider bag is a convenience, not a load-bearing fact, and warning
 * every run about a chatty `meta_data` would be noise.
 */
function parseProviderMetadata(value: string | null): string {
  return writeJsonObject(boundedCustomFields(readJsonObject(value)));
}

/**
 * Read a mapped enum-like field against a union guard.
 *
 * Returns the lowercased candidate when it is a member, otherwise `null`, and
 * reports an unrecognised value through the caller's issue list. Null is the
 * right landing state either way: every one of these columns is nullable
 * *because* "the provider did not say" is a real answer, so an unreadable value
 * arrives at the same place as an omission rather than inventing a default.
 */
function parseEnum<T extends string>(
  raw: string | null,
  guard: (v: unknown) => v is T
): T | null {
  if (raw === null) return null;
  const candidate = raw.trim().toLowerCase();
  return guard(candidate) ? candidate : null;
}

export interface ProductWriteResult extends WriteOutcome {
  /** Provider id -> our internal id, for resolving offering associations. */
  externalToInternal: Map<string, string>;
}

export async function writeProducts(
  integrationId: string,
  records: readonly CollectedRecord[]
): Promise<ProductWriteResult> {
  const issues: RecordIssue[] = [];
  const externalToInternal = new Map<string, string>();
  let written = 0;

  for (const { externalSourceId, mapped } of records) {
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "product",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("product", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "product",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    const data = {
      name,
      description: normalize(
        mapped.fields["description"] ?? null,
        maxLengthOf("product", "description")
      ),
      active: parseBoolean(mapped.fields["active"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    const row = await prisma.product.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    externalToInternal.set(externalSourceId, row.id);
    written += 1;
  }

  return { written, issues, externalToInternal };
}

export interface OfferingWriteResult extends WriteOutcome {
  /** Provider id -> our internal id, for resolving price associations. */
  externalToInternal: Map<string, string>;
}

export async function writeOfferings(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternalProduct: Map<string, string>
): Promise<OfferingWriteResult> {
  const issues: RecordIssue[] = [];
  const externalToInternal = new Map<string, string>();
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalProductId = externalRefs?.product;
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "offering",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("offering", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "offering",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    const productId = await resolveAssociation(
      integrationId,
      "product",
      externalProductId,
      externalToInternalProduct
    );

    if (externalProductId !== undefined && productId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "offering",
        reason: `Product '${externalProductId}' not found; offering saved without a link`,
        fieldName: "associatedProductId",
        severity: "warning",
      });
    }

    const data = {
      name,
      description: normalize(
        mapped.fields["description"] ?? null,
        maxLengthOf("offering", "description")
      ),
      productId,
      externalProductId: externalProductId ?? null,
      active: parseBoolean(mapped.fields["active"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    const row = await prisma.offering.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    externalToInternal.set(externalSourceId, row.id);
    written += 1;
  }

  return { written, issues, externalToInternal };
}

export async function writePrices(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternalOffering: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalOfferingId = externalRefs?.offering;
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "price",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("price", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "price",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    const rawAmount = mapped.fields["amountMinor"] ?? null;
    const amountMinor = parseInteger(rawAmount);
    if (rawAmount !== null && rawAmount.trim() !== "" && amountMinor === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "price",
        reason: `'${rawAmount}' is not a whole number of minor units; left unset`,
        fieldName: "amountMinor",
        severity: "warning",
      });
    }

    const rawInterval = normalize(mapped.fields["interval"] ?? null);
    let interval: string | null = null;
    if (rawInterval !== null) {
      const candidate = rawInterval.toLowerCase();
      if (isBillingInterval(candidate)) {
        interval = candidate;
      } else {
        issues.push({
          sourceRecordId: externalSourceId,
          targetObject: "price",
          reason: `Unrecognised billing interval '${rawInterval}'; left unset`,
          fieldName: "interval",
          severity: "warning",
        });
      }
    }

    const offeringId = await resolveAssociation(
      integrationId,
      "offering",
      externalOfferingId,
      externalToInternalOffering
    );

    if (externalOfferingId !== undefined && offeringId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "price",
        reason: `Offering '${externalOfferingId}' not found; price saved without a link`,
        fieldName: "associatedOfferingId",
        severity: "warning",
      });
    }

    const data = {
      name,
      offeringId,
      externalOfferingId: externalOfferingId ?? null,
      amountMinor,
      currency: normalize(
        mapped.fields["currency"] ?? null,
        maxLengthOf("price", "currency")
      ),
      interval,
      intervalCount: parseInteger(mapped.fields["intervalCount"] ?? null),
      active: parseBoolean(mapped.fields["active"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    await prisma.price.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
    });

    written += 1;
  }

  return { written, issues };
}

export async function relinkOrphanedPrices(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.price.findMany({
    where: {
      integrationId,
      offeringId: null,
      externalOfferingId: { not: null },
    },
    select: { id: true, externalOfferingId: true },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    if (orphan.externalOfferingId === null) continue;

    const offering = await findByExternalId(
      integrationId,
      "offering",
      orphan.externalOfferingId
    );

    if (offering !== null) {
      await prisma.price.update({
        where: { id: orphan.id },
        data: { offeringId: offering.id },
      });
      relinked += 1;
    }
  }
  return relinked;
}

/**
 * Retry offering->product associations left unresolved by earlier runs.
 *
 * The catalog counterpart of `relinkOrphanedContacts`, run after products are
 * written for the same reason: an offering that arrived before its product gets
 * linked as soon as that product exists, without waiting for the offering
 * itself to change.
 */
export async function relinkOrphanedOfferings(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.offering.findMany({
    where: {
      integrationId,
      productId: null,
      externalProductId: { not: null },
    },
    select: { id: true, externalProductId: true },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    if (orphan.externalProductId === null) continue;

    const product = await findByExternalId(
      integrationId,
      "product",
      orphan.externalProductId
    );

    if (product !== null) {
      await prisma.offering.update({
        where: { id: orphan.id },
        data: { productId: product.id },
      });
      relinked += 1;
    }
  }
  return relinked;
}

// ---------------------------------------------------------------------------
// Feature definitions and entitlements
//
// Two writers, because the two things are two things. `writeFeatureDefinitions`
// is a root writer shaped like `writeProducts`. `writeEntitlements` is the join,
// shaped like `writeAgreements`: it resolves **two** parents, an offering and a
// feature, each through its own index.
//
// The relative order of the two parents is what makes the join safe without a
// relink pass. `writeFeatureDefinitions` runs first and builds the feature
// index, and the offerings were written earlier still by `writeOfferings`, so
// both halves are in hand before an entitlement resolves. A missing half
// therefore means that parent was rejected, not that it is yet to arrive — the
// argument `writeAgreements` makes.
// ---------------------------------------------------------------------------

export interface FeatureDefinitionWriteResult extends WriteOutcome {
  /** Provider definition id → our internal id, for resolving entitlements. */
  externalToInternal: Map<string, string>;
}

/**
 * Write the reusable feature definitions.
 *
 * Modelled on `writeProducts`: a root object keyed on
 * `(integrationId, externalSourceId)`, no parent to resolve. Round and round
 * like every other root writer, and rejecting the same two things: a record
 * with no provider id, and one with no name. Both are load-bearing here
 * because a `feature` page is emitted by some handlers even when nothing is
 * mapped to the object's non-name fields.
 */
export async function writeFeatureDefinitions(
  integrationId: string,
  records: readonly CollectedRecord[]
): Promise<FeatureDefinitionWriteResult> {
  const issues: RecordIssue[] = [];
  const externalToInternal = new Map<string, string>();
  let written = 0;

  for (const { externalSourceId, mapped } of records) {
    // Without a provider id there is no upsert key, so the record cannot be
    // reconciled on a later sync and must be refused.
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "feature",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("feature", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "feature",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    const data = {
      name,
      lookupKey: normalize(
        mapped.fields["lookupKey"] ?? null,
        maxLengthOf("feature", "lookupKey")
      ),
      isMetered: parseBoolean(mapped.fields["isMetered"] ?? null),
      unit: normalize(
        mapped.fields["unit"] ?? null,
        maxLengthOf("feature", "unit")
      ),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    const row = await prisma.feature.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    externalToInternal.set(externalSourceId, row.id);
    written += 1;
  }

  return { written, issues, externalToInternal };
}

/**
 * Write the offering × feature links, and the limit each carries.
 *
 * Modelled on `writeAgreements`, which is the existing two-parent writer. Two
 * indexes, one per model — see `resolveAssociation` for why sharing one map
 * between two models is a collision waiting to happen. Each half resolves and
 * warns independently: an entitlement whose offering resolved and whose feature
 * did not is a real, readable row, and saying "unresolved" about the whole
 * thing would be wrong about half of it. The row is kept either way, with the
 * provider's own id retained beside the null so the link is still visible.
 *
 * `value` is stored verbatim and mirrored into `limitValue` when it is a whole
 * number. A non-numeric `value` is **not** a warning: Chargebee sends a boolean
 * feature as the string "true", which is an ordinary entitlement rather than a
 * malformed one, and a warning written every run on every flag would be noise
 * rather than a signal.
 */
export async function writeEntitlements(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternalFeature: Map<string, string>,
  externalToInternalOffering: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalOfferingId = externalRefs?.offering;
    const externalFeatureId = externalRefs?.feature;

    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "entitlement",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const offeringId = await resolveAssociation(
      integrationId,
      "offering",
      externalOfferingId,
      externalToInternalOffering
    );
    const featureId = await resolveAssociation(
      integrationId,
      "feature",
      externalFeatureId,
      externalToInternalFeature
    );

    if (externalOfferingId !== undefined && offeringId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "entitlement",
        reason: `Offering '${externalOfferingId}' not found; entitlement saved without a link`,
        fieldName: "associatedOfferingId",
        severity: "warning",
      });
    }

    if (externalFeatureId !== undefined && featureId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "entitlement",
        reason: `Feature '${externalFeatureId}' not found; entitlement saved without a link`,
        fieldName: "associatedFeatureId",
        severity: "warning",
      });
    }

    const value = normalize(
      mapped.fields["value"] ?? null,
      maxLengthOf("entitlement", "value")
    );

    // The numeric form, from whichever of the two the mapping set. `limitValue`
    // is its own mappable field so a provider whose limit travels under another
    // name can still fill it; the fallback to `value` means a rule set that maps
    // only the raw string still gets the number.
    //
    // A non-numeric result is left null rather than warned about — see the doc
    // comment above.
    const limitValue = parseInteger(
      mapped.fields["limitValue"] ?? mapped.fields["value"] ?? null
    );

    const data = {
      featureId,
      externalFeatureId: externalFeatureId ?? null,
      offeringId,
      externalOfferingId: externalOfferingId ?? null,
      value,
      valueName: normalize(
        mapped.fields["valueName"] ?? null,
        maxLengthOf("entitlement", "valueName")
      ),
      limitValue,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    await prisma.entitlement.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
    });

    written += 1;
  }

  return { written, issues };
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

export interface AgreementWriteResult extends WriteOutcome {
  /** Provider id → our internal id, for resolving subscription associations. */
  externalToInternal: Map<string, string>;
}

/**
 * Write agreements: the shared commercial node, whatever type it is.
 *
 * Unlike every other writer here this one resolves **two** parents, and both
 * belong to other functions — the customer to `identity`, the offering to
 * `catalog`. Three consequences follow, and none of them are bugs:
 *
 *   - Two indexes, created empty and local. Neither function's run index is in
 *     scope, so both start cold and fill from the database as rows are written.
 *     They still earn their keep: a hundred subscriptions on one customer read
 *     that customer once.
 *   - Each half warns independently. An agreement whose customer resolved and
 *     whose offering did not is a real, useful row, and saying "unresolved"
 *     about the whole thing would be wrong about half of it.
 *   - An agreement on an integration that serves neither other function links
 *     to nothing at all, permanently, and that is the documented cost of
 *     letting the functions stay independent. The relink pass catches it the
 *     moment either one is added.
 */
export async function writeAgreements(
  integrationId: string,
  records: readonly CollectedRecord[]
): Promise<AgreementWriteResult> {
  const issues: RecordIssue[] = [];
  const externalToInternal = new Map<string, string>();
  // One per model. Sharing a single map between them would let a customer id
  // collide with an offering id — see `resolveAssociation`.
  const customerIndex = new Map<string, string>();
  const offeringIndex = new Map<string, string>();
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalCustomerId = externalRefs?.customer;
    const externalOfferingId = externalRefs?.offering;

    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "agreement",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    // Rejected, as it is for every other object with a required name. A Stripe
    // subscription has no name of its own, so the handler synthesizes one —
    // without that, this branch would reject every subscription in the account
    // on every sync, and the only evidence would be a `partial` run status.
    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("agreement", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreement",
        reason: "Name is required",
        fieldName: "name",
        severity: "rejected",
      });
      continue;
    }

    // The discriminator is required in the database, so unlike `status` below
    // it cannot simply be left unset. An unreadable one falls back to
    // `subscription` *and says so*, because the alternative — rejecting the
    // row — throws away a real agreement over a label, and the alternative to
    // that — a nullable column — is the shapeless table this design exists to
    // avoid.
    const rawType = normalize(mapped.fields["agreementType"] ?? null);
    let agreementType = "subscription";
    if (rawType !== null) {
      const candidate = rawType.toLowerCase();
      if (isAgreementType(candidate)) {
        agreementType = candidate;
      } else {
        issues.push({
          sourceRecordId: externalSourceId,
          targetObject: "agreement",
          reason: `Unrecognised agreement type '${rawType}'; recorded as subscription`,
          fieldName: "agreementType",
          severity: "warning",
        });
      }
    }

    // Warned and left unset, the policy `customer.type` and
    // `offering.interval` get: an agreement whose status we cannot read is
    // still an agreement, and a wrong status is worse than a missing one.
    const rawStatus = normalize(mapped.fields["status"] ?? null);
    let status: string | null = null;
    if (rawStatus !== null) {
      const candidate = rawStatus.toLowerCase();
      if (isAgreementStatus(candidate)) {
        status = candidate;
      } else {
        issues.push({
          sourceRecordId: externalSourceId,
          targetObject: "agreement",
          reason: `Unrecognised agreement status '${rawStatus}'; left unset`,
          fieldName: "status",
          severity: "warning",
        });
      }
    }

    const customerId = await resolveAssociation(
      integrationId,
      "customer",
      externalCustomerId,
      customerIndex
    );
    if (externalCustomerId !== undefined && customerId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreement",
        reason: `Customer '${externalCustomerId}' not found; agreement saved without a link`,
        fieldName: "associatedCustomerId",
        severity: "warning",
      });
    }

    const offeringId = await resolveAssociation(
      integrationId,
      "offering",
      externalOfferingId,
      offeringIndex
    );
    if (externalOfferingId !== undefined && offeringId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreement",
        reason: `Offering '${externalOfferingId}' not found; agreement saved without a link`,
        fieldName: "associatedOfferingId",
        severity: "warning",
      });
    }

    const data = {
      name,
      agreementType,
      status,
      customerId,
      externalCustomerId: externalCustomerId ?? null,
      offeringId,
      externalOfferingId: externalOfferingId ?? null,
      effectiveDate: parseDate(mapped.fields["effectiveDate"] ?? null),
      endDate: parseDate(mapped.fields["endDate"] ?? null),
      currency: normalize(
        mapped.fields["currency"] ?? null,
        maxLengthOf("agreement", "currency")
      ),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      providerMetadata: parseProviderMetadata(
        mapped.fields["providerMetadata"] ?? null
      ),
    };

    const row = await prisma.agreement.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    externalToInternal.set(externalSourceId, row.id);
    written += 1;
  }

  return { written, externalToInternal, issues };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Write the recurring-billing half of an agreement.
 *
 * The one child writer that **rejects** an unresolved parent instead of keeping
 * the row. Every other association here is nullable and worth preserving: an
 * offering without its product is still a price someone can read. A
 * subscription row without its agreement is a set of dates about nothing — the
 * column is required, the foreign key cascades, and there is no page that could
 * render it.
 *
 * That is affordable precisely because it cannot happen by accident. Both rows
 * come off the same source record in the same run, and agreements are written
 * first, so a missing parent means the parent was itself rejected — and then
 * rejecting the child is the consistent answer rather than a harsh one.
 */
export async function writeSubscriptions(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternal: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalAgreementId = externalRefs?.agreement;

    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "subscription",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const agreementId = await resolveAssociation(
      integrationId,
      "agreement",
      externalAgreementId,
      externalToInternal
    );

    if (agreementId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "subscription",
        reason:
          externalAgreementId === undefined
            ? "Subscription claims no agreement; nothing to attach it to"
            : `Agreement '${externalAgreementId}' was not written; subscription detail dropped`,
        fieldName: "associatedAgreementId",
        severity: "rejected",
      });
      continue;
    }

    const itemCount = parseInteger(mapped.fields["itemCount"] ?? null);

    // Every line is stored now, each with its own price and offering — so this
    // no longer warns about data that is missing. What it still says is that
    // the *summary* is one line: the agreement links the first line's offering
    // and its price column shows that one figure, so a count above one is what
    // tells a reader that $49/month is not the whole of what is billed. Warned
    // every run rather than once: it stays true until the subscription changes,
    // and a warning that appears once and then goes quiet reads as resolved.
    if (itemCount !== null && itemCount > 1) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "subscription",
        reason: `Subscription has ${itemCount} priced items; the agreement shows the first one's price`,
        fieldName: "itemCount",
        severity: "warning",
      });
    }

    // Warned and left unset, the policy `agreement.status` gets below: a
    // subscription whose cadence or collection method we cannot read is still a
    // subscription, and a wrong value is worse than a missing one. Both are
    // nullable for exactly this landing state.
    const rawCollectionMethod = normalize(mapped.fields["collectionMethod"] ?? null);
    const collectionMethod = parseEnum(
      rawCollectionMethod,
      isCollectionMethod
    );
    if (rawCollectionMethod !== null && collectionMethod === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "subscription",
        reason: `Unrecognised collection method '${rawCollectionMethod}'; left unset`,
        fieldName: "collectionMethod",
        severity: "warning",
      });
    }

    const rawBillingPeriod = normalize(mapped.fields["billingPeriod"] ?? null);
    const billingPeriod = parseEnum(
      rawBillingPeriod,
      isSubscriptionBillingPeriod
    );
    if (rawBillingPeriod !== null && billingPeriod === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "subscription",
        reason: `Unrecognised billing period '${rawBillingPeriod}'; left unset`,
        fieldName: "billingPeriod",
        severity: "warning",
      });
    }

    const data = {
      agreementId,
      currentPeriodStart: parseDate(
        mapped.fields["currentPeriodStart"] ?? null
      ),
      currentPeriodEnd: parseDate(mapped.fields["currentPeriodEnd"] ?? null),
      trialStartsAt: parseDate(mapped.fields["trialStartsAt"] ?? null),
      trialEndsAt: parseDate(mapped.fields["trialEndsAt"] ?? null),
      canceledAt: parseDate(mapped.fields["canceledAt"] ?? null),
      cancelAt: parseDate(mapped.fields["cancelAt"] ?? null),
      nextBillingAt: parseDate(mapped.fields["nextBillingAt"] ?? null),
      cancelAtPeriodEnd: parseBoolean(
        mapped.fields["cancelAtPeriodEnd"] ?? null
      ),
      billingPeriod,
      billingPeriodCount: parseInteger(
        mapped.fields["billingPeriodCount"] ?? null
      ),
      collectionMethod,
      quantity: parseInteger(mapped.fields["quantity"] ?? null),
      itemCount,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      providerMetadata: parseProviderMetadata(
        mapped.fields["providerMetadata"] ?? null
      ),
    };

    await prisma.subscription.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
    });

    written += 1;
  }

  return { written, issues };
}

/**
 * Retry agreement associations left unresolved by earlier runs.
 *
 * Two edges rather than one, which changes the shape from the contact and
 * offering versions: the query is an `OR` over both, and a single row can be
 * relinked on both halves in one pass. It is counted **once** in that case,
 * because the count answers "how many rows changed" and a row that gained two
 * links is still one row.
 *
 * There is deliberately no subscription counterpart. Its parent FK is required,
 * so an unlinked subscription row cannot exist to be repaired.
 */
export async function relinkOrphanedAgreements(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.agreement.findMany({
    where: {
      integrationId,
      OR: [
        { customerId: null, externalCustomerId: { not: null } },
        { offeringId: null, externalOfferingId: { not: null } },
      ],
    },
    select: {
      id: true,
      customerId: true,
      externalCustomerId: true,
      offeringId: true,
      externalOfferingId: true,
    },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    const data: { customerId?: string; offeringId?: string } = {};

    if (orphan.customerId === null && orphan.externalCustomerId !== null) {
      const customer = await findByExternalId(
        integrationId,
        "customer",
        orphan.externalCustomerId
      );
      if (customer !== null) data.customerId = customer.id;
    }

    if (orphan.offeringId === null && orphan.externalOfferingId !== null) {
      const offering = await findByExternalId(
        integrationId,
        "offering",
        orphan.externalOfferingId
      );
      if (offering !== null) data.offeringId = offering.id;
    }

    if (Object.keys(data).length === 0) continue;

    await prisma.agreement.update({ where: { id: orphan.id }, data });
    relinked += 1;
  }
  return relinked;
}

// ---------------------------------------------------------------------------
// Agreement items
// ---------------------------------------------------------------------------

/**
 * Write an agreement's priced lines, and remove the ones that are gone.
 *
 * **This is the only writer in the system that deletes.** Everything else is
 * upsert-only, and the gaps that leaves are documented rather than repaired: a
 * `Feature` attachment detached at Stripe stays until the integration is deleted,
 * because absence is not observable from a list we only ever add to. Items are
 * the exception, and the reason is worth stating precisely — a removed add-on
 * that lingers does not merely go stale, it makes the line list *wrong*, and
 * nothing else on the agreement contradicts it. A reader would see four lines
 * on a three-line subscription and have no way to tell which was the ghost.
 *
 * Two guards make that affordable, and they fail in opposite directions on
 * purpose.
 *
 * **The handler's obligation.** `SyncHandler` requires that a handler yielding
 * any item for an agreement yields *all* of them, or fails. Stripe's inlines
 * only the first ten and pages `/v1/subscription_items` for the rest; a
 * handler that truncated instead would have this function delete every line
 * past the tenth, every run. That contract is the load-bearing one and it
 * lives where implementers will read it.
 *
 * **This function's own guard**, which assumes the obligation is broken
 * anyway: reconcile an agreement only if **at least one of its items was
 * successfully written this run**. A subscription always has a line, so the
 * guard costs nothing in the normal case — and it means an empty page, a
 * rejected parent, a subscription filtered out of this run, or a handler bug
 * that yields nothing can none of them delete a thing. The destructive
 * direction is closed; the harmless one, a stale row surviving an extra run,
 * is left open deliberately.
 *
 * A **second, optional** guard arrived with the completeness flag: a caller may
 * pass `SourcePage.complete` for this object, and a `false` withholds
 * reconciliation even for agreements that did write a line. Chargebee needs it,
 * because a list response can omit `subscription_items` altogether — under the
 * wrote-at-least-one guard alone that would merely leave those agreements
 * unreconciled, but stating the flag makes the withholding explicit rather than
 * incidental. `undefined` preserves the historical behaviour exactly.
 */
export async function writeAgreementItems(
  integrationId: string,
  records: readonly CollectedRecord[],
  agreementIndex: Map<string, string>,
  /**
   * `SourcePage.complete` for `agreementItem`, when a caller declared one.
   * `undefined` — a bare-map caller — leaves the historical guard alone; `false`
   * withholds reconciliation entirely.
   */
  completeFlag?: boolean
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  // One per model, never shared: the index is keyed by the provider's id
  // alone, so a single map for these three parents would let a subscription id
  // collide with a price id. See `resolveAssociation`.
  const offeringIndex = new Map<string, string>();
  const priceIndex = new Map<string, string>();

  // Our internal agreement id → the internal ids of its items written this
  // run. Only agreements appearing as keys here are reconciled, and only
  // against the ids in their set, which is the guard in its entirety.
  const writtenByAgreement = new Map<string, Set<string>>();

  // How many `plan`-typed lines each agreement carries this run, and the
  // provider's own id for it so the warning can name the agreement rather than
  // an internal UUID. Decision 4: the handler nominates the primary line, and
  // two plan lines is the state that makes "which plan is this subscription"
  // unanswerable — warned about rather than resolved by an arbitrary pick.
  const planLinesByAgreement = new Map<
    string,
    { externalAgreementId: string | undefined; count: number }
  >();

  for (const { externalSourceId, externalRefs, mapped } of records) {
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "agreementItem",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const externalAgreementId = externalRefs?.agreement;
    const agreementId = await resolveAssociation(
      integrationId,
      "agreement",
      externalAgreementId,
      agreementIndex
    );

    // Rejected rather than warned, as it is for `writeSubscriptions`: the
    // column is required and the foreign key cascades, so there is no row to
    // save. Both come off one source record in one run with agreements
    // written first, so an unresolvable parent means the parent was itself
    // rejected — and dropping the child is then the consistent answer.
    if (agreementId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementItem",
        reason:
          externalAgreementId === undefined
            ? "Line item claims no agreement; nothing to attach it to"
            : `Agreement '${externalAgreementId}' was not written; line item dropped`,
        fieldName: "associatedAgreementId",
        severity: "rejected",
      });
      continue;
    }

    const externalOfferingId = externalRefs?.offering;
    const offeringId = await resolveAssociation(
      integrationId,
      "offering",
      externalOfferingId,
      offeringIndex
    );

    if (externalOfferingId !== undefined && offeringId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementItem",
        reason: `Offering '${externalOfferingId}' not found; line item saved without a link`,
        fieldName: "associatedOfferingId",
        severity: "warning",
      });
    }

    // The price, resolved independently of the offering above. Both come off
    // the one nested price object and normally resolve together, but they are
    // separate columns for the reason the schema gives: an offering has several
    // prices, and only this edge says which of them was sold. Warned on its own
    // for the same reason the agreement warns about each parent separately — a
    // line whose price we could not find is still a real line.
    const externalPriceId = externalRefs?.price;
    const priceId = await resolveAssociation(
      integrationId,
      "price",
      externalPriceId,
      priceIndex
    );

    if (externalPriceId !== undefined && priceId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementItem",
        reason: `Price '${externalPriceId}' not found; line item saved without a price`,
        fieldName: "associatedPriceId",
        severity: "warning",
      });
    }

    // Warned and left unset, the policy every enum on this function gets: a
    // line whose type we cannot read is still a line, and a wrong type is
    // worse than a missing one. Null already means "the provider did not
    // say", so an unreadable value lands in exactly the right state.
    const rawItemType = normalize(mapped.fields["itemType"] ?? null);
    let itemType: string | null = null;
    if (rawItemType !== null) {
      const candidate = rawItemType.toLowerCase();
      if (isAgreementItemType(candidate)) {
        itemType = candidate;
      } else {
        issues.push({
          sourceRecordId: externalSourceId,
          targetObject: "agreementItem",
          reason: `Unrecognised line type '${rawItemType}'; left unset`,
          fieldName: "itemType",
          severity: "warning",
        });
      }
    }

    // Same policy as `itemType`: a line whose billing model we cannot read is
    // still a line, and null already means "the provider did not say". Stripe
    // synthesizes one; Chargebee leaves it null because metering lives on the
    // item price it does not inline.
    const rawBillingModel = normalize(mapped.fields["billingModel"] ?? null);
    const billingModel = parseEnum(rawBillingModel, isBillingModel);
    if (rawBillingModel !== null && billingModel === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementItem",
        reason: `Unrecognised billing model '${rawBillingModel}'; left unset`,
        fieldName: "billingModel",
        severity: "warning",
      });
    }

    const data = {
      agreementId,
      offeringId,
      externalOfferingId: externalOfferingId ?? null,
      priceId,
      externalPriceId: externalPriceId ?? null,
      quantity: parseInteger(mapped.fields["quantity"] ?? null),
      position: parseInteger(mapped.fields["position"] ?? null),
      itemType,
      billingModel,
      unitPriceMinor: parseInteger(mapped.fields["unitPriceMinor"] ?? null),
      freeQuantity: parseInteger(mapped.fields["freeQuantity"] ?? null),
      billingCycles: parseInteger(mapped.fields["billingCycles"] ?? null),
      // Required rather than decorative: `resolveTargetField` validates
      // `customFields.*` for every object, so without this call a rule
      // writing one saves cleanly in the editor and silently does nothing.
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      providerMetadata: parseProviderMetadata(
        mapped.fields["providerMetadata"] ?? null
      ),
    };

    const row = await prisma.agreementItem.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    const seen = writtenByAgreement.get(agreementId) ?? new Set<string>();
    seen.add(row.id);
    writtenByAgreement.set(agreementId, seen);

    if (itemType === "plan") {
      const plans = planLinesByAgreement.get(agreementId) ?? {
        externalAgreementId,
        count: 0,
      };
      plans.count += 1;
      planLinesByAgreement.set(agreementId, plans);
    }

    written += 1;
  }

  for (const plans of planLinesByAgreement.values()) {
    if (plans.count > 1) {
      issues.push({
        sourceRecordId: plans.externalAgreementId ?? "(unknown)",
        targetObject: "agreementItem",
        reason: `Agreement has ${plans.count} plan lines; the primary one is ambiguous`,
        fieldName: "itemType",
        severity: "warning",
      });
    }
  }

  // The second guard, and it only ever tightens. `completeFlag === false`
  // means the handler could not promise this run's item list was whole — the
  // Chargebee case, where a list response may omit `subscription_items`
  // entirely — and reconciliation is withheld for the object. `undefined`
  // (a bare-map caller from before the flag existed) leaves the
  // wrote-at-least-one guard doing the whole job, which is how it always ran.
  if (completeFlag !== false) {
    issues.push(
      ...(await reconcileAgreementItems(integrationId, writtenByAgreement))
    );
  }

  return { written, issues };
}

/**
 * Delete the lines an agreement no longer has.
 *
 * Runs only over agreements that produced at least one written item, which is
 * the guard described above — an agreement absent from this map keeps every
 * row it has, whatever the reason for its absence.
 *
 * Reported rather than silent. A run that removed rows should name the
 * agreement and the count, because this is the one place a sync can lose data
 * and "the numbers changed and nothing said why" is the failure this codebase
 * warns about everywhere else. `warning` rather than a new severity: the
 * union is `"warning" | "rejected"`, only `rejected` degrades a run to
 * `partial`, and a correct reconciliation is not a partial run.
 */
async function reconcileAgreementItems(
  integrationId: string,
  writtenByAgreement: ReadonlyMap<string, Set<string>>
): Promise<RecordIssue[]> {
  const issues: RecordIssue[] = [];

  for (const [agreementId, keptIds] of writtenByAgreement) {
    const { count } = await prisma.agreementItem.deleteMany({
      where: {
        integrationId,
        agreementId,
        id: { notIn: [...keptIds] },
      },
    });

    if (count > 0) {
      issues.push({
        sourceRecordId: agreementId,
        targetObject: "agreementItem",
        reason: `${count} line item${count === 1 ? "" : "s"} no longer on this agreement; removed`,
        severity: "warning",
      });
    }
  }

  return issues;
}

/**
 * Retry the offering and price links agreement items were written without.
 *
 * Two edges rather than one, the shape `relinkOrphanedAgreements` has: each is
 * repaired independently and a row that gained both is counted **once**, since
 * the count answers "how many rows changed". There is deliberately no agreement
 * counterpart, for `writeSubscriptions`' reason: that FK is required, so an
 * unlinked item row cannot exist to be repaired.
 *
 * Worth having where `writeEntitlements` has none, and the difference is
 * instructive. An entitlement's offering and feature both come from the catalog
 * function and are written earlier in the same run, so neither can arrive before
 * the other. An item's offering *and* its price also both come from the catalog
 * function, but the catalog function may not be on this integration at all —
 * the same situation `Agreement.offeringId` is in, repaired the same way.
 */
export async function relinkOrphanedAgreementItems(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.agreementItem.findMany({
    where: {
      integrationId,
      OR: [
        { offeringId: null, externalOfferingId: { not: null } },
        { priceId: null, externalPriceId: { not: null } },
      ],
    },
    select: {
      id: true,
      offeringId: true,
      externalOfferingId: true,
      priceId: true,
      externalPriceId: true,
    },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    const data: { offeringId?: string; priceId?: string } = {};

    if (orphan.offeringId === null && orphan.externalOfferingId !== null) {
      const offering = await findByExternalId(
        integrationId,
        "offering",
        orphan.externalOfferingId
      );
      if (offering !== null) data.offeringId = offering.id;
    }

    if (orphan.priceId === null && orphan.externalPriceId !== null) {
      const price = await findByExternalId(
        integrationId,
        "price",
        orphan.externalPriceId
      );
      if (price !== null) data.priceId = price.id;
    }

    if (Object.keys(data).length === 0) continue;

    await prisma.agreementItem.update({ where: { id: orphan.id }, data });
    relinked += 1;
  }
  return relinked;
}

// ---------------------------------------------------------------------------
// Agreement entitlements and discounts
//
// The two children added last, and the first child writers whose rows can
// legitimately be *absent* rather than merely unchanged. `writeAgreementItems`
// could get away with "reconcile any agreement that produced at least one row"
// because a subscription always has a line; an entitlement list or a discount
// list can honestly be empty, so "produced nothing" and "the handler never got
// here" have to be told apart by something other than a record count. That
// something is `SourcePage.complete` (see `SyncHandler`), and the gate below is
// where it is honoured.
// ---------------------------------------------------------------------------

/**
 * What the writer needs to decide whether it may delete.
 *
 * Both halves are required, and they answer different questions.
 * `mapped` — a mapping rule targets this object, so the handler was asked to
 * fetch it; an object with no rule never yields records, and "no records"
 * must not read as "no entitlements". `complete` — the handler declared that
 * what it yielded is the whole list for every parent it covered, ANDed across
 * pages by the engine.
 *
 * `writtenAgreementIds` bounds *which* parents are considered at all: only the
 * agreements this run wrote. An agreement from an earlier run that this run
 * missed keeps every child row it has, whatever the reason for its absence.
 */
export interface GatedReconcileContext {
  readonly writtenAgreementIds: ReadonlySet<string>;
  readonly mapped: boolean;
  readonly complete: boolean;
}

/**
 * Delete the child rows an agreement no longer has — only when both gates are
 * open, and never for an agreement this run did not write.
 *
 * Shared by entitlements and discounts because the shape is identical and the
 * alternative is the reconciliation predicate drifting between two copies. The
 * caller passes the keys written this run; an agreement absent from that map is
 * treated as having kept nothing, so an agreement that legitimately has zero
 * rows loses its stale ones.
 *
 * Reported rather than silent, on `reconcileAgreementItems`' terms: this is a
 * place a sync can lose data, so the run has to say what it removed.
 */
async function reconcileGatedChildren(
  integrationId: string,
  object: "agreementEntitlement" | "agreementDiscount",
  writtenByAgreement: ReadonlyMap<string, Set<string>>,
  ctx: GatedReconcileContext
): Promise<RecordIssue[]> {
  // Either gate absent means no deletion at all. Defaulting to "do not
  // reconcile" is the whole safety argument: the worst case is a stale row,
  // never a vanished live one.
  if (!ctx.mapped || !ctx.complete) return [];

  const issues: RecordIssue[] = [];
  const noun = object === "agreementEntitlement" ? "entitlement" : "discount";

  for (const agreementId of ctx.writtenAgreementIds) {
    const keptIds = writtenByAgreement.get(agreementId) ?? new Set<string>();
    const where = {
      integrationId,
      agreementId,
      id: { notIn: [...keptIds] },
    };

    const { count } =
      object === "agreementEntitlement"
        ? await prisma.agreementEntitlement.deleteMany({ where })
        : await prisma.agreementDiscount.deleteMany({ where });

    if (count > 0) {
      issues.push({
        sourceRecordId: agreementId,
        targetObject: object,
        reason: `${count} ${noun}${count === 1 ? "" : "s"} no longer on this agreement; removed`,
        severity: "warning",
      });
    }
  }

  return issues;
}

/**
 * Write an agreement's effective entitlements.
 *
 * Shaped like `writeEntitlements` — two parents, each resolved through its own
 * index and warned about independently — with one difference that matters: the
 * feature half is *optional*, because `catalog` may not be on this integration
 * at all. The row is kept with `externalFeatureId` retained, exactly as an
 * unlinkable `Offering.productId` is, and `relinkOrphanedAgreementEntitlements`
 * repairs it the moment the catalog arrives.
 *
 * The agreement half is required and rejecting, on `writeSubscriptions`'
 * reasoning: the foreign key cascades and a row without its agreement describes
 * nothing. Both rows come off one source record in one run with agreements
 * written first, so an unresolvable agreement means that agreement was itself
 * rejected.
 */
export async function writeAgreementEntitlements(
  integrationId: string,
  records: readonly CollectedRecord[],
  agreementIndex: Map<string, string>,
  reconcile: GatedReconcileContext
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  const featureIndex = new Map<string, string>();
  const writtenByAgreement = new Map<string, Set<string>>();

  for (const { externalSourceId, externalRefs, mapped } of records) {
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "agreementEntitlement",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const externalAgreementId = externalRefs?.agreement;
    const agreementId = await resolveAssociation(
      integrationId,
      "agreement",
      externalAgreementId,
      agreementIndex
    );

    if (agreementId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementEntitlement",
        reason:
          externalAgreementId === undefined
            ? "Entitlement claims no agreement; nothing to attach it to"
            : `Agreement '${externalAgreementId}' was not written; entitlement dropped`,
        fieldName: "associatedAgreementId",
        severity: "rejected",
      });
      continue;
    }

    const externalFeatureId = externalRefs?.feature;
    const featureId = await resolveAssociation(
      integrationId,
      "feature",
      externalFeatureId,
      featureIndex
    );

    if (externalFeatureId !== undefined && featureId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementEntitlement",
        reason: `Feature '${externalFeatureId}' not found; entitlement saved without a link`,
        fieldName: "associatedFeatureId",
        severity: "warning",
      });
    }

    const value = normalize(
      mapped.fields["value"] ?? null,
      maxLengthOf("agreementEntitlement", "value")
    );

    // The numeric form, from whichever of the two the mapping set, on
    // `writeEntitlements`' terms: a non-numeric `value` (Chargebee's boolean
    // features arrive as "true") is an ordinary entitlement, not a warning.
    const limitValue = parseInteger(
      mapped.fields["limitValue"] ?? mapped.fields["value"] ?? null
    );

    const data = {
      agreementId,
      featureId,
      externalFeatureId: externalFeatureId ?? null,
      value,
      valueName: normalize(
        mapped.fields["valueName"] ?? null,
        maxLengthOf("agreementEntitlement", "valueName")
      ),
      limitValue,
      isOverride: parseBoolean(mapped.fields["isOverride"] ?? null),
      isEnabled: parseBoolean(mapped.fields["isEnabled"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      providerMetadata: parseProviderMetadata(
        mapped.fields["providerMetadata"] ?? null
      ),
    };

    const row = await prisma.agreementEntitlement.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    const seen = writtenByAgreement.get(agreementId) ?? new Set<string>();
    seen.add(row.id);
    writtenByAgreement.set(agreementId, seen);

    written += 1;
  }

  issues.push(
    ...(await reconcileGatedChildren(
      integrationId,
      "agreementEntitlement",
      writtenByAgreement,
      reconcile
    ))
  );

  return { written, issues };
}

/**
 * Write the discounts stated on an agreement.
 *
 * One parent, the agreement — required and rejecting, for
 * `writeAgreementEntitlements`' reason — and no association to resolve beyond
 * it. Every field is stated verbatim: `kind` and `status` are translated by the
 * handler into our vocabulary before mapping, so the writer validates them
 * against the union and warns on anything else, the policy every enum here
 * gets.
 */
export async function writeAgreementDiscounts(
  integrationId: string,
  records: readonly CollectedRecord[],
  agreementIndex: Map<string, string>,
  reconcile: GatedReconcileContext
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  const writtenByAgreement = new Map<string, Set<string>>();

  for (const { externalSourceId, externalRefs, mapped } of records) {
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "agreementDiscount",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    const externalAgreementId = externalRefs?.agreement;
    const agreementId = await resolveAssociation(
      integrationId,
      "agreement",
      externalAgreementId,
      agreementIndex
    );

    if (agreementId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementDiscount",
        reason:
          externalAgreementId === undefined
            ? "Discount claims no agreement; nothing to attach it to"
            : `Agreement '${externalAgreementId}' was not written; discount dropped`,
        fieldName: "associatedAgreementId",
        severity: "rejected",
      });
      continue;
    }

    const rawKind = normalize(mapped.fields["kind"] ?? null);
    const kind = parseEnum(rawKind, isDiscountKind);
    if (rawKind !== null && kind === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementDiscount",
        reason: `Unrecognised discount kind '${rawKind}'; left unset`,
        fieldName: "kind",
        severity: "warning",
      });
    }

    const rawStatus = normalize(mapped.fields["status"] ?? null);
    const status = parseEnum(rawStatus, isDiscountStatus);
    if (rawStatus !== null && status === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "agreementDiscount",
        reason: `Unrecognised discount status '${rawStatus}'; left unset`,
        fieldName: "status",
        severity: "warning",
      });
    }

    const data = {
      agreementId,
      externalCouponId: normalize(
        mapped.fields["externalCouponId"] ?? null,
        maxLengthOf("agreementDiscount", "externalCouponId")
      ),
      label: normalize(
        mapped.fields["label"] ?? null,
        maxLengthOf("agreementDiscount", "label")
      ),
      kind,
      percentOff: parseInteger(mapped.fields["percentOff"] ?? null),
      amountOffMinor: parseInteger(mapped.fields["amountOffMinor"] ?? null),
      status,
      startsAt: parseDate(mapped.fields["startsAt"] ?? null),
      endsAt: parseDate(mapped.fields["endsAt"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
      providerMetadata: parseProviderMetadata(
        mapped.fields["providerMetadata"] ?? null
      ),
    };

    const row = await prisma.agreementDiscount.upsert({
      where: {
        integrationId_externalSourceId: { integrationId, externalSourceId },
      },
      create: { integrationId, externalSourceId, ...data },
      update: data,
      select: { id: true },
    });

    const seen = writtenByAgreement.get(agreementId) ?? new Set<string>();
    seen.add(row.id);
    writtenByAgreement.set(agreementId, seen);

    written += 1;
  }

  issues.push(
    ...(await reconcileGatedChildren(
      integrationId,
      "agreementDiscount",
      writtenByAgreement,
      reconcile
    ))
  );

  return { written, issues };
}

/**
 * Retry the feature links agreement entitlements were written without.
 *
 * One edge, unlike the agreement-item counterpart, because the only nullable
 * association here is the feature; the agreement edge is required and cannot be
 * an orphan. Worth having where `writeEntitlements` needs none: that writer's
 * two parents both come from `catalog`, written earlier in the same run, but an
 * agreement entitlement's feature belongs to a different function that may not
 * be on the integration yet.
 */
export async function relinkOrphanedAgreementEntitlements(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.agreementEntitlement.findMany({
    where: {
      integrationId,
      featureId: null,
      externalFeatureId: { not: null },
    },
    select: { id: true, externalFeatureId: true },
  });

  let relinked = 0;
  for (const orphan of orphans) {
    if (orphan.externalFeatureId === null) continue;

    const feature = await findByExternalId(
      integrationId,
      "feature",
      orphan.externalFeatureId
    );

    if (feature !== null) {
      await prisma.agreementEntitlement.update({
        where: { id: orphan.id },
        data: { featureId: feature.id },
      });
      relinked += 1;
    }
  }
  return relinked;
}

// ---------------------------------------------------------------------------
// Per-function dispatch
// ---------------------------------------------------------------------------

export interface FunctionWriteResult {
  /**
   * Rows written, per target object. An object this run produced none of is
   * absent rather than zero — "the catalog sync wrote no customers" is not a
   * fact worth recording, and `SyncRun.recordCountsJson` is shaped to say so.
   */
  counts: Partial<Record<TargetObject, number>>;
  issues: RecordIssue[];
}

/**
 * What a function's writers need beyond the records themselves.
 *
 * An options object rather than more positional parameters, because the last
 * two travel together and are meaningless apart: both exist only to decide
 * whether a writer may delete. Callers that predate the completeness signal pass
 * the bare collected map instead — see the overload — and get the old
 * upsert-only behaviour for the gated objects.
 */
export interface FunctionWriteInput {
  readonly collected: ReadonlyMap<TargetObject, CollectedRecord[]>;
  /** Objects a mapping rule targets this run. Absent objects are never reconciled. */
  readonly mappedObjects: ReadonlySet<TargetObject>;
  /** `SourcePage.complete`, ANDed per object. Absent means "never declared". */
  readonly complete: ReadonlyMap<TargetObject, boolean>;
}

/**
 * Write everything one function collected, parents before children.
 *
 * A switch rather than a loop over `objectsForFunction`, because the writers
 * genuinely do not share a signature: `writeContacts`, `writeOfferings` and
 * `writeSubscriptions` each need the index their parent writer produced, and a
 * uniform interface that passed every index to every writer would be a worse
 * lie than this switch is a repetition. The *order* inside each branch must
 * still match `objectsForFunction`; `tests/integration/catalog-writer.test.ts`
 * pins it by building the collected map child-first and asserting the link
 * still resolves.
 *
 * For `agreement` the order is not merely an optimization: a subscription's
 * agreement id is a required column, so a child written before its parent is
 * rejected outright rather than saved unlinked.
 *
 * @throws If the function has no writers. The sync engine resolves a handler
 *   before reaching here, so that is a registration mistake rather than a user
 *   error, and it should be loud.
 */
export async function writeRecordsForFunction(
  integrationId: string,
  functionName: string,
  input: FunctionWriteInput
): Promise<FunctionWriteResult>;
export async function writeRecordsForFunction(
  integrationId: string,
  functionName: string,
  collected: ReadonlyMap<TargetObject, CollectedRecord[]>
): Promise<FunctionWriteResult>;
export async function writeRecordsForFunction(
  integrationId: string,
  functionName: string,
  input:
    | FunctionWriteInput
    | ReadonlyMap<TargetObject, CollectedRecord[]>
): Promise<FunctionWriteResult> {
  // A bare map is the pre-completeness call shape. It cannot express "this
  // object's list is complete", so the gated writers reconcile nothing — the
  // safe default — while the item writer keeps the guard it has always had.
  const isOptions = "collected" in input && !(input instanceof Map);
  const collected = isOptions
    ? (input as FunctionWriteInput).collected
    : (input as ReadonlyMap<TargetObject, CollectedRecord[]>);
  const complete = isOptions
    ? (input as FunctionWriteInput).complete
    : undefined;
  const mappedObjects = isOptions
    ? (input as FunctionWriteInput).mappedObjects
    : undefined;

  const at = (object: TargetObject): readonly CollectedRecord[] =>
    collected.get(object) ?? [];

  switch (functionName) {
    case "identity": {
      const customers = await writeCustomers(integrationId, at("customer"));
      const contacts = await writeContacts(
        integrationId,
        at("contact"),
        customers.externalToInternal
      );
      return {
        counts: { customer: customers.written, contact: contacts.written },
        issues: [...customers.issues, ...contacts.issues],
      };
    }

    case "catalog": {
      const products = await writeProducts(integrationId, at("product"));
      const offerings = await writeOfferings(
        integrationId,
        at("offering"),
        products.externalToInternal
      );
      const prices = await writePrices(
        integrationId,
        at("price"),
        offerings.externalToInternal
      );
      const features = await writeFeatureDefinitions(
        integrationId,
        at("feature")
      );
      const entitlements = await writeEntitlements(
        integrationId,
        at("entitlement"),
        features.externalToInternal,
        offerings.externalToInternal
      );
      return {
        counts: {
          product: products.written,
          offering: offerings.written,
          price: prices.written,
          feature: features.written,
          entitlement: entitlements.written,
        },
        issues: [
          ...products.issues,
          ...offerings.issues,
          ...prices.issues,
          ...features.issues,
          ...entitlements.issues,
        ],
      };
    }

    case "agreement": {
      // Both counts come from the same source records — one Stripe
      // subscription yields an agreement row and a subscription row — so this
      // reports `{ agreement: 5, subscription: 5 }` for five subscriptions
      // rather than five of one thing. The identity branch above already
      // behaves this way for Stripe, whose contacts are derived from its
      // customers, so the run report is consistent about it.
      const agreements = await writeAgreements(integrationId, at("agreement"));

      // Captured *now*, before the child writers run. They share the index and
      // cache database lookups into it, so by the time the last one finishes it
      // holds agreements this run never wrote. Reconciliation must only ever
      // consider the ones it did, so the set is taken while it still means that.
      const writtenAgreementIds = new Set(agreements.externalToInternal.values());

      // Both children resolve against the *same* agreement index, and each is
      // passed the map rather than a copy so the items benefit from any
      // database lookups the subscriptions pass already cached.
      const subscriptions = await writeSubscriptions(
        integrationId,
        at("subscription"),
        agreements.externalToInternal
      );
      const items = await writeAgreementItems(
        integrationId,
        at("agreementItem"),
        agreements.externalToInternal,
        // The item writer keeps its own "wrote at least one line" guard, and
        // additionally honours the completeness flag when a caller supplies
        // one. Absent (a bare-map caller) leaves that guard alone.
        complete?.get("agreementItem")
      );

      const entitlementReconcile: GatedReconcileContext = {
        writtenAgreementIds,
        mapped:
          mappedObjects === undefined ||
          mappedObjects.has("agreementEntitlement"),
        complete: complete?.get("agreementEntitlement") === true,
      };
      const discountReconcile: GatedReconcileContext = {
        writtenAgreementIds,
        mapped:
          mappedObjects === undefined || mappedObjects.has("agreementDiscount"),
        complete: complete?.get("agreementDiscount") === true,
      };

      const entitlements = await writeAgreementEntitlements(
        integrationId,
        at("agreementEntitlement"),
        agreements.externalToInternal,
        entitlementReconcile
      );
      const discounts = await writeAgreementDiscounts(
        integrationId,
        at("agreementDiscount"),
        agreements.externalToInternal,
        discountReconcile
      );

      return {
        counts: {
          agreement: agreements.written,
          subscription: subscriptions.written,
          agreementItem: items.written,
          agreementEntitlement: entitlements.written,
          agreementDiscount: discounts.written,
        },
        issues: [
          ...agreements.issues,
          ...subscriptions.issues,
          ...items.issues,
          ...entitlements.issues,
          ...discounts.issues,
        ],
      };
    }

    default:
      throw new Error(
        `No record writers registered for function '${functionName}'`
      );
  }
}

/**
 * Retry the associations one function left unresolved on earlier runs.
 *
 * Silent for a function with nothing to relink, unlike the writer above: a
 * function may legitimately have no parent/child pair, whereas one with no
 * writers at all cannot have got this far.
 */
export async function relinkOrphansForFunction(
  integrationId: string,
  functionName: string
): Promise<number> {
  switch (functionName) {
    case "identity":
      return relinkOrphanedContacts(integrationId);
    case "catalog":
      return (
        (await relinkOrphanedOfferings(integrationId)) +
        (await relinkOrphanedPrices(integrationId))
      );
    case "agreement":
      // Summed across the tables that have a nullable edge. Each answers "how
      // many rows changed", and the caller wants the total for the function
      // rather than a breakdown. Subscriptions have none, their agreement FK
      // being required; discounts likewise, having only that one parent.
      return (
        (await relinkOrphanedAgreements(integrationId)) +
        (await relinkOrphanedAgreementItems(integrationId)) +
        (await relinkOrphanedAgreementEntitlements(integrationId))
      );
    default:
      return 0;
  }
}
