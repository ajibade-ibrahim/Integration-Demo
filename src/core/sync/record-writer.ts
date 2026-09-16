/**
 * Turning mapped records into rows: validation, upsert, and resolving each
 * child record's association to its parent.
 *
 * The association is the subtle part, and it is now the same shape twice.
 * Providers hand back their *own* id for the parent — a company id on a contact
 * (HubSpot via an associations block, Salesforce via `AccountId`), a product id
 * on a price — never our internal UUID. Writing that straight into a foreign key
 * produces a dangling reference. So parents are written first, building an
 * external→internal index, and children resolve through it.
 *
 * Two families live here: customers and contacts for `identity`, products and
 * offerings for `catalog`. They share `resolveAssociation` and the relink pass
 * rather than each growing their own, because a second copy of that
 * cache-then-fall-back logic is exactly where the database fallback gets quietly
 * omitted — and the symptom of omitting it is a link that vanishes on the second
 * sync, which is not a thing anyone notices quickly.
 */

import { prisma } from "@/lib/prisma";
import {
  isBillingInterval,
  isCustomerType,
  type RecordIssue,
  type TargetObject,
} from "../types/common";
import { MAX_CUSTOM_FIELDS, OBJECT_SCHEMAS } from "../object-schema";
import type { MappedRecord } from "../types/mapping";
import { writeJsonObject } from "../repositories/json-column";
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
 * `externalParentId` is the provider's own id for whatever this record hangs
 * off — the company for a contact, the product for an offering. Optional, and
 * absent means the same as undefined: this record claims no parent. Root
 * objects simply never set it.
 */
export interface CollectedRecord {
  externalSourceId: string | undefined;
  externalParentId?: string | undefined;
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

  for (const {
    externalSourceId,
    externalParentId: externalCustomerId,
    mapped,
  } of records) {
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
type ParentModel = "customer" | "product";

/**
 * Look a parent up by the provider's own id.
 *
 * A switch rather than an indexed delegate, because Prisma's model delegates
 * are distinct types: `prisma[model]` would need a cast to `any` and would take
 * the compiler's word for the `where` shape with it.
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

  return model === "customer"
    ? prisma.customer.findUnique({ where, select })
    : prisma.product.findUnique({ where, select });
}

/**
 * Map a provider's own id for a parent record to our internal id.
 *
 * Checks the index built during this run first, then falls back to the database
 * for a parent written by an earlier run — without that fallback, a child whose
 * parent did not change would lose its link on every subsequent sync.
 *
 * Shared by contact→customer and offering→product. The two associations differ
 * only in which table they read, and having written the same cache-then-fall-back
 * logic twice is how one of them ends up quietly missing the fallback.
 */
async function resolveAssociation(
  integrationId: string,
  model: ParentModel,
  externalParentId: string | undefined,
  index: Map<string, string>
): Promise<string | null> {
  if (externalParentId === undefined || externalParentId === "") return null;

  const fromThisRun = index.get(externalParentId);
  if (fromThisRun !== undefined) return fromThisRun;

  const existing = await findByExternalId(integrationId, model, externalParentId);

  if (existing !== null) {
    // Cache it so a batch of children sharing a parent hits the DB once.
    index.set(externalParentId, existing.id);
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

export async function writeOfferings(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternal: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalParentId, mapped } of records) {
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "offering",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    // Rejected rather than warned, as it is for a customer and a product: a
    // price with no name is not something a catalog page can render, and a
    // provider whose price records carry no name is expected to synthesize one
    // in its handler rather than leave the writer to invent it.
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

    // Every field below is warned about and left unset rather than rejecting
    // the row — the policy `customer.type` gets, for the same reason: an
    // offering with an unreadable amount is still a real offering, and dropping
    // it would lose the name, the currency and the interval along with it.
    const rawAmount = mapped.fields["amountMinor"] ?? null;
    const amountMinor = parseInteger(rawAmount);
    if (rawAmount !== null && rawAmount.trim() !== "" && amountMinor === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "offering",
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
          targetObject: "offering",
          reason: `Unrecognised billing interval '${rawInterval}'; left unset`,
          fieldName: "interval",
          severity: "warning",
        });
      }
    }

    const productId = await resolveAssociation(
      integrationId,
      "product",
      externalParentId,
      externalToInternal
    );

    if (externalParentId !== undefined && productId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "offering",
        reason: `Product '${externalParentId}' not found; offering saved without a link`,
        fieldName: "associatedProductId",
        severity: "warning",
      });
    }

    const data = {
      name,
      productId,
      externalProductId: externalParentId ?? null,
      amountMinor,
      currency: normalize(
        mapped.fields["currency"] ?? null,
        maxLengthOf("offering", "currency")
      ),
      interval,
      intervalCount: parseInteger(mapped.fields["intervalCount"] ?? null),
      active: parseBoolean(mapped.fields["active"] ?? null),
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    await prisma.offering.upsert({
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
 * Write everything one function collected, parents before children.
 *
 * A switch rather than a loop over `objectsForFunction`, because the writers
 * genuinely do not share a signature: `writeContacts` and `writeOfferings` each
 * need the index their parent writer produced, and a uniform interface that
 * passed every index to every writer would be a worse lie than this switch is a
 * repetition. The *order* inside each branch must still match
 * `objectsForFunction`; `tests/integration/catalog-writer.test.ts` pins it by
 * building the collected map child-first and asserting the link still resolves.
 *
 * @throws If the function has no writers. The sync engine resolves a handler
 *   before reaching here, so that is a registration mistake rather than a user
 *   error, and it should be loud.
 */
export async function writeRecordsForFunction(
  integrationId: string,
  functionName: string,
  collected: ReadonlyMap<TargetObject, CollectedRecord[]>
): Promise<FunctionWriteResult> {
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
      return {
        counts: { product: products.written, offering: offerings.written },
        issues: [...products.issues, ...offerings.issues],
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
      return relinkOrphanedOfferings(integrationId);
    default:
      return 0;
  }
}
