/**
 * Resolves — and vets — the Postgres database the test suite may use.
 *
 * Imported by both `tests/global-setup.ts`, which builds the schema once per
 * run, and `tests/setup.ts`, which pins it for every worker. One definition of
 * "the test database" in one place: the two must agree, and a mismatch would
 * show up as tests querying tables that exist somewhere else.
 *
 * The old SQLite harness got its safety for free — the test database was a file
 * with a different name, so no `DATABASE_URL` typo could reach the dev data.
 * On Postgres that guarantee has to be built, which is what the checks in
 * `resolveTestDatabase` are: the suite runs inside a named, non-`public` schema
 * and drops that schema on every run, so the worst a misconfiguration can do is
 * destroy a schema created for this purpose.
 */

import { readFileSync } from "node:fs";

const KEY = "TEST_DATABASE_URL";

const HOW_TO_SET = `Add a line like this to .env (or export it):

  ${KEY}="postgresql://postgres:<password>@localhost:5432/integration_demo?schema=integration_demo_test"

The \`schema\` parameter is required and may not be \`public\`. The suite drops
and recreates that schema on every run, so it must be one that exists only for
testing; everything in \`public\` — your dev data — is then untouchable.`;

/**
 * Reads a single key out of `.env`.
 *
 * Deliberately not `process.loadEnvFile()` or dotenv: those load the whole
 * file, which would put a developer's real `METRIFOX_API_BASE`, client ids and
 * page sizes into the test environment. Keeping every other test hermetic
 * against `.env` is the entire point of `tests/setup.ts`, so this reads exactly
 * the one key it needs and ignores the rest.
 */
function fromDotEnv(): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(".env", "utf8");
  } catch {
    return undefined;
  }

  const match = contents.match(new RegExp(`^\s*${KEY}\s*=\s*(.*)$`, "m"));
  if (!match?.[1]) return undefined;

  // Strip the optional quotes dotenv allows. No comment stripping: a `#` after
  // the value would be indistinguishable from one inside it.
  return match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
}

export interface TestDatabase {
  /** Full connection URL, safe to use as both `DATABASE_URL` and `DIRECT_URL`. */
  url: string;
  /** The `schema` parameter, already checked to be present and not `public`. */
  schema: string;
}

let cached: TestDatabase | undefined;

export function resolveTestDatabase(): TestDatabase {
  if (cached) return cached;

  const raw = process.env[KEY] ?? fromDotEnv();
  if (!raw) {
    throw new Error(
      `${KEY} is not set, and the test suite needs a Postgres database of its ` +
        `own.\n\n${HOW_TO_SET}`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${KEY} is not a valid URL.\n\n${HOW_TO_SET}`);
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `${KEY} must be a postgresql:// URL, not ${parsed.protocol}//. The ` +
        `suite moved off SQLite; a \`file:\` URL no longer works because the ` +
        `generated Prisma Client is built for Postgres and rejects it.` +
        `\n\n${HOW_TO_SET}`
    );
  }

  const schema = parsed.searchParams.get("schema");
  if (!schema) {
    throw new Error(
      `${KEY} has no \`schema\` parameter. It is required: the suite drops ` +
        `whichever schema it is told to use, and inferring one would mean ` +
        `dropping \`public\`.\n\n${HOW_TO_SET}`
    );
  }
  if (schema === "public") {
    throw new Error(
      `${KEY} points at the \`public\` schema, which the suite refuses to ` +
        `use — it drops its schema on every run, and in \`public\` that is ` +
        `someone's dev data.\n\n${HOW_TO_SET}`
    );
  }

  cached = { url: raw, schema };
  return cached;
}
