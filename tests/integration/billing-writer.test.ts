/**
 * The billing writers against a real database.
 *
 * Sibling of `agreement-writer.test.ts`, covering the three things that are
 * billing-specific:
 *
 *   - **Two nullable parents on the invoice.** Customer and agreement resolve
 *     independently and warn independently, and an unresolved one keeps the
 *     provider id on the row so the relink pass can finish it.
 *   - **A required child FK with a destructive sibling.** `invoiceLine`'s
 *     invoice edge is rejecting, and `writeInvoiceLines` is the only other
 *     writer in the system that deletes. The reconciliation matrix below is the
 *     deliverable the plan names: getting it backwards is a sync that destroys
 *     a customer's line items and reports success.
 *   - **A required `Payment.kind`.** The one required field in the function, so
 *     a missing or unknown value is a rejection rather than a warning.
 *
 * `stripe-billing-sync.test.ts` and `chargebee-billing-sync.test.ts` drive the
 * handlers through `executeSync` over mocked HTTP; this file talks to the
 * writers directly, so it can build inputs a provider would never produce.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  relinkOrphanedInvoices,
  relinkOrphanedPaymentInvoices,
  writeAgreements,
  writeCustomers,
  writeInvoiceLines,
  writeInvoices,
  writeOfferings,
  writePayments,
  writePrices,
  writeProducts,
  type CollectedRecord,
} from "@/core/sync/record-writer";
import type { MappedRecord } from "@/core/types/mapping";

const USER_ID = "user-billing-writer";
const INTEGRATION_ID = "integration-billing-writer";

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "billing-writer@example.test" },
    update: {},
  });
  await prisma.integration.upsert({
    where: { id: INTEGRATION_ID },
    create: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "stripe",
      status: "active",
      instanceLabel: "Billing writer",
    },
    update: {},
  });
});

beforeEach(async () => {
  const where = { where: { integrationId: INTEGRATION_ID } };
  await prisma.payment.deleteMany(where);
  await prisma.invoiceLine.deleteMany(where);
  await prisma.invoice.deleteMany(where);
  await prisma.agreement.deleteMany(where);
  await prisma.offering.deleteMany(where);
  await prisma.price.deleteMany(where);
  await prisma.product.deleteMany(where);
  await prisma.customer.deleteMany(where);
});

afterAll(async () => {
  await prisma.integration
    .delete({ where: { id: INTEGRATION_ID } })
    .catch(() => {});
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

function invoiceRecord(
  externalSourceId: string,
  refs: { customer?: string; agreement?: string } = {},
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: refs,
    mapped: {
      object: "invoice",
      fields: {
        number: `INV-${externalSourceId}`,
        status: "open",
        currency: "usd",
        ...fields,
      },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

function lineRecord(
  externalSourceId: string,
  refs: { invoice?: string; offering?: string; price?: string },
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: refs,
    mapped: {
      object: "invoiceLine",
      fields: { quantity: "1", ...fields },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

/**
 * The reconcile context is keyed by **internal** ids, because that is what
 * `writeRecordsForFunction` passes — external ids never appear there. Getting
 * this wrong is how the delete case silently stops deleting.
 */
function internalIds(
  index: Map<string, string>,
  ...externalIds: string[]
): Set<string> {
  return new Set(
    externalIds.map((id) => {
      const internal = index.get(id);
      if (internal === undefined) throw new Error(`No internal id for ${id}`);
      return internal;
    })
  );
}

function paymentRecord(
  externalSourceId: string,
  refs: { invoice?: string; customer?: string },
  fields: Record<string, string | null> = {}
): CollectedRecord {
  return {
    externalSourceId,
    externalRefs: refs,
    mapped: {
      object: "payment",
      fields: { kind: "payment", ...fields },
      customFields: {},
      crossRefs: {},
    } as MappedRecord,
  };
}

