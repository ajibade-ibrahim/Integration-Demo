/**
 * Upsert identity.
 *
 * The invariant that makes re-syncing safe: a record arriving again under the
 * same provider id must *update* the existing row, not create a second one, and
 * must keep the internal id it already had. Break it and every sync either
 * duplicates the org or silently reissues ids — and reissued ids orphan every
 * contact pointing at them, because the foreign key holds the old value.
 *
 * Property-tested rather than example-tested because the failure depends on
 * arrangement: which records repeat, which change, and in what order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { prisma } from "@/lib/prisma";
import {
  writeAgreements,
  writeContacts,
  writeCustomers,
  writeOfferings,
  writeProducts,
} from "@/core/sync/record-writer";
import type { MappedRecord } from "@/core/types/mapping";

const USER_ID = "user-upsert-property";
const INTEGRATION_ID = "integration-upsert-property";

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "upsert@example.test" },
    update: {},
  });
  await prisma.integration.upsert({
    where: { id: INTEGRATION_ID },
    create: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "mock",
      status: "active",
      instanceLabel: "Upsert property",
    },
    update: {},
  });
});

beforeEach(async () => {
  // Children before parents: every one of these FKs is either SetNull or
  // Cascade, so the order only matters for keeping the intent readable.
  await prisma.subscription.deleteMany({
    where: { integrationId: INTEGRATION_ID },
  });
  await prisma.agreement.deleteMany({
    where: { integrationId: INTEGRATION_ID },
  });
  await prisma.offering.deleteMany({ where: { integrationId: INTEGRATION_ID } });
  await prisma.product.deleteMany({ where: { integrationId: INTEGRATION_ID } });
  await prisma.contact.deleteMany({ where: { integrationId: INTEGRATION_ID } });
  await prisma.customer.deleteMany({ where: { integrationId: INTEGRATION_ID } });
});

afterAll(async () => {
  await prisma.integration.delete({ where: { id: INTEGRATION_ID } }).catch(() => {
    // Already gone; nothing to clean up.
  });
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

function customerRecord(
  externalSourceId: string,
  name: string
): { externalSourceId: string; mapped: MappedRecord } {
  return {
    externalSourceId,
    mapped: {
      object: "customer",
      fields: { name, domain: `${externalSourceId}.example` },
      customFields: {},
      crossRefs: {},
    },
  };
}

/** Distinct provider ids — a duplicate id within one page is a different case. */
const externalIds = fc
  .uniqueArray(
    fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() !== ""),
    { minLength: 1, maxLength: 12 }
  )
  .map((ids) => ids.map((id) => id.trim()))
  .filter((ids) => new Set(ids).size === ids.length);

describe("Property: upsert identity", () => {
  it("re-syncing the same records preserves every internal id and row count", async () => {
    await fc.assert(
      fc.asyncProperty(externalIds, async (ids) => {
        await prisma.customer.deleteMany({
          where: { integrationId: INTEGRATION_ID },
        });

        const first = await writeCustomers(
          INTEGRATION_ID,
          ids.map((id) => customerRecord(id, `Name ${id}`))
        );
        expect(first.written).toBe(ids.length);

        const before = await prisma.customer.findMany({
          where: { integrationId: INTEGRATION_ID },
          select: { id: true, externalSourceId: true },
        });

        // Second run: same ids, different field values.
        await writeCustomers(
          INTEGRATION_ID,
          ids.map((id) => customerRecord(id, `Renamed ${id}`))
        );

        const after = await prisma.customer.findMany({
          where: { integrationId: INTEGRATION_ID },
          select: { id: true, externalSourceId: true, name: true },
        });

        // No duplication.
        expect(after).toHaveLength(ids.length);

        const beforeById = new Map(
          before.map((row) => [row.externalSourceId, row.id])
        );
        for (const row of after) {
          // The internal id survives — this is what keeps contact foreign keys
          // valid across runs.
          expect(row.id).toBe(beforeById.get(row.externalSourceId));
          // And the update actually applied.
          expect(row.name).toBe(`Renamed ${row.externalSourceId}`);
        }
      }),
      { numRuns: 25 }
    );
  });

  it("keeps contact associations pointing at the same customers after a re-sync", async () => {
    await fc.assert(
      fc.asyncProperty(externalIds, async (ids) => {
        await prisma.contact.deleteMany({
          where: { integrationId: INTEGRATION_ID },
        });
        await prisma.customer.deleteMany({
          where: { integrationId: INTEGRATION_ID },
        });

        const customers = await writeCustomers(
          INTEGRATION_ID,
          ids.map((id) => customerRecord(id, `Name ${id}`))
        );

        const contacts = ids.map((id) => ({
          externalSourceId: `contact-${id}`,
          externalRefs: { customer: id },
          mapped: {
            object: "contact" as const,
            fields: { name: `Person ${id}` },
            customFields: {},
            crossRefs: {},
          },
        }));

        await writeContacts(
          INTEGRATION_ID,
          contacts,
          customers.externalToInternal
        );

        // Re-run the contacts with an *empty* index. This is the ordinary case
        // a later sync produces: the companies did not change, so nothing put
        // them in this run's map, and the only way to resolve the association is
        // to look up the customer written by an earlier run. Without that
        // fallback every unchanged contact silently loses its company.
        await writeContacts(INTEGRATION_ID, contacts, new Map());

        const rows = await prisma.contact.findMany({
          where: { integrationId: INTEGRATION_ID },
          select: { externalCustomerId: true, customer: { select: { externalSourceId: true } } },
        });

        expect(rows).toHaveLength(ids.length);
        for (const row of rows) {
          expect(row.customer?.externalSourceId).toBe(row.externalCustomerId);
        }
      }),
      { numRuns: 25 }
    );
  });
});

