/**
 * Builds the schema the tests that need a database run against.
 *
 * Runs once per `vitest` invocation, before any worker starts. The dev database
 * is deliberately never used: a test that deletes rows should not be one
 * `DATABASE_URL` typo away from someone's demo data. That isolation now comes
 * from a dedicated Postgres schema rather than a separate SQLite file — see
 * `tests/test-database-url.ts` for the checks that enforce it.
 */

import { execSync } from "node:child_process";

import { resolveTestDatabase } from "./test-database-url";

export default function setup(): void {
  const { url, schema } = resolveTestDatabase();

  /*
   * Both variables, pointed at the same place, and the pairing is load-bearing.
   *
   * The schema declares `directUrl = env("DIRECT_URL")`, and `db push` runs its
   * DDL down that route rather than `url`. Setting only DATABASE_URL would
   * therefore build the test schema in whatever DIRECT_URL happens to name —
   * the dev database, or worse, production. There is no pooler in front of a
   * test database, so one value serves both roles.
   *
   * Passing them in the child's environment also keeps the URL off the command
   * line, where its `&` separators would need shell-specific quoting; the
   * Prisma CLI reads the datasource from the schema, which reads these.
   */
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };

  /*
   * Start from nothing, so a schema change between runs cannot leave a stale
   * table shape behind.
   *
   * Explicit DDL rather than `db push --force-reset`, because the blast radius
   * of that flag is a Prisma implementation detail — whether it drops the
   * schema named in the URL or the whole database is not something to discover
   * from a wrong guess. `DROP SCHEMA` names its target, and
   * `resolveTestDatabase` has already refused to let that target be `public`.
   */
  run("npx prisma db execute --schema prisma/schema.prisma --stdin", env, {
    input: `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`,
  });

  run("npx prisma db push --skip-generate", env);
}

/**
 * Runs a Prisma CLI command, and reports what it said when it fails.
 *
 * `stdio: "pipe"` keeps a successful run quiet, but on failure execSync throws
 * "Command failed" with the diagnosis stranded in the captured stderr. The
 * likely failures here are all ones that message would name outright — wrong
 * password, no such database, server not running — so re-throwing with the
 * output attached is the difference between a fix and a guess.
 */
function run(
  command: string,
  env: NodeJS.ProcessEnv,
  options: { input?: string } = {}
): void {
  try {
    execSync(command, { ...options, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (cause) {
    const { stderr, stdout } = cause as { stderr?: Buffer; stdout?: Buffer };
    const output = [stderr?.toString(), stdout?.toString()]
      .filter((part) => part !== undefined && part.trim() !== "")
      .join("\n")
      .trim();

    throw new Error(
      `Could not prepare the test database.\n\n${command}\n\n${
        output || String(cause)
      }`,
      { cause }
    );
  }
}