/** A customer, the catalog an invoice line resolves against, and one agreement. */
async function seedParents(): Promise<void> {
  await writeCustomers(INTEGRATION_ID, [
    {
      externalSourceId: "cus_1",
      mapped: {
        object: "customer",
        fields: { name: "Acme" },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    },
  ]);

  const products = await writeProducts(INTEGRATION_ID, [
    {
      externalSourceId: "prod_1",
      mapped: {
        object: "product",
        fields: { name: "Platform" },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    },
  ]);

  const offerings = await writeOfferings(
    INTEGRATION_ID,
    [
      {
        externalSourceId: "price_1",
        externalRefs: { product: "prod_1" },
        mapped: {
          object: "offering",
          fields: { name: "$49/month", amountMinor: "4900", currency: "usd" },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ],
    products.externalToInternal
  );

  await writePrices(
    INTEGRATION_ID,
    [
      {
        externalSourceId: "price_1",
        externalRefs: { offering: "price_1" },
        mapped: {
          object: "price",
          fields: {
            name: "$49/month",
            amountMinor: "4900",
            currency: "usd",
            interval: "month",
          },
          customFields: {},
          crossRefs: {},
        } as MappedRecord,
      },
    ],
    offerings.externalToInternal
  );

  await writeAgreements(INTEGRATION_ID, [
    {
      externalSourceId: "sub_1",
      externalRefs: { customer: "cus_1", offering: "price_1" },
      mapped: {
        object: "agreement",
        fields: {
          name: "Acme subscription",
          agreementType: "subscription",
          status: "active",
        },
        customFields: {},
        crossRefs: {},
      } as MappedRecord,
    },
  ]);
}

describe("writing invoices", () => {
  it("round-trips every column, stated as the provider stated it", async () => {
    await seedParents();

    const result = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord(
        "in_1",
        { customer: "cus_1", agreement: "sub_1" },
        {
          number: "INV-0001",
          status: "paid",
          currency: "usd",
          subtotalMinor: "9900",
          totalMinor: "10700",
          amountDueMinor: "0",
          amountPaidMinor: "10700",
          issuedAt: "2024-01-01T00:00:00.000Z",
          dueAt: "2024-02-01T00:00:00.000Z",
          paidAt: "2024-01-02T00:00:00.000Z",
          hostedUrl: "https://invoice.stripe.com/i/in_1",
          providerMetadata: '{"po":"PO-1"}',
        }
      ),
    ]);

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.invoice.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { customer: true, agreement: true },
    });
    expect(row.number).toBe("INV-0001");
    expect(row.status).toBe("paid");
    expect(row.subtotalMinor).toBe(9900);
    expect(row.totalMinor).toBe(10700);
    expect(row.amountDueMinor).toBe(0);
    expect(row.amountPaidMinor).toBe(10700);
    expect(row.issuedAt?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(row.hostedUrl).toBe("https://invoice.stripe.com/i/in_1");
    expect(row.customer?.name).toBe("Acme");
    expect(row.agreement?.name).toBe("Acme subscription");
    expect(JSON.parse(row.providerMetadata)).toEqual({ po: "PO-1" });
  });

  it("warns and unsets an unrecognised status", async () => {
    const result = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", {}, { status: "reopened" }),
    ]);

    expect(result.issues.map((i) => i.fieldName)).toEqual(["status"]);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(
      (await prisma.invoice.findFirstOrThrow({ where: { integrationId: INTEGRATION_ID } }))
        .status
    ).toBeNull();
  });

  it("warns once per unresolved parent and keeps the provider ids", async () => {
    const result = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_missing", agreement: "sub_missing" }),
    ]);

    expect(result.written).toBe(1);
    // Two warnings, not one: the two parents belong to two different functions
    // and are repaired independently.
    expect(result.issues.map((i) => i.fieldName).sort()).toEqual([
      "associatedAgreementId",
      "associatedCustomerId",
    ]);
    expect(result.issues.every((i) => i.severity === "warning")).toBe(true);

    const row = await prisma.invoice.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.customerId).toBeNull();
    expect(row.externalCustomerId).toBe("cus_missing");
    expect(row.agreementId).toBeNull();
    expect(row.externalAgreementId).toBe("sub_missing");
  });

  it("stores a decimal amount as null rather than truncating it", async () => {
    // `parseInteger` uses `Number`, not `parseInt`, precisely so "$49.99" fails
    // instead of becoming a plausible 49.
    await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", {}, { totalMinor: "49.99" }),
    ]);

    expect(
      (await prisma.invoice.findFirstOrThrow({ where: { integrationId: INTEGRATION_ID } }))
        .totalMinor
    ).toBeNull();
  });

  it("is idempotent across runs", async () => {
    const records = [invoiceRecord("in_1")];
    await writeInvoices(INTEGRATION_ID, records);
    await writeInvoices(INTEGRATION_ID, records);

    expect(await prisma.invoice.count({ where: { integrationId: INTEGRATION_ID } })).toBe(1);
  });
});

