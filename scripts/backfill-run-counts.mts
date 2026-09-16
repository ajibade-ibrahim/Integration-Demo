/**
 * Carry SyncRun's per-object counts across the column change.
 *
 * `customerCount`/`contactCount` became `recordCountsJson`, and `prisma db push`
 * would drop the old pair rather than migrate it. Run this *before* the push:
 * it adds the new column and fills it from the old ones, so the push then has
 * nothing left to lose and the run history survives.
 *
 * Idempotent — `IF NOT EXISTS` plus a WHERE that skips rows already carrying a
 * non-empty map, so running it twice is harmless.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

await prisma.$executeRawUnsafe(
  `ALTER TABLE "SyncRun" ADD COLUMN IF NOT EXISTS "recordCountsJson" TEXT NOT NULL DEFAULT '{}'`
);

const filled = await prisma.$executeRawUnsafe(
  `UPDATE "SyncRun"
      SET "recordCountsJson" = json_build_object(
            'customer', "customerCount",
            'contact',  "contactCount"
          )::text
    WHERE "recordCountsJson" = '{}'`
);

console.log(`Backfilled ${filled} sync run(s).`);
await prisma.$disconnect();
