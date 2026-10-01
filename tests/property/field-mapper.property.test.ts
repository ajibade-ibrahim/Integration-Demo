import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyMappings,
  deserializeMappings,
  serializeMappings,
  validateMappings,
} from "@/core/field-mapper/field-mapper";
import {
  OBJECT_SCHEMAS,
  mappableFields,
  objectsForFunction,
} from "@/core/object-schema";
import { TARGET_OBJECTS, type TargetObject } from "@/core/types/common";
import {
  FIELD_TRANSFORMS,
  type FieldMappingRule,
} from "@/core/types/mapping";

const RUNS = 200;

/**
 * The functions that own objects, and so can hold mapping rules.
 *
 * Listed rather than derived, and pinned by the first property below, so that a
 * function added without being wired in here fails loudly instead of quietly
 * going untested.
 */
const FUNCTIONS_WITH_OBJECTS = [
  "identity",
  "catalog",
  "agreement",
  "billing",
] as const;

const functionArb = fc.constantFrom(...FUNCTIONS_WITH_OBJECTS);

const transformArb = fc.constantFrom(...FIELD_TRANSFORMS);

const sourcePathArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[^a-zA-Z0-9_.]/g, "") || "field");

/** A rule guaranteed valid *for that function*: a mappable target it owns. */
function validRuleArb(functionName: string): fc.Arbitrary<FieldMappingRule> {
  return fc
    .constantFrom<TargetObject[]>(...objectsForFunction(functionName))
    .chain((object) =>
      fc.record({
        sourceFieldPath: sourcePathArb,
        targetObject: fc.constant(object),
        targetFieldPath: fc.constantFrom(
          ...mappableFields(object).map((f) => f.name)
        ),
        transform: transformArb,
      })
    );
}

/** Drop duplicate (object, target) pairs, which validation rejects by design. */
function dedupe(rules: FieldMappingRule[]): FieldMappingRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = `${r.targetObject}.${r.targetFieldPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A function paired with a rule set that is valid for it.
 *
 * Generated together, because validity is a property of the pair rather than of
 * the rules alone: the same rule is fine under the function that owns its
 * object and refused under one that does not. Generating rules against every
 * object and then validating them all as "identity" is exactly the mistake this
 * arbitrary exists to prevent.
 */
const functionRuleSetArb = functionArb.chain((functionName) =>
  fc.record({
    functionName: fc.constant<string>(functionName),
    rules: fc
      .array(validRuleArb(functionName), { minLength: 0, maxLength: 12 })
      .map(dedupe),
  })
);

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
        functionRuleSetArb,
        (integrationId, { rules }) => {
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
      fc.property(functionRuleSetArb, ({ rules }) => {
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
  it("covers every function that owns objects", () => {
    // Guards the generator. `functionRuleSetArb` only ever produces functions
    // from `FUNCTIONS_WITH_OBJECTS`, so a function added to the schema and not
    // to that list would leave every property below silently untested.
    for (const functionName of FUNCTIONS_WITH_OBJECTS) {
      expect(objectsForFunction(functionName).length).toBeGreaterThan(0);
    }
    const covered = new Set<string>(FUNCTIONS_WITH_OBJECTS);
    for (const object of TARGET_OBJECTS) {
      const owner = FUNCTIONS_WITH_OBJECTS.find((fn) =>
        objectsForFunction(fn).includes(object)
      );
      expect(owner, `${object} belongs to no function in the list`).toBeDefined();
      if (owner !== undefined) expect(covered).toContain(owner);
    }
  });

  it("accepts any rule set built only from fields its function owns", () => {
    fc.assert(
      fc.property(functionRuleSetArb, ({ functionName, rules }) => {
        const result = validateMappings(functionName, rules);
        expect(result.violations).toEqual([]);
        expect(result.valid).toBe(true);
      }),
      { numRuns: RUNS }
    );
  });

  // The object-scoping case: a rule valid under the function that owns its
  // object must be refused under one that does not. Without this, a catalog
  // rule set holding customer rules would save cleanly and then write nothing
  // on every sync — a failure with no symptom at all.
  it("rejects a rule targeting an object the function does not write", () => {
    fc.assert(
      fc.property(functionRuleSetArb, functionArb, ({ rules }, otherFunction) => {
        fc.pre(rules.length > 0);
        const owned = objectsForFunction(otherFunction);
        fc.pre(rules.some((r) => !owned.includes(r.targetObject)));

        expect(validateMappings(otherFunction, rules).valid).toBe(false);
      }),
      { numRuns: RUNS }
    );
  });

  // The cross-object case: a field valid on one object must be rejected on a
  // sibling whenever the two schemas do not share that name.
  it("rejects a target belonging to a sibling object", () => {
    fc.assert(
      fc.property(functionArb, sourcePathArb, (functionName, source) => {
        const objects = objectsForFunction(functionName);

        for (const object of objects) {
          const ownNames = new Set(
            OBJECT_SCHEMAS[object].fields.map((f) => f.name)
          );
          const siblings = objects.filter((o) => o !== object);

          for (const other of siblings) {
            const foreign = OBJECT_SCHEMAS[other].fields
              .map((f) => f.name)
              .filter((n) => !ownNames.has(n));

            for (const targetFieldPath of foreign) {
              const result = validateMappings(functionName, [
                {
                  sourceFieldPath: source,
                  targetObject: object,
                  targetFieldPath,
                  transform: "none",
                },
              ]);
              expect(
                result.valid,
                `${functionName}: ${object}.${targetFieldPath} should be refused`
              ).toBe(false);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("rejects the whole set if any single rule is invalid", () => {
    fc.assert(
      fc.property(functionRuleSetArb, sourcePathArb, ({ functionName, rules }, source) => {
        const object = objectsForFunction(functionName)[0];
        expect(object).toBeDefined();
        if (object === undefined) return;

        const poisoned: FieldMappingRule[] = [
          ...rules,
          {
            sourceFieldPath: source,
            targetObject: object,
            targetFieldPath: "definitely_not_a_field",
            transform: "none",
          },
        ];
        expect(validateMappings(functionName, poisoned).valid).toBe(false);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property: every rule is evaluated for every record", () => {
  it("writes a key for each standard-field rule regardless of source contents", () => {
    fc.assert(
      fc.property(
        functionRuleSetArb,
        fc.dictionary(sourcePathArb, fc.string(), { maxKeys: 6 }),
        ({ functionName, rules }, source) => {
          for (const object of objectsForFunction(functionName)) {
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
      fc.property(functionRuleSetArb, ({ functionName, rules }) => {
        for (const object of objectsForFunction(functionName)) {
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
