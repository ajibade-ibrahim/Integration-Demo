/**
 * The migration's decisions, without the database.
 *
 * A migration is the one kind of code that runs against real data once and is
 * then never exercised again. Everything in `mapping-retarget.ts` is pure for
 * that reason, and everything worth arguing about — which of two legacy rules
 * survives, what happens to an integration a user already fixed by hand, when a
 * value is safe to move out of `customFields` — is pinned here rather than
 * discovered on someone's tenant.
 *
 * Two properties matter more than any single case: the plan is **idempotent**
 * (running it against its own output produces nothing) and **deterministic**
 * (input order cannot change the outcome, so a dry run and the apply that
 * follows it agree).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { validateMappings } from "@/core/field-mapper/field-mapper";
import {
  planEmailBackfill,
  planMappingRetarget,
  type StoredMappingRule,
} from "@/core/identity/mapping-retarget";
import type { FieldMappingRule } from "@/core/types/mapping";

beforeAll(() => {
  // `crossRef.stripe` only validates against a populated provider registry.
  bootstrap();
});

/** Rule rows with generated ids, so a test only states what it cares about. */
function stored(
  rules: Array<Partial<StoredMappingRule> & { targetFieldPath: string }>
): StoredMappingRule[] {
  return rules.map((rule, index) => ({
    id: `rule-${String(index + 1).padStart(2, "0")}`,
    targetObject: "customer",
    sourceFieldPath: "email",
    transform: "lowercase",
    ...rule,
  }));
}

function plan(
  rules: StoredMappingRule[],
  providerName = "stripe",
  functionName = "identity"
) {
  return planMappingRetarget({ providerName, functionName, rules });
}

/** The plan's own output, fed back in as rows — for the idempotence check. */
function asStored(rules: readonly FieldMappingRule[]): StoredMappingRule[] {
  return rules.map((rule, index) => ({
    id: `next-${index}`,
    targetObject: rule.targetObject,
    sourceFieldPath: rule.sourceFieldPath,
    targetFieldPath: rule.targetFieldPath,
    transform: rule.transform,
  }));
}

