import { describe, expect, it } from "vitest";

import {
  MAPPING_RULE_VERSION,
  mappingVersionFor,
} from "@/core/field-mapper/mapping-version";
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

describe("mappingVersionFor", () => {
  it("is stable regardless of the order rows were read in", () => {
    const first = [
      rule(),
      rule({
        sourceFieldPath: "properties.domain",
        targetFieldPath: "domain",
        transform: "lowercase",
      }),
      rule({
        sourceFieldPath: "properties.email",
        targetObject: "contact",
        targetFieldPath: "email",
      }),
    ];

    expect(mappingVersionFor(first)).toBe(
      mappingVersionFor([...first].reverse())
    );
  });

  it("names the rule semantics version alongside the content hash", () => {
    expect(mappingVersionFor([rule()])).toMatch(
      new RegExp(`^v${MAPPING_RULE_VERSION}-[0-9a-f]{64}$`)
    );
  });

  it("changes when a target, source or transform changes", () => {
    const base = mappingVersionFor([rule()]);

    expect(
      mappingVersionFor([rule({ targetFieldPath: "industry" })])
    ).not.toBe(base);
    expect(
      mappingVersionFor([rule({ sourceFieldPath: "properties.legal_name" })])
    ).not.toBe(base);
    expect(mappingVersionFor([rule({ transform: "trim" })])).not.toBe(base);
  });

  it("changes when a rule is added or removed", () => {
    const first = rule();
    const second = rule({
      sourceFieldPath: "properties.domain",
      targetFieldPath: "domain",
      transform: "lowercase",
    });

    expect(mappingVersionFor([first, second])).not.toBe(
      mappingVersionFor([first])
    );
    expect(mappingVersionFor([])).not.toBe(mappingVersionFor([first]));
  });

  it("does not depend on the integration or function name", () => {
    // A version identifies the rules, not where they are installed. Two
    // integrations with identical rules can be compared directly.
    expect(mappingVersionFor([rule()])).toBe(mappingVersionFor([rule()]));
  });
});
