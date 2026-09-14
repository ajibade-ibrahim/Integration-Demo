/**
 * `crossRef.<provider>` — the mapping target for a foreign system's own id.
 *
 * This is the supply route for the join the governing spec asks for and no API
 * offers: Metrifox's `payments_stripe_customers` relates a Metrifox customer to
 * a Stripe customer, and the Metrifox connector cannot fetch that table. When
 * the foreign id happens to ride on a record the connector already reads, a
 * mapping rule is the whole mechanism.
 *
 * Two properties carry the weight here. The provider segment is checked against
 * the registry, so a path that cannot ever resolve is refused at save time
 * rather than becoming a key that matches nothing. And a mapped reference lands
 * in its own bucket instead of `fields`, where the record writer — which reads
 * `fields` by known column name — would drop it without a word.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import {
  CROSS_REF_PATTERN,
  crossRefProviderName,
  resolveTargetField,
} from "@/core/identity-schema";
import {
  applyMappings,
  validateMappings,
} from "@/core/field-mapper/field-mapper";
import type { FieldMappingRule } from "@/core/types/mapping";

// `resolveTargetField` consults the provider registry for these paths, so
// bootstrap is a precondition rather than boilerplate — without it every
// cross-reference path resolves to undefined.
beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

function rule(over: Partial<FieldMappingRule> = {}): FieldMappingRule {
  return {
    sourceFieldPath: "stripe_customer_id",
    targetObject: "customer",
    targetFieldPath: "crossRef.stripe",
    transform: "none",
    ...over,
  };
}

describe("resolveTargetField", () => {
  it("accepts a registered provider", () => {
    expect(resolveTargetField("customer", "crossRef.stripe")).toBe("crossRef");
    expect(resolveTargetField("customer", "crossRef.hubspot")).toBe("crossRef");
  });

  it("refuses a provider that is not registered", () => {
    // Shaped correctly, names nothing. The point of checking the registry: a
    // key built from this would sit in the identity table matching no record
    // ever, and nothing would report a problem.
    expect(resolveTargetField("customer", "crossRef.nonsense")).toBeUndefined();
  });

  it("refuses a cross-reference on a contact", () => {
    // A cross-reference asserts two records are the same *company*.
    // Person-level identity is a separate problem with different match rules,
    // so accepting this would store data nothing reads.
    expect(resolveTargetField("contact", "crossRef.stripe")).toBeUndefined();
  });

  it("still resolves ordinary and custom targets", () => {
    // The union widened; it did not change what it already accepted.
    expect(resolveTargetField("customer", "domain")).toMatchObject({
      name: "domain",
    });
    expect(resolveTargetField("customer", "customFields.tier")).toBe(
      "customField"
    );
    expect(resolveTargetField("customer", "nonsense")).toBeUndefined();
  });
});

describe("the path pattern", () => {
  it("matches a lowercase provider name and extracts it", () => {
    expect(crossRefProviderName("crossRef.stripe")).toBe("stripe");
    expect(crossRefProviderName("crossRef.my-crm_2")).toBe("my-crm_2");
  });

  it.each([
    ["crossRef.", "no provider segment"],
    ["crossRef.Stripe", "provider names are lowercase"],
    ["crossRef.a.b", "one segment only"],
    ["crossref.stripe", "prefix is case-sensitive"],
    ["customFields.stripe", "a custom field is not a reference"],
    ["stripe", "bare provider name"],
  ])("does not match %j (%s)", (path) => {
    expect(CROSS_REF_PATTERN.test(path)).toBe(false);
    expect(crossRefProviderName(path)).toBeUndefined();
  });
});

describe("validateMappings", () => {
  it("accepts a cross-reference to a registered provider", () => {
    expect(validateMappings([rule()]).valid).toBe(true);
  });

  it("names the unknown provider rather than blaming the field", () => {
    // The message matters: the path *is* a valid field path shape, so "not a
    // field on customer" would send someone hunting a typo in the wrong half.
    const result = validateMappings([
      rule({ targetFieldPath: "crossRef.nonsense" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      index: 0,
      field: "targetFieldPath",
    });
    expect(result.violations[0]?.message).toBe(
      "'nonsense' is not a known provider"
    );
  });

  it("explains the object restriction on a contact rule", () => {
    const result = validateMappings([
      rule({ targetObject: "contact", targetFieldPath: "crossRef.stripe" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("only be mapped onto a customer");
  });

  it("still catches a duplicated cross-reference target", () => {
    // Two rules writing the same reference is the same mistake as two rules
    // writing the same column, and must be reported the same way.
    const result = validateMappings([
      rule(),
      rule({ sourceFieldPath: "legacy_stripe_id" }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("mapped more than once");
  });
});

describe("applyMappings", () => {
  it("routes the value into crossRefs, not fields", () => {
    const mapped = applyMappings(
      [
        rule({ sourceFieldPath: "display_name", targetFieldPath: "name" }),
        rule(),
      ],
      "customer",
      { display_name: "Acme Industries", stripe_customer_id: "cus_acme" }
    );

    expect(mapped.crossRefs).toEqual({ stripe: "cus_acme" });
    // The load-bearing half. `writeCustomers` builds its row from known keys of
    // `fields`, so a reference landing there would be silently discarded.
    expect(mapped.fields).not.toHaveProperty("crossRef.stripe");
    expect(mapped.fields["name"]).toBe("Acme Industries");
    expect(mapped.customFields).toEqual({});
  });

  it("omits a reference the source record does not carry", () => {
    // Most records name no counterpart. A null entry would read as a reference
    // to nothing and have to be filtered out again by every consumer.
    const mapped = applyMappings([rule()], "customer", { id: "MF-1" });

    expect(mapped.crossRefs).toEqual({});
  });

  it("omits an empty reference, as a blank id joins nothing", () => {
    const mapped = applyMappings([rule()], "customer", {
      stripe_customer_id: "",
    });

    expect(mapped.crossRefs).toEqual({});
  });

  it("applies the rule's transform", () => {
    // Foreign ids arrive with the same whitespace and casing problems as any
    // other field, and a reference that fails to match for a trailing space is
    // indistinguishable from one that genuinely has no counterpart.
    const mapped = applyMappings(
      [rule({ transform: "trim" })],
      "customer",
      { stripe_customer_id: "  cus_acme  " }
    );

    expect(mapped.crossRefs["stripe"]).toBe("cus_acme");
  });
});
