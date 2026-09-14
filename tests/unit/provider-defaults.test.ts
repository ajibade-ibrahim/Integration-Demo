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
 * Written over the registry rather than over a list of providers, so it covers
 * the next one automatically.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, IDENTITY_FUNCTION, resetBootstrapForTests } from "@/core/bootstrap";
import { providerRegistry } from "@/core/registries/provider-registry";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import { mappableFields, resolveTargetField } from "@/core/identity-schema";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("shipped default mappings", () => {
  it("validates for every registered provider", () => {
    for (const provider of providerRegistry.getAll()) {
      const rules = defaultMappingsFor(IDENTITY_FUNCTION, provider.name);
      const result = validateMappings(rules);

      expect(
        result.violations,
        `${provider.name} defaults: ${JSON.stringify(result.violations)}`
      ).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("never targets a read-only field", () => {
    // `associatedCustomerId` is derived by the sync engine from the provider's
    // own customer id. A default writing to it would invite a foreign id into a
    // column holding our internal UUIDs.
    for (const provider of providerRegistry.getAll()) {
      for (const rule of defaultMappingsFor(IDENTITY_FUNCTION, provider.name)) {
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
          `${provider.name} → ${rule.targetObject}.${rule.targetFieldPath}`
        ).toContain(field.name);
      }
    }
  });

  it("supplies the one required field for each object it writes to", () => {
    // A default set that maps contact fields but not `contact.name` produces a
    // rejected record for every contact of every sync — worse than mapping
    // nothing, because it looks like it is working.
    for (const provider of providerRegistry.getAll()) {
      const rules = defaultMappingsFor(IDENTITY_FUNCTION, provider.name);
      if (rules.length === 0) continue;

      for (const object of ["customer", "contact"] as const) {
        const forObject = rules.filter((r) => r.targetObject === object);
        if (forObject.length === 0) continue;
        expect(
          forObject.map((r) => r.targetFieldPath),
          `${provider.name} maps ${object} fields but not ${object}.name`
        ).toContain("name");
      }
    }
  });

  it("ships defaults for every provider that has an identity handler", () => {
    // A provider with a handler and no defaults connects to an empty mapping
    // grid and syncs nothing until someone visits the editor.
    for (const provider of providerRegistry.getAll()) {
      expect(
        defaultMappingsFor(IDENTITY_FUNCTION, provider.name).length,
        `${provider.name} has no default mappings`
      ).toBeGreaterThan(0);
    }
  });

  it("returns copies, so a caller cannot mutate the shipped rules", () => {
    const first = defaultMappingsFor(IDENTITY_FUNCTION, "stripe");
    const target = first[0];
    expect(target).toBeDefined();
    if (target !== undefined) target.targetFieldPath = "mutated";

    expect(defaultMappingsFor(IDENTITY_FUNCTION, "stripe")[0]?.targetFieldPath).not.toBe(
      "mutated"
    );
  });

  it("has none for a function with no providers", () => {
    expect(defaultMappingsFor("billing", "stripe")).toEqual([]);
  });
});
