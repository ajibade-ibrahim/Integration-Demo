/**
 * Database health check, and a prune of the rows that are stale by definition.
 *
 *   npm run db:check    — report only, changes nothing
 *   npm run db:prune    — report, then delete the expired rows
 *
 * The report exists because a schema change can leave *data* behind that the
 * new code will not accept, and `prisma db push` says nothing about that: it
 * reconciles columns, not contents. The load-bearing check is section 1, which
 * replays every stored rule set through the current validator. When
 * `validateMappings` became function-scoped, a rule targeting an object its
 * function does not write stopped being valid — and a stored rule like that
 * would not fail on save (it was saved long ago) but would silently write
 * nothing on every sync. Nothing else in the system would report it.
 *
 * The prune deliberately covers only three tables, all of which the schema
 * already documents as having a TTL:
 *
 *   DiscoveredField  — a cache of a provider's schema API, served for an hour.
 *   IntegrationDraft — a half-finished connect; losing one costs a re-pick.
 *   OAuthState       — an issued `state` awaiting its callback.
 *
 * Synced records, mappings, accounts and run history are never touched. Those
 * are the user's data, and "stale" is not a judgement this script is entitled
 * to make about them — an integration that has not synced in a year is not
 * garbage, it is an integration that has not synced in a year.
 */

import { PrismaClient } from "@prisma/client";
import { bootstrap } from "../src/core/bootstrap";
import { validateMappings } from "../src/core/field-mapper/field-mapper";
import { objectsForFunction } from "../src/core/object-schema";
import { functionRegistry } from "../src/core/registries/function-registry";
import { getSyncHandler } from "../src/core/registries/handler-registry";
import { isTargetObject, type TargetObject } from "../src/core/types/common";
import type { FieldTransform } from "../src/core/types/mapping";

