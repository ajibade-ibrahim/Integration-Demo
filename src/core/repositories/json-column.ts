/**
 * Helpers for JSON held in TEXT columns.
 *
 * `customFields`, `providerMetadata` and `errorsJson` are `String` rather
 * than `Json`, a shape inherited from when the tests ran on SQLite, where
 * Prisma has no `Json` type. Postgres does, and promoting these to `jsonb`
 * would retire this module — see the header of prisma/schema.prisma for why
 * that is a separate change.
 *
 * Until then, reads must tolerate anything: a hand-edited row or a value
 * written by an older schema should degrade to a default rather than crash a
 * sync mid-run.
 */

export function readJsonObject(raw: string | null | undefined): Record<string, string> {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
      else if (value !== null && value !== undefined) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function writeJsonObject(value: Record<string, string>): string {
  return JSON.stringify(value);
}

export function readJsonArray<T>(raw: string | null | undefined): T[] {
  if (raw === null || raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function writeJsonArray<T>(value: readonly T[]): string {
  return JSON.stringify(value);
}

/** Space-joined scope lists, as stored on OAuthToken.grantedScopes. */
export function readScopeList(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return raw.split(" ").filter((s) => s !== "");
}

export function writeScopeList(scopes: readonly string[]): string {
  return [...scopes].sort().join(" ");
}
