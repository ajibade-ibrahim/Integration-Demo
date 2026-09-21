/**
 * The agreement schema, and the split it exists to express.
 *
 * Four things are pinned here, each guarding a decision that is cheap to make
 * now and expensive to reverse later:
 *
 *   1. the `agreementType` discriminator exists and every declared type is
 *      accepted — the column named in `bootstrap.ts` as the expensive retrofit;
 *   2. the two objects are separate, with the type-specific fields on the child
 *      and nothing duplicated across them;
 *   3. the write order is parent-first, which for this family is a correctness
 *      requirement rather than an optimization;
 *   4. an `agreement` rule set cannot contain customer or offering rules, the
 *      same cross-function isolation the catalog has.
 */

import { describe, expect, it } from "vitest";
import { bootstrap, AGREEMENT_FUNCTION } from "@/core/bootstrap";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import {
  functionOwnsObject,
  functionsInWriteOrder,
  mappableFields,
  objectsForFunction,
  schemasForFunction,
  OBJECT_SCHEMAS,
} from "@/core/object-schema";
import { functionRegistry } from "@/core/registries/function-registry";
import {
  AGREEMENT_STATUSES,
  AGREEMENT_TYPES,
  isAgreementStatus,
  isAgreementType,
} from "@/core/types/common";
import type { FieldMappingRule } from "@/core/types/mapping";

bootstrap();

const fieldNames = (object: "agreement" | "subscription"): string[] =>
  OBJECT_SCHEMAS[object].fields.map((f) => f.name);

describe("the agreement schema", () => {
  it("requires a name, because Stripe supplies none", () => {
    // The load-bearing constraint. `agreementDisplayName` exists to satisfy it,
    // and the shipped defaults must map it — `provider-defaults.test.ts` checks
    // that from this very declaration.
    const name = OBJECT_SCHEMAS.agreement.fields.find((f) => f.name === "name");
    expect(name?.required).toBe(true);
  });

  it("carries the type discriminator, with every declared type accepted", () => {
    const type = OBJECT_SCHEMAS.agreement.fields.find(
      (f) => f.name === "agreementType"
    );
    expect(type?.kind).toBe("enum");
    expect(type?.enumValues).toEqual(AGREEMENT_TYPES);

    // Only `subscription` has a provider behind it. The other three are
    // declared so that adding one is a handler rather than a data migration.
    expect(AGREEMENT_TYPES).toContain("subscription");
    for (const type of ["order_form", "contract", "deal"]) {
      expect(isAgreementType(type)).toBe(true);
    }
  });

  it("uses our status vocabulary rather than any provider's", () => {
    const status = OBJECT_SCHEMAS.agreement.fields.find(
      (f) => f.name === "status"
    );
    expect(status?.enumValues).toEqual(AGREEMENT_STATUSES);

    // Stripe's `unpaid`, `incomplete` and `incomplete_expired` are deliberately
    // absent — the handler folds them in. Salesforce's `Activated` likewise.
    expect(isAgreementStatus("unpaid")).toBe(false);
    expect(isAgreementStatus("incomplete")).toBe(false);
    expect(isAgreementStatus("Activated")).toBe(false);

    // `expired` and `canceled` are both terminal and both present, because a
    // contract that ran its term is not a customer who left.
    expect(isAgreementStatus("expired")).toBe(true);
    expect(isAgreementStatus("canceled")).toBe(true);
  });

  it("keeps the association ids read-only", () => {
    // Derived by the sync engine from the provider's own ids. Offering them as
    // mapping targets would invite a foreign id into a column of our UUIDs.
    for (const field of ["associatedCustomerId", "associatedOfferingId"]) {
      const def = OBJECT_SCHEMAS.agreement.fields.find((f) => f.name === field);
      expect(def?.readOnly).toBe(true);
    }
    expect(mappableFields("agreement").map((f) => f.name)).not.toContain(
      "associatedCustomerId"
    );
  });
});

