/**
 * Turning mapped records into rows: validation, upsert, and resolving each
 * child record's association to its parent.
 *
 * The association is the subtle part, and it is now the same shape five times.
 * Providers hand back their *own* id for the parent — a company id on a contact
 * (HubSpot via an associations block, Salesforce via `AccountId`), a product id
 * on a price — never our internal UUID. Writing that straight into a foreign key
 * produces a dangling reference. So parents are written first, building an
 * external→internal index, and children resolve through it.
 *
 * Three families live here: customers and contacts for `identity`, products and
 * offerings for `catalog`, agreements and subscriptions for `agreement`. They
 * share `resolveAssociation` and the relink pass rather than each growing their
 * own, because a second copy of that cache-then-fall-back logic is exactly
 * where the database fallback gets quietly omitted — and the symptom of
 * omitting it is a link that vanishes on the second sync, which is not a thing
 * anyone notices quickly.
 *
 * The agreement family is where the shape stops being uniform, in two ways
 * worth knowing before reading it:
 *
 *   - An agreement has **two** parents, a customer and an offering, and neither
 *     is primary. It resolves two indexes rather than one, and an unresolved
 *     half is a warning on that half alone.
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
  isCustomerType,
  type RecordIssue,
  type TargetObject,
} from "../types/common";
import { MAX_CUSTOM_FIELDS, OBJECT_SCHEMAS } from "../object-schema";
import type { MappedRecord } from "../types/mapping";
import type { ExternalRefs } from "../types/registry";
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
type ParentModel = "customer" | "product" | "offering" | "agreement";

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
 * Shared by contact→customer, offering→product, agreement→customer,
 * agreement→offering and subscription→agreement. They differ only in which
 * table they read, and having written the same cache-then-fall-back logic five
 * times is how one of them ends up quietly missing the fallback.
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
// Product features
// ---------------------------------------------------------------------------

/**
 * Write the features each product includes.
 *
 * Modelled directly on `writeOfferings`, because the shape is the same: a
 * single-parent child keyed on `(integrationId, externalSourceId)`, whose parent
 * may or may not resolve. The validation split is the same too, and the same way
 * round — no id or no name is **rejected**, an unresolvable product is a
 * **warning** with the row kept.
 *
 * Two things are worth knowing about the parent here, and neither is visible
 * from this function alone.
 *
 * The external product id did not come from the record Stripe sent. Features are
 * read from `/v1/products/{id}/features` and the response carries no product
 * field, so the handler injected it from the URL. That means an unresolvable
 * product is a *much* stronger signal here than it is for an offering — the id
 * is one this integration listed moments earlier in the same run, so failing to
 * resolve it means the product itself was rejected by `writeProducts`, not that
 * the provider named something we had never seen.
 *
 * And there is no relink pass for the same reason: a feature cannot arrive
 * before its parent. `externalProductId` is still stored, for the warning and
 * the data browser, but `relinkOrphansForFunction("catalog")` deliberately does
 * not look at this table. See the column's comment in the schema.
 */