/** Must match CACHE_TTL_MS in src/core/sync/discovery-service.ts. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const prune = process.argv.includes("--prune");
const prisma = new PrismaClient();

bootstrap();

const now = Date.now();
const cacheCutoff = new Date(now - CACHE_TTL_MS);
let problems = 0;

function report(label: string, count: number, detail = ""): void {
  if (count > 0) problems += 1;
  const mark = count === 0 ? "ok  " : "WARN";
  console.log(`  [${mark}] ${label}: ${count}${detail}`);
}

// ---------------------------------------------------------------------------
console.log("\n1. Stored mapping rules, replayed through the current validator");
// ---------------------------------------------------------------------------

const ruleSets = await prisma.fieldMapping.groupBy({
  by: ["integrationId", "functionName"],
});

for (const group of ruleSets) {
  const [rows, integration] = await Promise.all([
    prisma.fieldMapping.findMany({
      where: { integrationId: group.integrationId, functionName: group.functionName },
    }),
    prisma.integration.findUnique({
      where: { id: group.integrationId },
      select: { instanceLabel: true },
    }),
  ]);

  const result = validateMappings(
    group.functionName,
    rows.map((row) => ({
      sourceFieldPath: row.sourceFieldPath,
      targetObject: row.targetObject as TargetObject,
      targetFieldPath: row.targetFieldPath,
      transform: row.transform as FieldTransform,
    }))
  );

  const name = `${integration?.instanceLabel ?? group.integrationId}/${group.functionName}`;
  report(`${name} (${rows.length} rules)`, result.valid ? 0 : result.violations.length);
  for (const violation of result.violations) {
    console.log(`         rule ${violation.index} (${violation.field}): ${violation.message}`);
  }
}
if (ruleSets.length === 0) console.log("  [ok  ] no mapping rules stored");

// ---------------------------------------------------------------------------
console.log("\n2. References this build no longer recognises");
// ---------------------------------------------------------------------------

const allRules = await prisma.fieldMapping.findMany({ select: { targetObject: true } });
report(
  "rules naming an unknown target object",
  allRules.filter((r) => !isTargetObject(r.targetObject)).length
);

const integrations = await prisma.integration.findMany({ include: { functions: true } });
const unsyncable = integrations.flatMap((i) =>
  i.functions
    .filter(
      (f) =>
        functionRegistry.get(f.functionName) === undefined ||
        getSyncHandler(f.functionName, i.providerName) === undefined
    )
    .map((f) => `${i.instanceLabel}/${f.functionName}`)
);
report("integration functions that cannot sync", unsyncable.length);
for (const entry of unsyncable) console.log(`         ${entry}`);

const cachePairs = await prisma.discoveredField.groupBy({
  by: ["functionName", "targetObject"],
  _count: true,
});
const orphanedCache = cachePairs.filter(
  (d) => !objectsForFunction(d.functionName).includes(d.targetObject as TargetObject)
);
report(
  "cached fields for a (function, object) pair that no longer exists",
  orphanedCache.reduce((sum, d) => sum + d._count, 0)
);

// ---------------------------------------------------------------------------
console.log("\n3. Unresolved associations (expected in small numbers; kept on purpose)");
// ---------------------------------------------------------------------------

report(
  "contacts whose company did not resolve",
  await prisma.contact.count({
    where: { customerId: null, externalCustomerId: { not: null } },
  }),
  " — they relink when the company syncs"
);
report(
  "offerings whose product did not resolve",
  await prisma.offering.count({
    where: { productId: null, externalProductId: { not: null } },
  }),
  " — they relink when the product syncs"
);
// Expected to be *zero*, not merely small, which is why it is reported
// separately from the offerings above rather than added to them. A feature's
// product id comes from the URL the sync called, so the product was listed in
// the same run; a non-zero figure means that product was rejected by the
// writer, and there is no relink pass that will ever clear it.
report(
  "product features whose product did not resolve",
  await prisma.productFeature.count({
    where: { productId: null, externalProductId: { not: null } },
  }),
  " — expected zero; a non-zero count means a product was rejected"
);
// Two edges, reported separately. An agreement's customer comes from the
// identity function and its offering from catalog, so a row can have either
// half linked and the other not — and one combined figure would be wrong about
// half of every such row.
report(
  "agreements whose customer did not resolve",
  await prisma.agreement.count({
    where: { customerId: null, externalCustomerId: { not: null } },
  }),
  " — they relink when identity syncs"
);
report(
  "agreements whose offering did not resolve",
  await prisma.agreement.count({
    where: { offeringId: null, externalOfferingId: { not: null } },
  }),
  " — they relink when the catalog syncs"
);
report(
  "line items whose offering did not resolve",
  await prisma.agreementItem.count({
    where: { offeringId: null, externalOfferingId: { not: null } },
  }),
  " — they relink when the catalog syncs"
);
// Not an unresolved association but the same class of thing: a fact about the
// row that is only visible if something says it out loud.
//
// The provider's own count against the lines we actually stored. These agreed
// on every row until one failed to write, which is the only way they can come
// apart — so unlike the two above, this figure is expected to be zero and a
// non-zero one means a rejected line, not a function waiting to be connected.
const subscriptions = await prisma.subscription.findMany({
  select: { itemCount: true, agreement: { select: { _count: { select: { items: true } } } } },
});
report(
  "subscriptions whose stored line count differs from the provider's",
  subscriptions.filter(
    (s) => s.itemCount !== null && s.itemCount !== s.agreement._count.items
  ).length,
  " — expected zero once every integration has synced since line items" +
    " existed; before that it counts rows that predate the table, and after" +
    " it a difference means a line was rejected"
);
report(
  "customers not yet linked to an account",
  await prisma.customer.count({ where: { customerAccountId: null } }),
  " — run identity resolution"
);

// ---------------------------------------------------------------------------
console.log("\n4. Runs left mid-flight by a crash");
// ---------------------------------------------------------------------------

report(
  "sync runs still marked running",
  await prisma.syncRun.count({ where: { status: "running" } })
);
report(
  "resolution runs still marked running",
  await prisma.identityResolutionRun.count({ where: { status: "running" } })
);

// ---------------------------------------------------------------------------
console.log(`\n5. Expired rows${prune ? " — deleting" : " — reporting only"}`);
// ---------------------------------------------------------------------------

const expired = {
  "discovered fields past their 1-hour cache TTL": await prisma.discoveredField.count({
    where: { fetchedAt: { lt: cacheCutoff } },
  }),
  "integration drafts past their TTL": await prisma.integrationDraft.count({
    where: { expiresAt: { lt: new Date(now) } },
  }),
  "oauth states past their TTL": await prisma.oAuthState.count({
    where: { expiresAt: { lt: new Date(now) } },
  }),
};

for (const [label, count] of Object.entries(expired)) {
  console.log(`  ${count === 0 ? "[ok  ]" : "[stale]"} ${label}: ${count}`);
}

if (prune) {
  const deleted = {
    discoveredField: (
      await prisma.discoveredField.deleteMany({ where: { fetchedAt: { lt: cacheCutoff } } })
    ).count,
    integrationDraft: (
      await prisma.integrationDraft.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })
    ).count,
    oAuthState: (
      await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })
    ).count,
  };
  console.log("\n  Deleted:", deleted);
  console.log(
    "  The discovery cache refills on demand — the next visit to a mapping editor\n" +
      "  re-reads the provider's schema, which is the point of it having a TTL."
  );
}

// ---------------------------------------------------------------------------
console.log(
  problems === 0
    ? "\nNo inconsistencies found. The stored data matches what the code expects.\n"
    : `\n${problems} check(s) reported something. See above.\n`
);

await prisma.$disconnect();
