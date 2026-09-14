import { describe, expect, it } from "vitest";
import {
  applyMappings,
  deserializeMappings,
  readPath,
  requestedSourcePaths,
  serializeMappings,
  validateMappings,
} from "@/core/field-mapper/field-mapper";
import { applyTransform } from "@/core/field-mapper/transforms";
import type { FieldMappingRule } from "@/core/types/mapping";

function rule(over: Partial<FieldMappingRule> = {}): FieldMappingRule {
  return {
    sourceFieldPath: "properties.name",
    targetObject: "customer",
    targetFieldPath: "name",
    transform: "none",
    ...over,
  };
}

describe("validateMappings", () => {
  it("accepts a well-formed customer rule", () => {
    expect(validateMappings([rule()]).valid).toBe(true);
  });

  it("accepts a custom field target", () => {
    const result = validateMappings([
      rule({ targetFieldPath: "customFields.account_tier" }),
    ]);
    expect(result.valid).toBe(true);
  });

  // The defect this whole qualified-target design exists to prevent.
  //
  // `jobTitle` rather than `email`: email is a legitimate target on both
  // objects now that identity resolution matches on an account-level address,
  // so it no longer demonstrates anything. A job title is still person-only.
  it("rejects a contact field mapped onto a customer", () => {
    const result = validateMappings([
      rule({ targetObject: "customer", targetFieldPath: "jobTitle" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("is not a field on customer");
  });

  it("rejects a customer field mapped onto a contact", () => {
    const result = validateMappings([
      rule({ targetObject: "contact", targetFieldPath: "industry" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("is not a field on contact");
  });

  it("rejects the derived associatedCustomerId target", () => {
    const result = validateMappings([
      rule({ targetObject: "contact", targetFieldPath: "associatedCustomerId" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("derived by the sync engine");
  });

  it("rejects a duplicate target within the same object", () => {
    const result = validateMappings([
      rule({ sourceFieldPath: "a" }),
      rule({ sourceFieldPath: "b" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.message.includes("more than once"))).toBe(
      true
    );
  });

  it("allows the same target name on different objects", () => {
    const result = validateMappings([
      rule({ targetObject: "customer", targetFieldPath: "name" }),
      rule({ targetObject: "contact", targetFieldPath: "name" }),
    ]);
    expect(result.valid).toBe(true);
  });

  describe("source path length boundaries", () => {
    it.each([
      ["1 char", "a", true],
      ["255 chars", "a".repeat(255), true],
      ["256 chars", "a".repeat(256), false],
      ["empty", "", false],
    ])("%s", (_label, path, expected) => {
      expect(validateMappings([rule({ sourceFieldPath: path })]).valid).toBe(
        expected
      );
    });
  });

  it("rejects a malformed custom field key", () => {
    const result = validateMappings([
      rule({ targetFieldPath: "customFields.has-a-dash" }),
    ]);
    expect(result.valid).toBe(false);
  });

  it("reports every violation, not just the first", () => {
    const result = validateMappings([
      rule({ targetFieldPath: "nope" }),
      rule({ sourceFieldPath: "" }),
    ]);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("readPath", () => {
  it("reads a nested path", () => {
    expect(readPath({ properties: { domain: "acme.com" } }, "properties.domain")).toBe(
      "acme.com"
    );
  });

  it("returns undefined for a missing path without throwing", () => {
    expect(readPath({}, "properties.domain.deep")).toBeUndefined();
  });
});

describe("applyMappings", () => {
  it("only applies rules for the requested object", () => {
    const mapped = applyMappings(
      [
        rule({ sourceFieldPath: "n", targetFieldPath: "name" }),
        rule({
          sourceFieldPath: "e",
          targetObject: "contact",
          targetFieldPath: "email",
        }),
      ],
      "customer",
      { n: "Acme", e: "a@b.com" }
    );
    expect(mapped.fields).toEqual({ name: "Acme" });
  });

  it("writes null for a mapped-but-absent source field", () => {
    const mapped = applyMappings(
      [rule({ sourceFieldPath: "missing", targetFieldPath: "domain" })],
      "customer",
      { name: "Acme" }
    );
    expect(mapped.fields["domain"]).toBeNull();
  });

  it("collects custom fields separately from standard ones", () => {
    const mapped = applyMappings(
      [
        rule({ sourceFieldPath: "n", targetFieldPath: "name" }),
        rule({ sourceFieldPath: "t", targetFieldPath: "customFields.tier" }),
      ],
      "customer",
      { n: "Acme", t: "gold" }
    );
    expect(mapped.fields).toEqual({ name: "Acme" });
    expect(mapped.customFields).toEqual({ tier: "gold" });
  });

  it("coerces non-string source values", () => {
    const mapped = applyMappings(
      [rule({ sourceFieldPath: "n", targetFieldPath: "name" })],
      "customer",
      { n: 42 }
    );
    expect(mapped.fields["name"]).toBe("42");
  });
});

describe("applyTransform", () => {
  it.each([
    ["https://www.acme.com/pricing?x=1", "acme.com"],
    ["http://acme.co.uk", "acme.co.uk"],
    ["acme.com", "acme.com"],
    ["WWW.Acme.COM", "acme.com"],
  ])("domainFromUrl(%s) -> %s", (input, expected) => {
    expect(applyTransform("domainFromUrl", input)).toBe(expected);
  });

  it("domainFromUrl returns null for an empty value", () => {
    expect(applyTransform("domainFromUrl", "  ")).toBeNull();
  });

  it("dateOnly reduces an ISO timestamp to its date", () => {
    expect(applyTransform("dateOnly", "2026-03-04T11:22:33.000Z")).toBe("2026-03-04");
  });

  it("dateOnly passes through an unparseable value", () => {
    expect(applyTransform("dateOnly", "not a date")).toBe("not a date");
  });
});

describe("requestedSourcePaths", () => {
  it("groups and dedupes by object", () => {
    const grouped = requestedSourcePaths([
      rule({ sourceFieldPath: "a", targetFieldPath: "name" }),
      rule({ sourceFieldPath: "a", targetFieldPath: "domain" }),
      rule({ sourceFieldPath: "b", targetObject: "contact", targetFieldPath: "name" }),
    ]);
    expect(grouped.get("customer")).toEqual(["a"]);
    expect(grouped.get("contact")).toEqual(["b"]);
  });
});

describe("serialization", () => {
  it("round-trips a config", () => {
    const config = { integrationId: "i1", rules: [rule()] };
    expect(deserializeMappings(serializeMappings(config))).toEqual(config);
  });

  it("rejects an unknown schema version", () => {
    expect(() =>
      deserializeMappings({ schemaVersion: 99, integrationId: "i1", rules: [] })
    ).toThrow(/schema version/);
  });

  it.each([
    ["a non-object payload", "nope"],
    ["a missing integrationId", { schemaVersion: 1, rules: [] }],
    ["non-array rules", { schemaVersion: 1, integrationId: "i1", rules: {} }],
  ])("rejects %s", (_label, payload) => {
    expect(() => deserializeMappings(payload)).toThrow();
  });

  it("rejects a rule with an unknown transform", () => {
    expect(() =>
      deserializeMappings({
        schemaVersion: 1,
        integrationId: "i1",
        rules: [{ ...rule(), transform: "explode" }],
      })
    ).toThrow(/transform/);
  });
});

describe("readPath prototype safety", () => {
  // Regression: a user-supplied source path must not reach the prototype chain.
  it.each(["constructor", "__proto__", "toString", "valueOf"])(
    "returns undefined for inherited property %s",
    (path) => {
      expect(readPath({}, path)).toBeUndefined();
    }
  );

  it("still reads an own property that shadows a prototype name", () => {
    expect(readPath({ toString: "shadowed" }, "toString")).toBe("shadowed");
  });

  it("does not throw when a transform meets an inherited path", () => {
    const mapped = applyMappings(
      [
        {
          sourceFieldPath: "constructor",
          targetObject: "customer",
          targetFieldPath: "createDate",
          transform: "dateOnly",
        },
      ],
      "customer",
      {}
    );
    expect(mapped.fields["createDate"]).toBeNull();
  });
});
