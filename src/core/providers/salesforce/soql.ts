/**
 * SOQL construction for the Salesforce handler.
 *
 * Kept separate and pure because it is the one place user-controlled strings
 * reach a query language. Mapping rules carry source field paths the user typed
 * into the mapping editor, and those become the SELECT list. Interpolating them
 * unchecked is a SOQL injection: a source path of `Name FROM Account WHERE
 * Id != null--` would be a working query.
 *
 * Salesforce has no parameter binding for field names in the REST query API, so
 * the defence has to be a whitelist on shape. A legitimate field is an
 * identifier, optionally dotted for relationship traversal (`Account.Owner.Name`,
 * which Salesforce caps at five levels). Anything else is dropped.
 */

/** Identifier, optionally dotted up to Salesforce's five-level limit. */
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,4}$/;

export function isSafeFieldPath(path: string): boolean {
  return FIELD_PATH.test(path);
}

export interface SelectListResult {
  fields: string[];
  /** Paths refused by the shape check, for reporting rather than silence. */
  rejected: string[];
}

/**
 * Build the SELECT list for an object.
 *
 * @param required Fields the sync needs regardless of what the user mapped —
 *   `Id` is the upsert key and `AccountId` is the contact association, and
 *   neither is optional just because nobody mapped it.
 */
export function buildSelectList(
  sourcePaths: readonly string[],
  required: readonly string[]
): SelectListResult {
  const fields: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  const add = (path: string): void => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fields.push(path);
  };

  for (const path of required) add(path);

  for (const path of sourcePaths) {
    const trimmed = path.trim();
    if (trimmed === "") continue;
    if (!isSafeFieldPath(trimmed)) {
      rejected.push(path);
      continue;
    }
    add(trimmed);
  }

  return { fields, rejected };
}

export function buildQuery(objectName: string, fields: readonly string[]): string {
  return `SELECT ${fields.join(", ")} FROM ${objectName}`;
}
