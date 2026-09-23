/**
 * The catalog schema, and the per-function object scoping it introduced.
 *
 * Two things are pinned here, and the second is the one with teeth.
 *
 * The schema itself is ordinary: product and offering exist, carry the fields
 * the writer reads, and mark the derived association read-only the way contact
 * already does.
 *
 * The scoping is not ordinary. `TARGET_OBJECTS` is flat and global, so before
 * `validateMappings` took a function name there was nothing stopping a catalog
 * rule set from holding customer rules — it would validate, save, and then
 * write nothing on every sync forever, because `applyMappings` filters by
 * object and the catalog writers never see a customer. A mapping that silently
 * does nothing is a worse bug than one that is refused, and it is invisible
 * from every screen. These tests are what keep the refusal in place.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, CATALOG_FUNCTION, resetBootstrapForTests } from "@/core/bootstrap";
import { functionRegistry } from "@/core/registries/function-registry";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import {
  OBJECT_SCHEMAS,
  functionOwnsObject,
  mappableFields,
  objectsForFunction,
  resolveTargetField,
  schemasForFunction,
} from "@/core/object-schema";
import { BILLING_INTERVALS, TARGET_OBJECTS } from "@/core/types/common";
import type { FieldMappingRule } from "@/core/types/mapping";
import { formatOfferingPrice } from "@/core/repositories/catalog-repository";

beforeEach(() => {
  resetBootstrapForTests();
  bootstrap();
});

describe("the catalog schema", () => {
  it("writes product, then offering, then feature, in that order", () => {
    // Order is not presentational: both children resolve their product through
    // the index the product writer builds, so putting either first would unlink
    // the whole catalog on a first sync and quietly relink it on the second.
    //
    // For a feature the consequence is worse than for an offering, because
    // there is no relink pass to quietly fix it on the second run — see the
    // `externalProductId` comment on the model.
    expect(objectsForFunction(CATALOG_FUNCTION)).toEqual([
      "product",
      "offering",
      "productFeature",
    ]);
  });

  it("agrees with what the function declares it syncs", () => {
    // `dataModels` drives the picker's "Writes: …" line, `objectsForFunction`
    // drives the sync. A divergence would advertise one thing and do another.
    expect([...functionRegistry.require(CATALOG_FUNCTION).dataModels].sort()).toEqual(
      [...objectsForFunction(CATALOG_FUNCTION)].sort()
    );
  });

  it("requires a name on both objects", () => {
    // Both writers reject a nameless record, so a schema that did not mark
    // these required would let a default mapping omit one and produce a
    // rejection for every record of every sync.
    for (const object of ["product", "offering"] as const) {
      const name = OBJECT_SCHEMAS[object].fields.find((f) => f.name === "name");
      expect(name?.required, `${object}.name`).toBe(true);
    }
  });

  it("offers the billing intervals the writer accepts", () => {
    const interval = OBJECT_SCHEMAS.offering.fields.find(
      (f) => f.name === "interval"
    );
    // The editor's dropdown and the writer's guard read the same list; if they
    // diverged the UI would offer a value the writer then warns about.
    expect(interval?.enumValues).toEqual(BILLING_INTERVALS);
  });

  it("does not let a user map the derived product association", () => {
    // Same reason as `contact.associatedCustomerId`: the column holds our
    // internal UUID, and offering it as a target invites a foreign id into it.
    expect(
      resolveTargetField("offering", "associatedProductId")
    ).toMatchObject({ readOnly: true });

    expect(mappableFields("offering").map((f) => f.name)).not.toContain(
      "associatedProductId"
    );
  });

  it("gives every target object exactly one owning function", () => {
    // A stored `FieldMapping.targetObject` has to resolve to one writer. Two
    // functions claiming an object would make "which writer runs" depend on
    // which function the rule happened to be saved under.
    for (const object of TARGET_OBJECTS) {
      const owners = functionRegistry
        .getAll()
        .map((d) => d.name)
        .filter((name) => functionOwnsObject(name, object));

      expect(owners, `${object} is owned by ${owners.join(", ") || "nothing"}`).toHaveLength(1);
    }
  });
});

describe("function scoping of mapping rules", () => {
  const customerRule: FieldMappingRule = {
    sourceFieldPath: "name",
    targetObject: "customer",
    targetFieldPath: "name",
    transform: "none",
  };

  const productRule: FieldMappingRule = {
    sourceFieldPath: "name",
    targetObject: "product",
    targetFieldPath: "name",
    transform: "none",
  };

  it("refuses a customer rule saved under catalog", () => {
    const result = validateMappings(CATALOG_FUNCTION, [customerRule]);

    expect(result.valid).toBe(false);
    expect(result.violations[0]?.field).toBe("targetObject");
    // The message must not read "not a known target object" — customer is
    // perfectly real, and sending the user to hunt for a typo would waste
    // their time. It should say which objects this function does write.
    expect(result.violations[0]?.message).toContain("catalog");
    expect(result.violations[0]?.message).toContain("product");
  });

  it("refuses a product rule saved under identity", () => {
    const result = validateMappings("identity", [productRule]);
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.field).toBe("targetObject");
  });

  it("accepts each rule under the function that owns its object", () => {
    expect(validateMappings("identity", [customerRule]).valid).toBe(true);
    expect(validateMappings(CATALOG_FUNCTION, [productRule]).valid).toBe(true);
  });

  it("refuses everything for a function that writes no objects", () => {
    // `usage` is declared with no objects and no provider. A rule set saved
    // against it could never be written by anything, so accepting one would be
    // storing data with no reader.
    //
    // This used to name `agreement`, which now writes two objects. Some
    // declared-but-unbuilt function has to stand in here, and the test is worth
    // re-pointing rather than deleting: the "writes no objects" branch of the
    // validator is only reachable through one.
    expect(objectsForFunction("usage")).toEqual([]);

    const result = validateMappings("usage", [customerRule]);
    expect(result.valid).toBe(false);
    expect(result.violations[0]?.message).toContain("no objects");
  });

  it("shows the editor only the objects the function being edited owns", () => {
    // What the mapping page renders. Offering Customer as a target while
    // editing a catalog mapping is exactly how the silent-no-op rule gets
    // created in the first place.
    expect(schemasForFunction(CATALOG_FUNCTION).map((s) => s.object)).toEqual([
      "product",
      "offering",
      "productFeature",
    ]);
    expect(schemasForFunction("identity").map((s) => s.object)).toEqual([
      "customer",
      "contact",
    ]);
    expect(schemasForFunction("agreement").map((s) => s.object)).toEqual([
      "agreement",
      "subscription",
      "agreementItem",
    ]);
    expect(schemasForFunction("usage")).toEqual([]);
  });
});

/**
 * The catalog page formats a stored price; the Stripe handler formats an
 * incoming one. Two call sites, the same currency-exponent trap, so this is
 * pinned in both places deliberately rather than by oversight.
 */
describe("formatting a stored offering price", () => {
  const base = { amountMinor: 4900, currency: "usd", interval: "month", intervalCount: 1 };

  it("reads back what the writer stored", () => {
    expect(formatOfferingPrice(base)).toBe("$49/month");
  });

  it("does not divide a zero-decimal currency", () => {
    expect(formatOfferingPrice({ ...base, currency: "jpy" })).toBe("¥4,900/month");
  });

  it("drops the interval for a one-time price", () => {
    expect(formatOfferingPrice({ ...base, interval: "one_time" })).toBe("$49");
  });

  it("pluralises a multi-unit interval", () => {
    expect(formatOfferingPrice({ ...base, intervalCount: 3 })).toBe(
      "$49/3 months"
    );
  });

  it("has nothing to show without both an amount and a currency", () => {
    // An amount alone is not a price: 4900 is $49 or ¥4,900 depending on a
    // column this row does not have.
    expect(formatOfferingPrice({ ...base, amountMinor: null })).toBeUndefined();
    expect(formatOfferingPrice({ ...base, currency: null })).toBeUndefined();
  });
});