/**
 * The same invariant for the record with two parents.
 *
 * Worth its own block rather than a case in the one above, because the failure
 * it guards is different in kind. `resolveAssociation` is shared, but
 * `findByExternalId` dispatches on a hand-written `ParentModel` switch — and an
 * agreement resolves two of its four members. A branch that looked the wrong
 * model up would still *find* rows (both tables are keyed alike) and would
 * silently attach agreements to the wrong parents.
 *
 * The empty-index re-run matters even more here than for contacts: an
 * agreement's parents are written by other functions, so its indexes are
 * always cold. The database fallback is not an optimization, it is the only
 * path — and this property is what proves it works for both halves.
 */
describe("Property: agreements keep both parents across a re-sync", () => {
  it("re-resolves customer and offering from the database, not the run index", async () => {
    await fc.assert(
      fc.asyncProperty(externalIds, async (ids) => {
        // Written out rather than looped over an array of delegates: Prisma's
        // model delegates are distinct types, so a union of them is not
        // callable. The same reason `findByExternalId` is a switch.
        const scope = { where: { integrationId: INTEGRATION_ID } };
        await prisma.agreement.deleteMany(scope);
        await prisma.offering.deleteMany(scope);
        await prisma.product.deleteMany(scope);
        await prisma.customer.deleteMany(scope);

        // The two parent families, written by the functions that own them.
        await writeCustomers(
          INTEGRATION_ID,
          ids.map((id) => customerRecord(`cus-${id}`, `Name ${id}`))
        );
        const products = await writeProducts(INTEGRATION_ID, [
          {
            externalSourceId: "prod-1",
            mapped: {
              object: "product",
              fields: { name: "Product" },
              customFields: {},
              crossRefs: {},
            },
          },
        ]);
        await writeOfferings(
          INTEGRATION_ID,
          ids.map((id) => ({
            externalSourceId: `price-${id}`,
            externalRefs: { product: "prod-1" },
            mapped: {
              object: "offering" as const,
              fields: { name: `Offering ${id}`, amountMinor: "4900" },
              customFields: {},
              crossRefs: {},
            },
          })),
          products.externalToInternal
        );

        const agreements = ids.map((id) => ({
          externalSourceId: `sub-${id}`,
          externalRefs: { customer: `cus-${id}`, offering: `price-${id}` },
          mapped: {
            object: "agreement" as const,
            fields: { name: `Agreement ${id}`, agreementType: "subscription" },
            customFields: {},
            crossRefs: {},
          },
        }));

        const first = await writeAgreements(INTEGRATION_ID, agreements);
        const beforeIds = [...first.externalToInternal.entries()].sort();

        // Re-run. Nothing about the parents changed, which is the ordinary case
        // every sync after the first produces.
        const second = await writeAgreements(INTEGRATION_ID, agreements);

        expect([...second.externalToInternal.entries()].sort()).toEqual(
          beforeIds
        );

        const rows = await prisma.agreement.findMany({
          where: { integrationId: INTEGRATION_ID },
          select: {
            externalSourceId: true,
            externalCustomerId: true,
            externalOfferingId: true,
            customer: { select: { externalSourceId: true } },
            offering: { select: { externalSourceId: true } },
          },
        });

        expect(rows).toHaveLength(ids.length);
        for (const row of rows) {
          // Each half resolved, and — the part a wrong switch branch would
          // break — resolved to the row the provider actually named.
          expect(row.customer?.externalSourceId).toBe(row.externalCustomerId);
          expect(row.offering?.externalSourceId).toBe(row.externalOfferingId);
        }
      }),
      { numRuns: 20 }
    );
  });
});
