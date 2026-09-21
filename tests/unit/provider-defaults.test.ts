/**
 * Every provider's suggested default mappings must validate.
 *
 * This is not a style check. Defaults are seeded during connection, and the
 * seeding path runs them through the same `validateMappings` the editor does —
 * `seedMappingsIfEmpty` → `saveMappings`, which *throws* on an invalid rule set.
 * On the draft path that rejects the whole connection and rolls the integration
 * row back, so one bad default is the difference between a provider that works
 * and a provider that cannot be connected at all. A unit test is a much better
 * place to find that out than a connect screen.
 *
 * Written over the registries rather than over a list, so it covers the next
 * provider *and* the next function automatically. That second half is new: the
 * suite used to check `identity` only, which would have let a broken catalog
 * default ship untouched.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, resetBootstrapForTests } from "@/core/bootstrap";
import { providerRegistry } from "@/core/registries/provider-registry";
import { functionRegistry } from "@/core/registries/function-registry";
import { getSyncHandler } from "@/core/registries/handler-registry";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import {
  mappableFields,
  objectsForFunction,
  resolveTargetField,
  OBJECT_SCHEMAS,
} from "@/core/object-schema";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

/**
 * Every (function, provider) pair with a working handler.
 *
 * Handler-bearing rather than merely declared: a function with scopes and no
 * handler is a deliberate, documented state, and it ships no defaults because
 * there is nothing to sync them into.
 */
function handlerPairs(): Array<{ functionName: string; providerName: string }> {
  const pairs: Array<{ functionName: string; providerName: string }> = [];
  for (const definition of functionRegistry.getAll()) {
    for (const provider of providerRegistry.getAll()) {
      if (getSyncHandler(definition.name, provider.name) !== undefined) {
        pairs.push({ functionName: definition.name, providerName: provider.name });
      }
    }
  }
  return pairs;
}

describe("shipped default mappings", () => {
  it("covers more than one function, or this suite proves less than it looks", () => {
    // Guards the loops below. Every assertion here iterates `handlerPairs()`,
    // so a bug that emptied it — or narrowed it back to identity — would turn
    // the whole file green while checking nothing.
    const functions = new Set(handlerPairs().map((p) => p.functionName));
    expect(functions).toContain("identity");
    expect(functions).toContain("catalog");
  });

  it("validates for every function and provider with a handler", () => {
    for (const { functionName, providerName } of handlerPairs()) {
      const rules = defaultMappingsFor(functionName, providerName);
      const result = validateMappings(functionName, rules);

      expect(
        result.violations,
        `${functionName}:${providerName} defaults: ${JSON.stringify(result.violations)}`
      ).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("never targets a read-only field", () => {
    // `associatedCustomerId` and `associatedProductId` are derived by the sync
    // engine from the provider's own foreign id. A default writing to one would
    // invite a foreign id into a column holding our internal UUIDs.
    for (const { functionName, providerName } of handlerPairs()) {
      for (const rule of defaultMappingsFor(functionName, providerName)) {
        const field = resolveTargetField(rule.targetObject, rule.targetFieldPath);
        if (
          field === undefined ||
          field === "customField" ||
          field === "crossRef"
        ) {
          // Neither is a schema field, so neither appears in `mappableFields`.
          // `crossRef` is not read-only either — it is a target a user may set,
          // it just is not a column.
          continue;
        }
        expect(
          mappableFields(rule.targetObject).map((f) => f.name),
          `${providerName} → ${rule.targetObject}.${rule.targetFieldPath}`
        ).toContain(field.name);
      }
    }
  });

  it("only targets objects the function actually writes", () => {
    // A rule set is stored against a function, so a catalog default naming a
    // customer field would validate against the schema, save, and then write
    // nothing on every sync — the failure with no symptom.
    for (const { functionName, providerName } of handlerPairs()) {
      const owned = objectsForFunction(functionName);
      for (const rule of defaultMappingsFor(functionName, providerName)) {
        expect(
          owned,
          `${functionName}:${providerName} targets ${rule.targetObject}`
        ).toContain(rule.targetObject);
      }
    }
  });

  it("supplies every required field for each object it writes to", () => {
    // A default set that maps contact fields but not `contact.name` produces a
    // rejected record for every contact of every sync — worse than mapping
    // nothing, because it looks like it is working. The same trap catches
    // `offering.name` and `agreement.name`, which is why Stripe synthesizes
    // both.
    //
    // The required list is read from the schema rather than hardcoded as
    // `"name"`, which is what this test used to assert. Two reasons: it now
    // covers any future required field for free, and — the reason it had to
    // change — not every object has a name. `subscription` deliberately has
    // none, because it extends exactly one agreement that already carries one,
    // and a copy could only ever drift from it.
    for (const { functionName, providerName } of handlerPairs()) {
      const rules = defaultMappingsFor(functionName, providerName);
      if (rules.length === 0) continue;

      for (const object of objectsForFunction(functionName)) {
        const forObject = rules.filter((r) => r.targetObject === object);
        if (forObject.length === 0) continue;

        const mapped = forObject.map((r) => r.targetFieldPath);
        const required = OBJECT_SCHEMAS[object].fields
          .filter((f) => f.required === true)
          .map((f) => f.name);

        for (const field of required) {
          expect(
            mapped,
            `${providerName} maps ${object} fields but not ${object}.${field}`
          ).toContain(field);
        }
      }
    }
  });

  it("ships defaults wherever there is a handler to use them", () => {
    // A handler with no defaults connects to an empty mapping grid and syncs
    // nothing until someone visits the editor.
    for (const { functionName, providerName } of handlerPairs()) {
      expect(
        defaultMappingsFor(functionName, providerName).length,
        `${functionName}:${providerName} has no default mappings`
      ).toBeGreaterThan(0);
    }
  });

  it("returns copies, so a caller cannot mutate the shipped rules", () => {
    const first = defaultMappingsFor("identity", "stripe");
    const target = first[0];
    expect(target).toBeDefined();
    if (target !== undefined) target.targetFieldPath = "mutated";

    expect(defaultMappingsFor("identity", "stripe")[0]?.targetFieldPath).not.toBe(
      "mutated"
    );
  });

  it("has none for a function with no providers", () => {
    expect(defaultMappingsFor("billing", "stripe")).toEqual([]);
  });
});
