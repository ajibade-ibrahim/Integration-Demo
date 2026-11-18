/**
 * The "View synced data" link on an integration's function cards.
 *
 * The invariant is the same one the integration page gates on: a function that
 * writes records has somewhere to browse them, and one that does not has no
 * link. A null there is honest; a destination that shows an empty page would
 * read as a sync failure.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { functionDataHref } from "@/app/function-data-links";
import { bootstrap } from "@/core/bootstrap";
import { objectsForFunction } from "@/core/object-schema";
import { functionRegistry } from "@/core/registries/function-registry";

const INTEGRATION = "int_1";

beforeAll(() => {
  bootstrap();
});

describe("functionDataHref", () => {
  it("offers a destination for every function that writes records", () => {
    const writing = functionRegistry
      .getAll()
      .filter((definition) => objectsForFunction(definition.name).length > 0);

    expect(writing.map((definition) => definition.name).sort()).toEqual([
      "agreement",
      "billing",
      "catalog",
      "communication",
      "identity",
    ]);

    for (const definition of writing) {
      expect(functionDataHref(definition.name, INTEGRATION)).not.toBeNull();
    }
  });

  it("has no destination for declared-but-unbuilt functions", () => {
    expect(objectsForFunction("support")).toHaveLength(0);
    expect(objectsForFunction("usage")).toHaveLength(0);
    expect(functionDataHref("support", INTEGRATION)).toBeNull();
    expect(functionDataHref("usage", INTEGRATION)).toBeNull();
  });

  it("maps each function to its exact page", () => {
    expect(functionDataHref("identity", INTEGRATION)).toBe(
      `/customers?integration=${INTEGRATION}`
    );
    expect(functionDataHref("communication", INTEGRATION)).toBe(
      `/customers?tab=messages&integration=${INTEGRATION}`
    );
    expect(functionDataHref("catalog", INTEGRATION)).toBe(
      `/catalog?integration=${INTEGRATION}`
    );
    expect(functionDataHref("agreement", INTEGRATION)).toBe(
      `/agreements?integration=${INTEGRATION}`
    );
    expect(functionDataHref("billing", INTEGRATION)).toBe(
      `/billing?integration=${INTEGRATION}`
    );
  });
});
