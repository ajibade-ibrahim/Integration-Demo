/**
 * Creates a throwaway SQLite database for the tests that need one.
 *
 * Runs once per `vitest` invocation, before any worker starts. The dev database
 * is deliberately never used: a test that truncates tables should not be one
 * `DATABASE_URL` typo away from deleting someone's demo data.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

/** Relative to `prisma/`, which is how Prisma resolves SQLite file URLs. */
export const TEST_DATABASE_URL = "file:./test.db";

export default function setup(): void {
  process.env["DATABASE_URL"] = TEST_DATABASE_URL;

  // Start from nothing so a schema change between runs cannot leave a stale
  // table shape behind.
  rmSync("prisma/test.db", { force: true });
  rmSync("prisma/test.db-journal", { force: true });

  execSync("npx prisma db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
