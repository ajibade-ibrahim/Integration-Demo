/**
 * Generate the Postgres variant of `prisma/schema.prisma`.
 *
 * Why this exists rather than simply changing the datasource: Prisma's
 * `provider` must be a literal — it cannot read `env()` — and the generated
 * client is provider-specific, so a client built for `postgresql` refuses a
 * `file:` URL outright. One schema therefore cannot serve both.
 *
 * The repo's zero-infrastructure test story is worth keeping: `npm test`
 * builds a throwaway SQLite database and needs no server. So SQLite stays the
 * checked-in default for local dev and tests, and deployment generates this
 * variant at build time instead.
 *
 * That is only safe because the schema was written to be portable in the first
 * place — status/type columns are `String` rather than `enum`, JSON columns are
 * `String` rather than `Json` (see the header of `schema.prisma`). The two
 * files consequently differ by the datasource block and nothing else. If that
 * ever stops being true, this script is the wrong tool and the answer is to
 * move tests onto Postgres too.
 *
 *   npx tsx scripts/pg-schema.mts
 *
 * The output is generated, gitignored, and safe to delete.
 *
 * Note that `npm run build:deploy` is meant for a build environment. Running it
 * on a development machine also regenerates Prisma Client for Postgres, which
 * leaves local dev and tests unable to open the SQLite database until you run
 * `npx prisma generate` to put the SQLite client back.
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "prisma/schema.prisma";
const TARGET = "prisma/schema.postgres.prisma";

/**
 * Matches the whole datasource block. Deliberately strict: if the block is
 * edited into a shape this does not recognise, failing loudly beats emitting a
 * schema whose provider was silently left as SQLite — that mistake surfaces as
 * a confusing connection error at deploy time, long after the edit.
 */
const DATASOURCE = /datasource\s+db\s*\{[^}]*\}/;

const POSTGRES_DATASOURCE = `datasource db {
  provider = "postgresql"

  // Supabase's transaction pooler (port 6543). Prisma needs \`pgbouncer=true\`
  // on it, which disables prepared statements — the pooler cannot carry them
  // across the connections it multiplexes.
  url = env("DATABASE_URL")

  // An unpooled connection (port 5432). Migrations take advisory locks and run
  // DDL, neither of which survives transaction-mode pooling, so Prisma needs a
  // direct route for those even though the app itself never uses it.
  directUrl = env("DIRECT_URL")
}`;

const HEADER = `// GENERATED FILE — do not edit.
//
// Produced from ${SOURCE} by scripts/pg-schema.mts. Edit that file and
// re-run the script; anything changed here is lost on the next build.

`;

const source = readFileSync(SOURCE, "utf8");

if (!DATASOURCE.test(source)) {
  throw new Error(
    `Could not find a \`datasource db { ... }\` block in ${SOURCE}. ` +
      "The schema's shape changed; update scripts/pg-schema.mts to match."
  );
}

// Guard against the portability assumption quietly lapsing. Both types work on
// Postgres, so nothing would break at deploy — the damage is to the SQLite
// schema that tests and local dev still run against, which would stop matching.
const unportable = [...source.matchAll(/^\s*(?:enum\s|\w+\s+Json[\s?])/gm)];
if (unportable.length > 0) {
  throw new Error(
    `${SOURCE} now uses \`enum\` or \`Json\`, which SQLite cannot represent. ` +
      "Tests and local dev still run on SQLite, so this schema can no longer " +
      "serve both. Either revert to the String-modelled columns or move tests " +
      "onto Postgres and retire this script."
  );
}

writeFileSync(TARGET, HEADER + source.replace(DATASOURCE, POSTGRES_DATASOURCE));

console.log(`Wrote ${TARGET} (provider: postgresql)`);