describe("retargeting the account email", () => {
  it("moves customFields.email onto the column, in place", () => {
    const result = plan(stored([{ targetFieldPath: "customFields.email" }]));

    expect(result.retarget).toEqual([
      { id: "rule-01", from: "customFields.email", to: "email" },
    ]);
    expect(result.remove).toEqual([]);
  });

  it("moves customFields.primary_email too", () => {
    const result = plan(
      stored([
        {
          targetFieldPath: "customFields.primary_email",
          sourceFieldPath: "primary_email",
        },
      ]),
      "metrifox"
    );

    expect(result.retarget[0]?.to).toBe("email");
  });

  it("keeps the source path and the transform the user had", () => {
    // The mandate is the target path. Rewriting `trim` to the default
    // `lowercase` would be a second, unannounced change — and nothing depends
    // on the stored case, because `normalizeEmail` lowercases before matching.
    const result = plan(
      stored([
        {
          targetFieldPath: "customFields.email",
          sourceFieldPath: "billing.contact_email",
          transform: "trim",
        },
      ])
    );

    expect(result.result).toEqual([
      {
        sourceFieldPath: "billing.contact_email",
        targetObject: "customer",
        targetFieldPath: "email",
        transform: "trim",
      },
    ]);
  });

  it("leaves a contact's customFields.email alone", () => {
    // The legacy keys are only legacy on a customer. `contact.email` has always
    // been a column, so a contact custom field of that name is something else
    // entirely and none of this script's business.
    const result = plan(
      stored([{ targetObject: "contact", targetFieldPath: "customFields.email" }])
    );

    expect(result.empty).toBe(true);
  });

  it("deletes the legacy rule when the column is already mapped", () => {
    // The half-migrated case: somebody added the mapping by hand. Their rule
    // and their source field survive; the leftover goes, because side by side
    // the two write the same address twice on every record.
    const result = plan(
      stored([
        { targetFieldPath: "email", sourceFieldPath: "contact_email" },
        { targetFieldPath: "customFields.email" },
      ])
    );

    expect(result.retarget).toEqual([]);
    expect(result.remove).toEqual([
      {
        id: "rule-02",
        targetFieldPath: "customFields.email",
        reason: "customer.email is already mapped from 'contact_email'",
      },
    ]);
  });

  it("keeps exactly one when both legacy targets are present", () => {
    // Retargeting both would collide on the unique index and, if it did not,
    // would fail `validateMappings` as a duplicate target.
    const result = plan(
      stored([
        {
          targetFieldPath: "customFields.primary_email",
          sourceFieldPath: "primary_email",
        },
        { targetFieldPath: "customFields.email" },
      ])
    );

    expect(result.retarget).toEqual([
      { id: "rule-02", from: "customFields.email", to: "email" },
    ]);
    expect(result.remove.map((entry) => entry.id)).toEqual(["rule-01"]);
    expect(result.remove[0]?.reason).toContain("keeping 'email'");
  });

  it("picks the same survivor whichever order the rows arrive in", () => {
    // Postgres does not promise row order, and a dry run that reports one
    // choice followed by an apply that makes the other is worse than either.
    const rules = stored([
      { targetFieldPath: "customFields.email" },
      {
        targetFieldPath: "customFields.primary_email",
        sourceFieldPath: "primary_email",
      },
    ]);

    expect(plan(rules).retarget).toEqual(plan([...rules].reverse()).retarget);
  });

  it("leaves every other rule untouched", () => {
    const result = plan(
      stored([
        { targetFieldPath: "name", sourceFieldPath: "name", transform: "trim" },
        { targetFieldPath: "customFields.email" },
        {
          targetFieldPath: "customFields.currency",
          sourceFieldPath: "currency",
          transform: "none",
        },
      ])
    );

    expect(result.result.map((rule) => rule.targetFieldPath).sort()).toEqual([
      "customFields.currency",
      "email",
      "name",
    ]);
  });
});

describe("defaults a connection is too old to have", () => {
  it("adds Metrifox's crossRef.stripe", () => {
    // The `payments_stripe_customers` join. It shipped as a default after
    // connections already existed, so `seedMappingsIfEmpty` can never deliver
    // it and only a migration reaches those integrations.
    const result = plan(
      stored([{ targetFieldPath: "name", sourceFieldPath: "display_name" }]),
      "metrifox"
    );

    expect(result.add).toEqual([
      {
        sourceFieldPath: "stripe_customer_id",
        targetObject: "customer",
        targetFieldPath: "crossRef.stripe",
        transform: "trim",
      },
    ]);
  });

  it("does not add it twice", () => {
    const result = plan(
      stored([
        { targetFieldPath: "name", sourceFieldPath: "display_name" },
        {
          targetFieldPath: "crossRef.stripe",
          sourceFieldPath: "some_other_field",
        },
      ]),
      "metrifox"
    );

    expect(result.add).toEqual([]);
  });

  it("adds nothing to a function this integration does not map", () => {
    // No rows means the function is not configured. Seeding a single rule into
    // it would produce a config no default ever produced.
    expect(plan([], "metrifox").add).toEqual([]);
    expect(plan(stored([{ targetFieldPath: "name" }]), "metrifox", "support").add)
      .toEqual([]);
  });

  it("adds nothing to a provider with no late defaults", () => {
    expect(plan(stored([{ targetFieldPath: "name" }]), "stripe").add).toEqual([]);
    expect(plan(stored([{ targetFieldPath: "name" }]), "hubspot").add).toEqual([]);
  });
});

