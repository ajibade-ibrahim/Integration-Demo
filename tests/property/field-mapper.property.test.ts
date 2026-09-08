import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyMappings,
  deserializeMappings,
  serializeMappings,
  validateMappings,
} from "@/core/field-mapper/field-mapper";
import { IDENTITY_SCHEMA, mappableFields } from "@/core/identity-schema";
import { TARGET_OBJECTS, type TargetObject } from "@/core/types/common";
import {
  FIELD_TRANSFORMS,
  type FieldMappingRule,
} from "@/core/types/mapping";

const RUNS = 200;

const objectArb = fc.constantFrom<TargetObject>(...TARGET_OBJECTS);
const transformArb = fc.constantFrom(...FIELD_TRANSFORMS);

const sourcePathArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[^a-zA-Z0-9_.]/g, "") || "field");

/** A rule guaranteed valid: a real mappable target on a real object. */
const validRuleArb: fc.Arbitrary<FieldMappingRule> = objectArb.chain((object) =>
  fc.record({
    sourceFieldPath: sourcePathArb,
    targetObject: fc.constant(object),
    targetFieldPath: fc.constantFrom(
      ...mappableFields(object).map((f) => f.name)
    ),
    transform: transformArb,
  })
);

/** A rule set with no duplicate (object, target) pairs. */
const validRuleSetArb = fc
  .array(validRuleArb, { minLength: 0, maxLength: 12 })
  .map((rules) => {
    const seen = new Set<string>();
    return rules.filter((r) => {
      const key = `${r.targetObject}.${r.targetFieldPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/**
 * A plausible integration id. Deliberately excludes blank strings: those are
 * not valid ids and deserialization rejects them by design, so generating one
 * tests the guard rather than the round-trip.
 */
const integrationIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

describe("Property: mapping serialization round-trip", () => {
  it("preserves every rule exactly, for any rule count including zero", () => {
    fc.assert(
      fc.property(
        integrationIdArb,
        validRuleSetArb,
        (integrationId, rules) => {
          const config = { integrationId, rules };
          const restored = deserializeMappings(serializeMappings(config));

          expect(restored.integrationId).toBe(integrationId);
          expect(restored.rules).toHaveLength(rules.length);
          expect(restored).toEqual(config);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("produces a config independent of the original, not a shared reference", () => {
    fc.assert(
      fc.property(validRuleSetArb, (rules) => {
        fc.pre(rules.length > 0);
        const config = { integrationId: "i1", rules };
        const serialized = serializeMappings(config);

        const firstRule = config.rules[0];
        if (firstRule !== undefined) firstRule.sourceFieldPath = "MUTATED";

        expect(serialized.rules[0]?.sourceFieldPath).not.toBe("MUTATED");
      }),
      { numRuns: 100 }
    );
  });
});

describe("Property: target validation completeness", () => {
  it("accepts any rule set built only from mappable fields", () => {
    fc.assert(
      fc.property(validRuleSetArb, (rules) => {
        const result = validateMappings(rules);
        expect(result.violations).toEqual([]);
        expect(result.valid).toBe(true);
      }),
      { numRuns: RUNS }
    );
  });

  // The cross-object case: a field valid on one object must be rejected on the
  // other whenever the two schemas do not share that name.
  it("rejects a target belonging to the other object", () => {
    fc.assert(
      fc.property(objectArb, sourcePathArb, (object, source) => {
        const other: TargetObject = object === "customer" ? "contact" : "customer";
        const ownNames = new Set(
          IDENTITY_SCHEMA[object].fields.map((f) => f.name)
        );
        const foreign = IDENTITY_SCHEMA[other].fields
          .map((f) => f.name)
          .filter((n) => !ownNames.has(n));

        for (const targetFieldPath of foreign) {
          const result = validateMappings([
            {
              sourceFieldPath: source,
              targetObject: object,
              targetFieldPath,
              transform: "none",
            },
          ]);
          expect(result.valid).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("rejects the whole set if any single rule is invalid", () => {
    fc.assert(
      fc.property(validRuleSetArb, sourcePathArb, (rules, source) => {
        const poisoned: FieldMappingRule[] = [
          ...rules,
          {
            sourceFieldPath: source,
            targetObject: "customer",
            targetFieldPath: "definitely_not_a_field",
            transform: "none",
          },
        ];
        expect(validateMappings(poisoned).valid).toBe(false);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property: every rule is evaluated for every record", () => {
  it("writes a key for each standard-field rule regardless of source contents", () => {
    fc.assert(
      fc.property(
        validRuleSetArb,
        fc.dictionary(sourcePathArb, fc.string(), { maxKeys: 6 }),
        (rules, source) => {
          for (const object of TARGET_OBJECTS) {
            const applicable = rules.filter((r) => r.targetObject === object);
            const mapped = applyMappings(rules, object, source);

            const expectedKeys = new Set(
              applicable
                .filter((r) => !r.targetFieldPath.startsWith("customFields."))
                .map((r) => r.targetFieldPath)
            );

            // No rule silently skipped: one output key per standard-field rule.
            expect(new Set(Object.keys(mapped.fields))).toEqual(expectedKeys);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("yields null for a mapped field the record does not carry", () => {
    fc.assert(
      fc.property(validRuleSetArb, (rules) => {
        for (const object of TARGET_OBJECTS) {
          // An empty source record: nothing can be found.
          const mapped = applyMappings(rules, object, {});
          for (const value of Object.values(mapped.fields)) {
            expect(value).toBeNull();
          }
          expect(mapped.customFields).toEqual({});
        }
      }),
      { numRuns: RUNS }
    );
  });
});