describe("writing invoice lines", () => {
  async function seedInvoice(): Promise<Map<string, string>> {
    await seedParents();
    const invoices = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_1" }),
      invoiceRecord("in_2", { customer: "cus_1" }),
    ]);
    return invoices.externalToInternal;
  }

  it("resolves the offering and price and stores the period and money", async () => {
    const index = await seedInvoice();

    const result = await writeInvoiceLines(
      INTEGRATION_ID,
      [
        lineRecord(
          "il_1",
          { invoice: "in_1", offering: "price_1", price: "price_1" },
          {
            description: "Analytics Pro",
            quantity: "2",
            unitAmountMinor: "4950",
            amountMinor: "9900",
            periodStart: "2024-01-01T00:00:00.000Z",
            periodEnd: "2024-02-01T00:00:00.000Z",
            isProration: "true",
            itemType: "proration",
          }
        ),
      ],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.invoiceLine.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { invoice: true, offering: true, price: true },
    });
    expect(row.invoice.externalSourceId).toBe("in_1");
    expect(row.description).toBe("Analytics Pro");
    expect(row.quantity).toBe(2);
    expect(row.unitAmountMinor).toBe(4950);
    expect(row.amountMinor).toBe(9900);
    expect(row.isProration).toBe(true);
    expect(row.itemType).toBe("proration");
    expect(row.offering?.name).toBe("$49/month");
    expect(row.price?.name).toBe("$49/month");
  });

  it("leaves unitAmountMinor null for a fractional decimal, keeping the line", async () => {
    const index = await seedInvoice();

    await writeInvoiceLines(
      INTEGRATION_ID,
      [
        lineRecord(
          "il_1",
          { invoice: "in_1" },
          { unitAmountMinor: "49.99", amountMinor: "4999" }
        ),
      ],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    const row = await prisma.invoiceLine.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.unitAmountMinor).toBeNull();
    // The line total is always an integer, so it survives.
    expect(row.amountMinor).toBe(4999);
  });

  it("rejects a line whose invoice did not resolve", async () => {
    const index = await seedInvoice();

    const result = await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_1", { invoice: "in_missing" })],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
    expect(await prisma.invoiceLine.count({ where: { integrationId: INTEGRATION_ID } })).toBe(0);
  });

  it("warns separately on an unresolved offering and price", async () => {
    const index = await seedInvoice();

    const result = await writeInvoiceLines(
      INTEGRATION_ID,
      [
        lineRecord("il_1", {
          invoice: "in_1",
          offering: "price_missing",
          price: "price_missing",
        }),
      ],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(result.written).toBe(1);
    expect(result.issues.map((i) => i.fieldName).sort()).toEqual([
      "associatedOfferingId",
      "associatedPriceId",
    ]);
  });
});

/**
 * The reconciliation matrix — the only destructive path in the billing
 * function.
 *
 * Only the first case deletes. The other three are the guard: an invoice is
 * reconciled only when the object is mapped, the page declared itself complete,
 * and the invoice was written this run.
 */
describe("reconciling invoice lines", () => {
  async function seedTwoLines(): Promise<Map<string, string>> {
    await seedParents();
    const invoices = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_1" }),
      invoiceRecord("in_2", { customer: "cus_1" }),
    ]);
    await writeInvoiceLines(
      INTEGRATION_ID,
      [
        lineRecord("il_plan", { invoice: "in_1" }),
        lineRecord("il_seats", { invoice: "in_1" }),
        lineRecord("il_other", { invoice: "in_2" }),
      ],
      invoices.externalToInternal,
      {
        writtenInvoiceIds: internalIds(invoices.externalToInternal, "in_1", "in_2"),
        mapped: true,
        complete: true,
      }
    );
    return invoices.externalToInternal;
  }

  const idsFor = async (invoiceExternalId: string): Promise<string[]> =>
    (
      await prisma.invoiceLine.findMany({
        where: { integrationId: INTEGRATION_ID, invoice: { externalSourceId: invoiceExternalId } },
        select: { externalSourceId: true },
        orderBy: { externalSourceId: "asc" },
      })
    ).map((r) => r.externalSourceId);

  it("deletes a line the invoice no longer has", async () => {
    const index = await seedTwoLines();

    const result = await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_plan", { invoice: "in_1" })],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(await idsFor("in_1")).toEqual(["il_plan"]);
    expect(result.issues.map((i) => i.severity)).toEqual(["warning"]);
    expect(result.issues[0]?.reason).toContain("no longer on this invoice");
  });

  it("leaves another invoice's lines alone", async () => {
    const index = await seedTwoLines();

    await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_plan", { invoice: "in_1" })],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(await idsFor("in_2")).toEqual(["il_other"]);
  });

  it("keeps every line when the page withheld completeness", async () => {
    const index = await seedTwoLines();

    await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_plan", { invoice: "in_1" })],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: false }
    );

    expect(await idsFor("in_1")).toEqual(["il_plan", "il_seats"]);
  });

  it("keeps every line when the object is unmapped", async () => {
    const index = await seedTwoLines();

    await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_plan", { invoice: "in_1" })],
      index,
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: false, complete: true }
    );

    expect(await idsFor("in_1")).toEqual(["il_plan", "il_seats"]);
  });

  it("keeps every line when the run yielded none at all", async () => {
    const index = await seedTwoLines();

    const result = await writeInvoiceLines(INTEGRATION_ID, [], index, {
      writtenInvoiceIds: new Set(),
      mapped: true,
      complete: true,
    });

    expect(result.written).toBe(0);
    expect(await idsFor("in_1")).toEqual(["il_plan", "il_seats"]);
  });

  it("does not reconcile an invoice this run did not write", async () => {
    const index = await seedTwoLines();

    await writeInvoiceLines(
      INTEGRATION_ID,
      [lineRecord("il_plan", { invoice: "in_1" })],
      index,
      // in_1 is written; in_2 is deliberately absent from the set.
      { writtenInvoiceIds: internalIds(index, "in_1"), mapped: true, complete: true }
    );

    expect(await idsFor("in_2")).toEqual(["il_other"]);
  });
});

