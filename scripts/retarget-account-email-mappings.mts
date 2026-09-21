/**
 * Move already-connected integrations onto the identity-era mapping defaults.
 *
 *   npx tsx scripts/retarget-account-email-mappings.mts            # dry run
 *   npx tsx scripts/retarget-account-email-mappings.mts --apply
 *
 * Dry run by default, and not out of politeness: this edits mappings a user
 * configured and columns a sync wrote, on every integration in the database. A
 * migration whose first run is also its only run gives nobody a chance to read
 * what it decided.
 *
 * ## What it does, and why a script has to
 *
 * `seedMappingsIfEmpty` bails when an integration already has any mapping
 * (`mapping-repository.ts:84`), so a connection made before a default changed
 * never sees the change. Two changed:
 *
 *   - The account email moved from `customFields.email` / `customFields.
 *     primary_email` to the first-class `customer.email` that identity
 *     resolution matches on.
 *   - Metrifox gained `stripe_customer_id → crossRef.stripe`, the
 *     `payments_stripe_customers` join.
 *
 * The decisions live in `src/core/identity/mapping-retarget.ts` so they can be
 * tested; this file is the I/O around them. It also backfills the rows already
 * synced — without that the migration looks like it did nothing, because every
 * existing customer keeps a null `email` column until its integration next
 * runs.
 *
 * Re-running is safe and reports no changes: every step is a move to a state
 * that is already correct on the second pass.
 */

import { PrismaClient } from "@prisma/client";

import { bootstrap } from "../src/core/bootstrap";
import { validateMappings } from "../src/core/field-mapper/field-mapper";
import {
  ACCOUNT_EMAIL_TARGET,
  planEmailBackfill,
  planMappingRetarget,
} from "../src/core/identity/mapping-retarget";
import {
  readJsonObject,
  writeJsonObject,
} from "../src/core/repositories/json-column";

const apply = process.argv.includes("--apply");

// `crossRef.<provider>` validates its segment against the provider registry, so
// an unbootstrapped run would reject the very rule it is here to add.
bootstrap();

const prisma = new PrismaClient();

const counts = {
  retargeted: 0,
  removed: 0,
  added: 0,
  promoted: 0,
  deduplicated: 0,
  refusedCustomers: 0,
  invalidGroups: 0,
};

/** Integrations that end up mapping `customer.email`, so their rows can move. */
const emailMapped = new Set<string>();

const integrations = await prisma.integration.findMany({
  select: {
    id: true,
    providerName: true,
    instanceLabel: true,
    fieldMappings: {
      select: {
        id: true,
        functionName: true,
        targetObject: true,
        sourceFieldPath: true,
        targetFieldPath: true,
        transform: true,
      },
      orderBy: { id: "asc" },
    },
  },
  orderBy: { id: "asc" },
});

console.log(
  `${apply ? "Applying" : "Dry run"} across ${integrations.length} integration(s).\n`
);

