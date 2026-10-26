/**
 * The billing schema, and the two independent declarations it ties together.
 *
 * Three things are pinned here:
 *
 *   1. the write order is parent-first, which for billing is a correctness
 *      requirement — `invoiceLine`'s FK is required and rejecting;
 *   2. `bootstrap.ts`'s `dataModels` and `FUNCTION_OBJECTS.billing` are the
 *      same list. They are two independent declarations of one fact with
 *      nothing in the type system tying them, which is exactly why
 *      `agreement-schema.test.ts` has a twin assertion and this file exists:
 *      there was no billing parity test to fire;
 *   3. the line type is `INVOICE_LINE_TYPES`, not `AGREEMENT_ITEM_TYPES`. An
 *      invoice line answers a different question than a subscription line, and
 *      a shared union would store a discount as a charge.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, BILLING_FUNCTION, resetBootstrapForTests } from "@/core/bootstrap";
import { functionRegistry } from "@/core/registries/function-registry";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import {
  OBJECT_SCHEMAS,
  functionOwnsObject,
  functionsInWriteOrder,
  mappableFields,
  objectsForFunction,
  schemasForFunction,
} from "@/core/object-schema";
import {
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_STATUSES,
} from "@/core/types/common";
import type { FieldMappingRule } from "@/core/types/mapping";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

const fieldNames = (
  object: "invoice" | "invoiceLine" | "payment"
): string[] => OBJECT_SCHEMAS[object].fields.map((f) => f.name);

describe("the billing schema", () => {
  it("writes the invoice first, then its lines and payments", () => {
    // Load-bearing: `InvoiceLine.invoiceId` is required and rejecting, so a
    // line written before its invoice is dropped outright; `Payment.invoiceId`
    // is nullable but wants the link on first sight.
    expect(objectsForFunction(BILLING_FUNCTION)).toEqual([
      "invoice",
      "invoiceLine",
      "payment",
    ]);
  });

  it("agrees with what the function declares it syncs", () => {
    // The parity twin that did not exist for billing. `dataModels` is the
    // function's declared roadmap and `objectsForFunction` drives the sync; the
    // per-handler objects narrow the picker's "Writes" line. A divergence here
    // would make the roadmap and the writer disagree.
    expect(
      [...functionRegistry.require(BILLING_FUNCTION).dataModels].sort()
    ).toEqual([...objectsForFunction(BILLING_FUNCTION)].sort());
  });

  it("runs identity, catalog and agreement before billing", () => {
    // An invoice's parents are written by the other three functions.
    expect(
      functionsInWriteOrder(["billing", "agreement", "catalog", "identity"])
    ).toEqual(["identity", "catalog", "agreement", "billing"]);
  });

  it("offers the invoice statuses the writer accepts, and only those", () => {
    const status = OBJECT_SCHEMAS.invoice.fields.find((f) => f.name === "status");
    expect(status?.enumValues).toEqual(INVOICE_STATUSES);
    // Not required: null means "the provider did not say", and Stripe has no
    // invoice `past_due` even though Chargebee's two retry words map to it.
    expect(status?.required).toBeUndefined();
  });

  it("requires a payment kind, and requires nothing else", () => {
    // The one required field in the function. It is what makes the writer
    // reject a movement that cannot say which way the money went — and what
    // forces both providers' default rule sets to map it.
    const kind = OBJECT_SCHEMAS.payment.fields.find((f) => f.name === "kind");
    expect(kind?.enumValues).toEqual(PAYMENT_KINDS);
    expect(kind?.required).toBe(true);

    for (const object of ["invoice", "invoiceLine", "payment"] as const) {
      const required = OBJECT_SCHEMAS[object].fields.filter(
        (f) => f.required === true
      );
      const expected = object === "payment" ? ["kind"] : [];
      expect(required.map((f) => f.name), object).toEqual(expected);
    }
  });

  it("types an invoice line with the invoice-line union, not the agreement one", () => {
    const type = OBJECT_SCHEMAS.invoiceLine.fields.find(
      (f) => f.name === "itemType"
    );
    expect(type?.kind).toBe("enum");
    expect(type?.enumValues).toEqual(INVOICE_LINE_TYPES);
    // The discount member alone is why the two unions cannot be one: an invoice
    // discount line is not an agreement `charge`.
    expect(INVOICE_LINE_TYPES).toContain("discount");
    expect(type?.required).toBeUndefined();
  });

  it("offers the payment statuses the writer accepts", () => {
    const status = OBJECT_SCHEMAS.payment.fields.find((f) => f.name === "status");
    expect(status?.enumValues).toEqual(PAYMENT_STATUSES);
  });

  it("keeps every association id read-only", () => {
    // The invoice one matters most: the engine injects it from the invoice a
    // line was fetched with, and a mappable field would let a rule point a line
    // at another invoice — whose remaining lines reconciliation would delete.
    for (const object of ["invoice", "invoiceLine", "payment"] as const) {
      const associations = OBJECT_SCHEMAS[object].fields.filter((f) =>
        f.name.startsWith("associated")
      );
      expect(associations.length, object).toBeGreaterThan(0);
      for (const field of associations) {
        expect(field.readOnly, `${object}.${field.name}`).toBe(true);
        expect(mappableFields(object).map((f) => f.name)).not.toContain(
          field.name
        );
      }
    }
  });

  it("makes providerMetadata mappable on all three, not read-only", () => {
    for (const object of ["invoice", "invoiceLine", "payment"] as const) {
      expect(mappableFields(object).map((f) => f.name)).toContain(
        "providerMetadata"
      );
    }
  });
});

describe("function scoping of billing rules", () => {
  const rule = (
    targetObject: FieldMappingRule["targetObject"],
    targetFieldPath: string
  ): FieldMappingRule => ({
    sourceFieldPath: "x",
    targetObject,
    targetFieldPath,
    transform: "none",
  });

  it("accepts rules for all three of its own objects", () => {
    expect(
      validateMappings(BILLING_FUNCTION, [
        rule("invoice", "number"),
        rule("invoiceLine", "quantity"),
        rule("payment", "kind"),
      ]).valid
    ).toBe(true);
  });

  it("refuses a rule targeting an object another function writes", () => {
    // An invoice references a customer and an agreement, which is the most
    // tempting mistake: the rule would validate against the schema, save, and
    // then write nothing on every sync.
    for (const object of ["customer", "agreement"] as const) {
      const result = validateMappings(BILLING_FUNCTION, [rule(object, "name")]);
      expect(result.valid, object).toBe(false);
      expect(result.violations[0]?.message).toContain("does not write");
    }
  });

  it("refuses a billing rule under another function", () => {
    expect(validateMappings("agreement", [rule("invoice", "number")]).valid).toBe(
      false
    );
    expect(validateMappings("identity", [rule("payment", "kind")]).valid).toBe(
      false
    );
  });

  it("shows the editor all three sections and nothing else", () => {
    expect(schemasForFunction(BILLING_FUNCTION).map((s) => s.label)).toEqual([
      "Invoice",
      "Invoice line",
      "Payment",
    ]);
  });

  it("gives each billing object exactly one owning function", () => {
    for (const object of ["invoice", "invoiceLine", "payment"] as const) {
      expect(functionOwnsObject(BILLING_FUNCTION, object)).toBe(true);
      expect(functionOwnsObject("agreement", object)).toBe(false);
      expect(functionOwnsObject("catalog", object)).toBe(false);
      expect(functionOwnsObject("identity", object)).toBe(false);
    }
  });

  it("has no charge object anywhere", () => {
    // Decision 1: the word means three incompatible things, and what it used to
    // stand for is `invoiceLine`.
    expect(objectsForFunction(BILLING_FUNCTION)).not.toContain("charge");
    expect(Object.keys(OBJECT_SCHEMAS)).not.toContain("charge");
  });
});
