/**
 * Fill `Integration.sourceAccountId` for connections made before it existed.
 *
 *   npx tsx scripts/backfill-source-accounts.mts            # dry run
 *   npx tsx scripts/backfill-source-accounts.mts --apply
 *
 * This is a backfill, not a credential event. It never retires keys: a key
 * written before the account was addressable is filled in when the next
 * resolution pass re-offers it, and retiring here would drop valid claims just
 * because they predate a column.
 *
 * A credential that does not name its account is left null — the fail-closed
 * state. HubSpot connections made before the token-info lookup was added will
 * be picked up on their next OAuth refresh or reconnect.
 *
 * Dry run by default, for the same reason the mapping migration is: this writes
 * a column that decides which keys a later re-key retires.
 */

import { bootstrap } from "../src/core/bootstrap";
import { sourceAccountIdFromMetadata } from "../src/core/identity/source-account";
import { readJsonObject } from "../src/core/repositories/json-column";
import { prisma } from "../src/lib/prisma";

const apply = process.argv.includes("--apply");

bootstrap();

const integrations = await prisma.integration.findMany({
  where: { sourceAccountId: null },
  include: { token: { select: { providerMetadata: true } } },
  orderBy: [{ providerName: "asc" }, { createdAt: "asc" }],
});

let eligible = 0;
let skipped = 0;
let updated = 0;

for (const integration of integrations) {
  if (integration.token === null) {
    skipped += 1;
    continue;
  }

  const metadata = readJsonObject(integration.token.providerMetadata);
  const sourceAccountId = sourceAccountIdFromMetadata(
    integration.providerName,
    metadata
  );
  if (sourceAccountId === null) {
    skipped += 1;
    console.log(
      `  skip ${integration.providerName} ${integration.id}: credential names no account`
    );
    continue;
  }

  eligible += 1;
  const shown = sourceAccountId === "" ? '"" (global)' : sourceAccountId;
  console.log(
    `  ${apply ? "set " : "would set"} ${integration.providerName} ${integration.id} -> ${shown}`
  );

  if (apply) {
    const result = await prisma.integration.updateMany({
      where: { id: integration.id, sourceAccountId: null },
      data: { sourceAccountId },
    });
    updated += result.count;
  }
}

console.log("");
console.log(`integrations without an account:   ${integrations.length}`);
console.log(`credentials naming an account:     ${eligible}`);
console.log(`credentials naming none:           ${skipped}`);
console.log(
  apply
    ? `updated:                           ${updated}`
    : "dry run — pass --apply to persist"
);

await prisma.$disconnect();