describe("the subscription schema", () => {
  it("has no name of its own", () => {
    // Deliberate, not an oversight. This row extends exactly one agreement,
    // which already has a name; a second could only ever drift from it. It is
    // also why `provider-defaults.test.ts` reads required fields from the
    // schema instead of hardcoding `"name"`.
    expect(fieldNames("subscription")).not.toContain("name");
    expect(
      OBJECT_SCHEMAS.subscription.fields.filter((f) => f.required === true)
    ).toEqual([]);
  });

  it("holds the period dates, which is the reason it exists", () => {
    // "Which customers renew this month" is the question a subscription is
    // synced to answer, and it cannot be asked of a JSON blob or of a column
    // half the table has to leave null.
    for (const field of ["currentPeriodStart", "currentPeriodEnd", "trialEndsAt"]) {
      const def = OBJECT_SCHEMAS.subscription.fields.find(
        (f) => f.name === field
      );
      expect(def?.kind, field).toBe("date");
    }
  });

  it("shares no field with its parent", () => {
    // The split is only worth anything if each field lives in exactly one
    // place. A field on both would be two columns that must agree and cannot
    // be made to.
    const shared = fieldNames("agreement").filter((name) =>
      fieldNames("subscription").includes(name)
    );
    expect(shared).toEqual([]);
  });

  it("keeps the type-specific fields off the shared node", () => {
    // The whole argument for two tables: on one, none of these could ever be
    // NOT NULL, because a signed contract has no billing period.
    for (const field of [
      "currentPeriodEnd",
      "trialEndsAt",
      "cancelAtPeriodEnd",
      "itemCount",
    ]) {
      expect(fieldNames("agreement"), field).not.toContain(field);
    }
  });
});

describe("write order", () => {
  it("writes the agreement before its subscription", () => {
    // Not presentational and not merely efficient: `Subscription.agreementId`
    // is a required column, so a child written first is rejected outright.
    expect(objectsForFunction(AGREEMENT_FUNCTION)).toEqual([
      "agreement",
      "subscription",
    ]);
  });

  it("runs identity and catalog before agreement", () => {
    // An agreement's two parents are written by the other two functions, and
    // `IntegrationFunction` rows come back in whatever order Postgres likes.
    expect(
      functionsInWriteOrder(["agreement", "catalog", "identity"])
    ).toEqual(["identity", "catalog", "agreement"]);
  });

  it("sorts a function with no objects last rather than dropping it", () => {
    // It writes nothing, so it cannot be anyone's parent — but the engine still
    // has to iterate it, if only to fail on its missing handler.
    expect(functionsInWriteOrder(["usage", "identity"])).toEqual([
      "identity",
      "usage",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const asked = ["agreement", "identity"];
    functionsInWriteOrder(asked);
    expect(asked).toEqual(["agreement", "identity"]);
  });
});

describe("function scoping of agreement rules", () => {
  const rule = (
    targetObject: FieldMappingRule["targetObject"],
    targetFieldPath: string
  ): FieldMappingRule => ({
    sourceFieldPath: "x",
    targetObject,
    targetFieldPath,
    transform: "none",
  });

  it("declares exactly the objects it writes", () => {
    // Two independent declarations of the same list — `dataModels` in bootstrap
    // and `FUNCTION_OBJECTS` in the schema — with nothing in the type system
    // tying them together. This is the tie.
    expect(
      [...functionRegistry.require(AGREEMENT_FUNCTION).dataModels].sort()
    ).toEqual([...objectsForFunction(AGREEMENT_FUNCTION)].sort());
  });

  it("accepts rules for both of its own objects", () => {
    expect(
      validateMappings(AGREEMENT_FUNCTION, [
        rule("agreement", "name"),
        rule("subscription", "currentPeriodEnd"),
      ]).valid
    ).toBe(true);
  });

  it("refuses a rule targeting an object another function writes", () => {
    // An agreement references a customer and an offering, which makes this the
    // most tempting mistake in the codebase: the rule would validate against
    // the schema, save, and then write nothing on every sync.
    for (const object of ["customer", "offering"] as const) {
      const result = validateMappings(AGREEMENT_FUNCTION, [
        rule(object, "name"),
      ]);
      expect(result.valid, object).toBe(false);
      expect(result.violations[0]?.message).toContain("does not write");
    }

    expect(functionOwnsObject(AGREEMENT_FUNCTION, "customer")).toBe(false);
    expect(functionOwnsObject(AGREEMENT_FUNCTION, "offering")).toBe(false);
  });

  it("refuses an agreement rule under identity or catalog", () => {
    // The reverse direction, which is the one that would let a catalog editor
    // quietly write agreement fields.
    expect(validateMappings("catalog", [rule("agreement", "name")]).valid).toBe(
      false
    );
    expect(
      validateMappings("identity", [rule("subscription", "quantity")]).valid
    ).toBe(false);
  });

  it("shows the editor both sections and nothing else", () => {
    expect(
      schemasForFunction(AGREEMENT_FUNCTION).map((s) => s.label)
    ).toEqual(["Agreement", "Subscription"]);
  });

  it("offers no cross-reference targets", () => {
    // A cross-reference identifies a company, so it belongs on a customer.
    const result = validateMappings(AGREEMENT_FUNCTION, [
      rule("agreement", "crossRefs.hubspot"),
    ]);
    expect(result.valid).toBe(false);
  });
});