export async function writeProductFeatures(
  integrationId: string,
  records: readonly CollectedRecord[],
  externalToInternal: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalRefs, mapped } of records) {
    const externalProductId = externalRefs?.product;
    if (externalSourceId === undefined || externalSourceId === "") {
      issues.push({
        sourceRecordId: "(unknown)",
        targetObject: "productFeature",
        reason: "Source record has no id",
        severity: "rejected",
      });
      continue;
    }

    // Rejected rather than warned, as it is everywhere a name is required. A
    // feature with no name cannot be rendered and cannot be told apart from the
    // others in a list, and unlike a price it is not something a provider is
    // expected to leave out — Stripe will not create a feature without one, so a
    // blank name here means the mapping is wrong rather than the data thin.
    const name = normalize(
      mapped.fields["name"] ?? null,
      maxLengthOf("productFeature", "name")
    );
    if (name === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "productFeature",
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
      externalToInternal
    );

    if (externalProductId !== undefined && productId === null) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "productFeature",
        reason: `Product '${externalProductId}' not found; feature saved without a link`,
        fieldName: "associatedProductId",
        severity: "warning",
      });
    }

    const data = {
      name,
      lookupKey: normalize(
        mapped.fields["lookupKey"] ?? null,
        maxLengthOf("productFeature", "lookupKey")
      ),
      externalFeatureId: normalize(
        mapped.fields["externalFeatureId"] ?? null,
        maxLengthOf("productFeature", "externalFeatureId")
      ),
      productId,
      externalProductId: externalProductId ?? null,
      // Required rather than decorative: `resolveTargetField` validates
      // `customFields.*` for every object, so without this call a rule writing
      // one would save cleanly in the editor and then silently do nothing.
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
    };

    await prisma.productFeature.upsert({
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

    // Only the first priced line is linked to an offering, so a count above one
    // is the only thing on the row that says the rest exist. Warned every run
    // rather than once: it stays true until the subscription changes, and a
    // warning that appears once and then goes quiet reads as resolved.
    if (itemCount !== null && itemCount > 1) {
      issues.push({
        sourceRecordId: externalSourceId,
        targetObject: "subscription",
        reason: `Subscription has ${itemCount} priced items; only the first is linked to an offering`,
        fieldName: "itemCount",
        severity: "warning",
      });
    }

    const data = {
      agreementId,
      currentPeriodStart: parseDate(
        mapped.fields["currentPeriodStart"] ?? null
      ),
      currentPeriodEnd: parseDate(mapped.fields["currentPeriodEnd"] ?? null),
      trialEndsAt: parseDate(mapped.fields["trialEndsAt"] ?? null),
      canceledAt: parseDate(mapped.fields["canceledAt"] ?? null),
      cancelAtPeriodEnd: parseBoolean(
        mapped.fields["cancelAtPeriodEnd"] ?? null
      ),
      collectionMethod: normalize(
        mapped.fields["collectionMethod"] ?? null,
        maxLengthOf("subscription", "collectionMethod")
      ),
      quantity: parseInteger(mapped.fields["quantity"] ?? null),
      itemCount,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
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
 * `ProductFeature` detached at Stripe stays until the integration is deleted,
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
 */
export async function writeAgreementItems(
  integrationId: string,
  records: readonly CollectedRecord[],
  agreementIndex: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  // One per model, never shared: the index is keyed by the provider's id
  // alone, so a single map for both parents would let a subscription id
  // collide with a price id. See `resolveAssociation`.
  const offeringIndex = new Map<string, string>();

  // Our internal agreement id → the internal ids of its items written this
  // run. Only agreements appearing as keys here are reconciled, and only
  // against the ids in their set, which is the guard in its entirety.
  const writtenByAgreement = new Map<string, Set<string>>();

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

    const data = {
      agreementId,
      offeringId,
      externalOfferingId: externalOfferingId ?? null,
      quantity: parseInteger(mapped.fields["quantity"] ?? null),
      position: parseInteger(mapped.fields["position"] ?? null),
      itemType,
      // Required rather than decorative: `resolveTargetField` validates
      // `customFields.*` for every object, so without this call a rule
      // writing one saves cleanly in the editor and silently does nothing.
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
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

    written += 1;
  }

  issues.push(...(await reconcileAgreementItems(integrationId, writtenByAgreement)));

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
 * Retry the offering links agreement items were written without.
 *
 * The offering edge only. There is deliberately no agreement counterpart, for
 * `writeSubscriptions`' reason: that FK is required, so an unlinked item row
 * cannot exist to be repaired.
 *
 * Worth having where `writeProductFeatures` has none, and the difference is
 * instructive. A feature's product id comes from the URL the sync just called,
 * so it cannot arrive before its parent. An item's *offering* comes from the
 * agreement function, and the catalog function may not be on this integration
 * at all — the same situation `Agreement.offeringId` is in, repaired the same
 * way.
 */
export async function relinkOrphanedAgreementItems(
  integrationId: string
): Promise<number> {
  const orphans = await prisma.agreementItem.findMany({
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
      await prisma.agreementItem.update({
        where: { id: orphan.id },
        data: { offeringId: offering.id },
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
      const prices = await writePrices(
        integrationId,
        at("price"),
        offerings.externalToInternal
      );
      const features = await writeProductFeatures(
        integrationId,
        at("productFeature"),
        products.externalToInternal
      );
      return {
        counts: {
          product: products.written,
          offering: offerings.written,
          price: prices.written,
          productFeature: features.written,
        },
        issues: [
          ...products.issues,
          ...offerings.issues,
          ...prices.issues,
          ...features.issues,
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
        agreements.externalToInternal
      );
      return {
        counts: {
          agreement: agreements.written,
          subscription: subscriptions.written,
          agreementItem: items.written,
        },
        issues: [
          ...agreements.issues,
          ...subscriptions.issues,
          ...items.issues,
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
      // Summed across both tables. Each answers "how many rows changed", and
      // the caller wants the total for the function rather than a breakdown.
      return (
        (await relinkOrphanedAgreements(integrationId)) +
        (await relinkOrphanedAgreementItems(integrationId))
      );
    default:
      return 0;
  }
}
