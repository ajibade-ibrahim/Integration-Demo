/**
 * Turning mapped records into rows: validation, upsert, and resolving the
 * contact→customer association.
 *
 * The association is the subtle part. Providers hand back their *own* company
 * id on a contact — HubSpot via an associations block, Salesforce via
 * `AccountId` — never our internal UUID. Writing that straight into a foreign
 * key produces a dangling reference. So customers are written first, building
 * an external→internal index, and contacts resolve through it.
 */

import { prisma } from "@/lib/prisma";
import {
  isCustomerType,
  type RecordIssue,
  type TargetObject,
} from "../types/common";
import {
  IDENTITY_SCHEMA,
  MAX_CUSTOM_FIELDS,
} from "../identity-schema";
import type { MappedRecord } from "../types/mapping";
import { writeJsonObject } from "../repositories/json-column";

/**
 * Email shape check: a non-empty local part, an @, and a dotted domain.
 * Deliberately permissive — the goal is catching obvious rubbish, not
 * adjudicating RFC 5322.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface WriteOutcome {
  written: number;
  issues: RecordIssue[];
}

/** Trim to a field's max length, returning null for blanks. */
function normalize(value: string | null, maxLength?: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
}

function maxLengthOf(object: TargetObject, field: string): number | undefined {
  return IDENTITY_SCHEMA[object].fields.find((f) => f.name === field)?.maxLength;
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
  records: Array<{ externalSourceId: string | undefined; mapped: MappedRecord }>
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

    const data = {
      name,
      domain: normalize(mapped.fields["domain"] ?? null, maxLengthOf("customer", "domain")),
      industry: normalize(
        mapped.fields["industry"] ?? null,
        maxLengthOf("customer", "industry")
      ),
      createDate: parseDate(mapped.fields["createDate"] ?? null),
      type,
      customFields: writeJsonObject(boundedCustomFields(mapped.customFields)),
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
  records: Array<{
    externalSourceId: string | undefined;
    externalCustomerId: string | undefined;
    mapped: MappedRecord;
  }>,
  externalToInternal: Map<string, string>
): Promise<WriteOutcome> {
  const issues: RecordIssue[] = [];
  let written = 0;

  for (const { externalSourceId, externalCustomerId, mapped } of records) {
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
  if (externalCustomerId === undefined || externalCustomerId === "") return null;

  const fromThisRun = externalToInternal.get(externalCustomerId);
  if (fromThisRun !== undefined) return fromThisRun;

  const existing = await prisma.customer.findUnique({
    where: {
      integrationId_externalSourceId: {
        integrationId,
        externalSourceId: externalCustomerId,
      },
    },
    select: { id: true },
  });

  if (existing !== null) {
    // Cache it so a batch of contacts sharing a company hits the DB once.
    externalToInternal.set(externalCustomerId, existing.id);
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