for (const integration of integrations) {
  const label = `${integration.providerName} · ${integration.instanceLabel} (${integration.id})`;

  const functionNames = [
    ...new Set(integration.fieldMappings.map((rule) => rule.functionName)),
  ].sort();

  for (const functionName of functionNames) {
    const rules = integration.fieldMappings.filter(
      (rule) => rule.functionName === functionName
    );

    const plan = planMappingRetarget({
      providerName: integration.providerName,
      functionName,
      rules,
    });

    const mapsEmail = plan.result.some(
      (rule) =>
        rule.targetObject === "customer" &&
        rule.targetFieldPath === ACCOUNT_EMAIL_TARGET
    );
    if (mapsEmail) emailMapped.add(integration.id);

    if (plan.empty) continue;

    console.log(`${label} · ${functionName}`);

    // The plan should never produce an invalid set. Checking anyway, and
    // skipping the whole group when it fails, is what keeps a bug here from
    // leaving one integration with a rule set its next sync cannot use.
    const validation = validateMappings(plan.result);
    if (!validation.valid) {
      counts.invalidGroups += 1;
      console.log(
        `  ! refused — the result would be invalid: ${validation.violations
          .map((violation) => `${violation.field}: ${violation.message}`)
          .join("; ")}\n`
      );
      continue;
    }

    for (const entry of plan.retarget) {
      console.log(`  ~ ${entry.from} → ${entry.to}`);
    }
    for (const entry of plan.remove) {
      console.log(`  - ${entry.targetFieldPath} — ${entry.reason}`);
    }
    for (const rule of plan.add) {
      console.log(
        `  + ${rule.sourceFieldPath} → ${rule.targetObject}.${rule.targetFieldPath} (new default)`
      );
    }
    console.log("");

    counts.retargeted += plan.retarget.length;
    counts.removed += plan.remove.length;
    counts.added += plan.add.length;

    if (!apply) continue;

    // One transaction per group. A half-applied group is the one outcome worth
    // preventing: deleting the legacy rule without retargeting the survivor
    // would leave the integration mapping no account email at all.
    await prisma.$transaction([
      ...plan.remove.map((entry) =>
        prisma.fieldMapping.delete({ where: { id: entry.id } })
      ),
      ...plan.retarget.map((entry) =>
        prisma.fieldMapping.update({
          where: { id: entry.id },
          data: { targetFieldPath: entry.to },
        })
      ),
      ...plan.add.map((rule) =>
        prisma.fieldMapping.create({
          data: {
            integrationId: integration.id,
            functionName,
            targetObject: rule.targetObject,
            sourceFieldPath: rule.sourceFieldPath,
            targetFieldPath: rule.targetFieldPath,
            transform: rule.transform,
          },
        })
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// The rows the old mappings already wrote
// ---------------------------------------------------------------------------

// Scoped to integrations that map `customer.email` after the rewrite. Anywhere
// else, a `customFields.email` key is a custom field somebody chose, not a
// leftover, and moving it would be taking data the user asked for.
for (const integrationId of [...emailMapped].sort()) {
  const customers = await prisma.customer.findMany({
    where: { integrationId },
    select: {
      id: true,
      externalSourceId: true,
      email: true,
      customFields: true,
    },
    orderBy: { id: "asc" },
  });

  const refused: string[] = [];
  let promoted = 0;
  let deduplicated = 0;

  for (const customer of customers) {
    const decision = planEmailBackfill({
      email: customer.email,
      customFields: readJsonObject(customer.customFields),
    });

    if (decision.kind === "skip") {
      if (decision.reason !== "no legacy key") {
        refused.push(`${customer.externalSourceId}: ${decision.reason}`);
      }
      continue;
    }

    if (decision.kind === "promote") promoted += 1;
    else deduplicated += 1;

    if (!apply) continue;

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        ...(decision.kind === "promote" ? { email: decision.email } : {}),
        customFields: writeJsonObject(decision.customFields),
      },
    });
  }

  counts.promoted += promoted;
  counts.deduplicated += deduplicated;
  counts.refusedCustomers += refused.length;

  if (promoted + deduplicated + refused.length === 0) continue;

  console.log(`customers of ${integrationId}`);
  if (promoted > 0) console.log(`  ~ ${promoted} address(es) moved into customer.email`);
  if (deduplicated > 0) {
    console.log(`  - ${deduplicated} duplicate custom field(s) dropped`);
  }
  // Named individually rather than counted. Each one is a record whose address
  // the resolver will not see once the legacy fallback goes, and a total is not
  // something anybody can act on.
  for (const line of refused) console.log(`  ! ${line}`);
  console.log("");
}

// ---------------------------------------------------------------------------

console.log("---");
console.log(`mappings retargeted:    ${counts.retargeted}`);
console.log(`legacy rules removed:   ${counts.removed}`);
console.log(`late defaults added:    ${counts.added}`);
console.log(`addresses promoted:     ${counts.promoted}`);
console.log(`duplicate keys dropped: ${counts.deduplicated}`);
console.log(`customers left alone:   ${counts.refusedCustomers}`);
if (counts.invalidGroups > 0) {
  console.log(`groups refused:         ${counts.invalidGroups}`);
}

if (!apply) {
  console.log("\nNothing was written. Re-run with --apply.");
}

await prisma.$disconnect();

// A non-zero exit on a refusal, so a deploy step that runs this stops rather
// than continuing past an integration it could not migrate.
if (counts.invalidGroups > 0) process.exit(1);