describe("the plan as a whole", () => {
  it("produces a rule set the editor would accept", () => {
    // The same gate a user's save goes through. A migration that writes a
    // config the app then refuses is a connection that stops syncing with no
    // event to point at.
    const result = plan(
      stored([
        { targetFieldPath: "name", sourceFieldPath: "display_name" },
        {
          targetFieldPath: "customFields.primary_email",
          sourceFieldPath: "primary_email",
        },
      ]),
      "metrifox"
    );

    expect(validateMappings("identity", result.result).violations).toEqual([]);
  });

  it("finds nothing to do on a second run", () => {
    const first = plan(
      stored([
        { targetFieldPath: "name", sourceFieldPath: "display_name" },
        {
          targetFieldPath: "customFields.primary_email",
          sourceFieldPath: "primary_email",
        },
      ]),
      "metrifox"
    );

    const second = planMappingRetarget({
      providerName: "metrifox",
      functionName: "identity",
      rules: asStored(first.result),
    });

    expect(second.empty).toBe(true);
  });

  it("reports empty for an integration that never used the legacy keys", () => {
    expect(
      plan(stored([{ targetFieldPath: "email", sourceFieldPath: "email" }])).empty
    ).toBe(true);
  });
});

describe("backfilling the rows already synced", () => {
  it("moves the address into the column and drops the key", () => {
    // Without this the migration appears to do nothing: the retargeted rule
    // only takes effect on the next sync, and a tenant that has stopped syncing
    // would keep a null column forever.
    expect(
      planEmailBackfill({
        email: null,
        customFields: { email: "billing@acme.example", currency: "usd" },
      })
    ).toEqual({
      kind: "promote",
      email: "billing@acme.example",
      customFields: { currency: "usd" },
    });
  });

  it("reads primary_email as well", () => {
    expect(
      planEmailBackfill({
        email: null,
        customFields: { primary_email: "accounts@northwind.example" },
      })
    ).toEqual({
      kind: "promote",
      email: "accounts@northwind.example",
      customFields: {},
    });
  });

  it("drops the duplicate when the column already agrees", () => {
    // Case-insensitively: the column may have been written through `lowercase`
    // while the custom field was written through `trim`.
    expect(
      planEmailBackfill({
        email: "billing@acme.example",
        customFields: { email: "Billing@Acme.example" },
      })
    ).toEqual({ kind: "deduplicate", customFields: {} });
  });

  it("leaves both alone when they disagree", () => {
    // A migration is the wrong place to decide which address a company uses,
    // and the custom field is the older of the two.
    const decision = planEmailBackfill({
      email: "new@acme.example",
      customFields: { email: "old@acme.example" },
    });

    expect(decision.kind).toBe("skip");
    expect(decision).toMatchObject({
      reason: expect.stringContaining("new@acme.example"),
    });
  });

  it("refuses a malformed address, exactly as the writer does", () => {
    // `record-writer` warns and leaves the column unset rather than rejecting
    // the company. A value this accepted and the writer did not — or the
    // reverse — would flip on the next sync.
    const decision = planEmailBackfill({
      email: null,
      customFields: { email: "not-an-email" },
    });

    expect(decision.kind).toBe("skip");
    // And critically, the value stays where it is rather than being deleted.
    expect(decision).toMatchObject({
      reason: expect.stringContaining("left in customFields"),
    });
  });

  it("does nothing to a customer with no legacy key", () => {
    expect(
      planEmailBackfill({ email: null, customFields: { currency: "usd" } })
    ).toEqual({ kind: "skip", reason: "no legacy key" });
  });

  it("ignores a blank legacy key rather than nulling the column with it", () => {
    expect(
      planEmailBackfill({ email: null, customFields: { email: "  " } })
    ).toEqual({ kind: "skip", reason: "no legacy key" });
  });

  it("prefers `email` when a record somehow carries both", () => {
    expect(
      planEmailBackfill({
        email: null,
        customFields: { email: "a@x.example", primary_email: "b@x.example" },
      })
    ).toMatchObject({ kind: "promote", email: "a@x.example" });
  });
});