describe("writing payments", () => {
  async function seedInvoice(): Promise<Map<string, string>> {
    await seedParents();
    const invoices = await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_1" }),
    ]);
    return invoices.externalToInternal;
  }

  it("writes a payment movement with its invoice and customer links", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [
        paymentRecord(
          "ch_1",
          { invoice: "in_1", customer: "cus_1" },
          {
            status: "succeeded",
            amountMinor: "10700",
            currency: "usd",
            processedAt: "2024-01-02T00:00:00.000Z",
            method: "card",
            providerReference: "txn_1",
          }
        ),
      ],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);

    const row = await prisma.payment.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { invoice: true, customer: true },
    });
    expect(row.kind).toBe("payment");
    expect(row.status).toBe("succeeded");
    expect(row.amountMinor).toBe(10700);
    expect(row.method).toBe("card");
    expect(row.providerReference).toBe("txn_1");
    expect(row.invoice?.externalSourceId).toBe("in_1");
    expect(row.customer?.name).toBe("Acme");
  });

  it("rejects a payment with no kind at all", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [
        {
          externalSourceId: "ch_1",
          externalRefs: { invoice: "in_1" },
          mapped: {
            object: "payment",
            fields: { status: "succeeded" },
            customFields: {},
            crossRefs: {},
          } as MappedRecord,
        },
      ],
      index
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.fieldName).toBe("kind");
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("rejects an unrecognised kind rather than guessing a direction", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [paymentRecord("ch_1", { invoice: "in_1" }, { kind: "transfer" })],
      index
    );

    expect(result.written).toBe(0);
    expect(result.issues[0]?.severity).toBe("rejected");
  });

  it("warns and unsets an unrecognised status", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [paymentRecord("ch_1", { invoice: "in_1" }, { status: "settling" })],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues.map((i) => i.fieldName)).toEqual(["status"]);
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { integrationId: INTEGRATION_ID } }))
        .status
    ).toBeNull();
  });

  it("keeps a refund with no invoice link, which is the ordinary case", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [
        paymentRecord(
          "re_1",
          { customer: "cus_1" },
          { kind: "refund", status: "refunded" }
        ),
      ],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);
    const row = await prisma.payment.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.kind).toBe("refund");
    expect(row.invoiceId).toBeNull();
    expect(row.customerId).not.toBeNull();
  });

  it("warns and leaves the link null when the invoice did not resolve", async () => {
    const index = await seedInvoice();

    const result = await writePayments(
      INTEGRATION_ID,
      [paymentRecord("ch_1", { invoice: "in_missing" })],
      index
    );

    expect(result.written).toBe(1);
    expect(result.issues.map((i) => i.fieldName)).toEqual(["associatedInvoiceId"]);
    const row = await prisma.payment.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.externalInvoiceId).toBe("in_missing");
    expect(row.invoiceId).toBeNull();
  });
});

describe("relinking", () => {
  it("counts an invoice once when both halves move", async () => {
    // Written with unresolvable parents first, so both edges are stranded.
    await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_1", agreement: "sub_1" }),
    ]);

    // Now the parents exist.
    await seedParents();

    expect(await relinkOrphanedInvoices(INTEGRATION_ID)).toBe(1);

    const row = await prisma.invoice.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.customerId).not.toBeNull();
    expect(row.agreementId).not.toBeNull();
  });

  it("relinks a payment's invoice when it appears", async () => {
    await writePayments(
      INTEGRATION_ID,
      [paymentRecord("ch_1", { invoice: "in_1" })],
      new Map()
    );
    await writeInvoices(INTEGRATION_ID, [invoiceRecord("in_1")]);

    expect(await relinkOrphanedPaymentInvoices(INTEGRATION_ID)).toBe(1);

    const row = await prisma.payment.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
    });
    expect(row.invoiceId).not.toBeNull();
  });

  it("reports nothing to relink when every edge already resolved", async () => {
    await seedParents();
    await writeInvoices(INTEGRATION_ID, [
      invoiceRecord("in_1", { customer: "cus_1", agreement: "sub_1" }),
    ]);

    expect(await relinkOrphanedInvoices(INTEGRATION_ID)).toBe(0);
  });
});
