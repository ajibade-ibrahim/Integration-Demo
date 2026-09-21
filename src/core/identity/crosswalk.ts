/**
 * Parsing a pasted or uploaded crosswalk into `<local id>, <foreign id>` pairs.
 *
 * Pure, and separate from the route, because the interesting behaviour is all
 * in what the text is allowed to look like — and a user pasting a column out of
 * a spreadsheet is not producing RFC 4180 CSV. This is deliberately lenient
 * about *shape* and strict about *content*: any of comma, tab or semicolon
 * separates, surrounding quotes and whitespace come off, blank and `#` lines
 * vanish — but a line that does not yield two non-empty values is refused
 * rather than half-read.
 *
 * ## No header detection
 *
 * There is none, on purpose. Every rule for guessing whether the first line is
 * a header (`metrifox_id,stripe_id`) or data is a rule that eventually eats a
 * real pair, and a silently dropped pair is a join that never happens with
 * nothing to show for it. A header instead lands in the import's `unmatched`
 * list, where the user reads "metrifox_id — no such record" and understands
 * immediately. Visible and harmless beats clever.
 */

/** One line: this system's id for a record, and another system's id for it. */
export interface CrosswalkPair {
  localExternalId: string;
  foreignId: string;
}

export interface CrosswalkParseResult {
  pairs: CrosswalkPair[];
  /** Lines that were not blank but did not yield a pair, with their numbers. */
  rejected: Array<{ line: number; text: string }>;
}

/**
 * A cap, so a mis-pasted file is refused rather than turned into a long
 * transaction. Well above any real `payments_stripe_customers` export for a
 * tenant of this size, and the error names the number.
 */
export const MAX_CROSSWALK_PAIRS = 5000;

/** Ids longer than this are not ids; every provider's are far shorter. */
const MAX_ID_LENGTH = 255;

const SEPARATORS = /[,;\t]/;

export function parseCrosswalk(text: string): CrosswalkParseResult {
  const pairs: CrosswalkPair[] = [];
  const rejected: Array<{ line: number; text: string }> = [];

  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    // A comment marker, because a user annotating which export a file came
    // from is likelier than a provider id that starts with `#`.
    if (line === "" || line.startsWith("#")) continue;

    const parts = line.split(SEPARATORS).map(unquote);
    const [localExternalId, foreignId] = parts;

    // Exactly the first two fields are read, and a third is not an error: a
    // column pulled from a wider export is the common case, and refusing it
    // would send the user back to a spreadsheet to delete columns.
    if (
      localExternalId === undefined ||
      foreignId === undefined ||
      localExternalId === "" ||
      foreignId === "" ||
      localExternalId.length > MAX_ID_LENGTH ||
      foreignId.length > MAX_ID_LENGTH
    ) {
      rejected.push({ line: index + 1, text: line.slice(0, 200) });
      continue;
    }

    pairs.push({ localExternalId, foreignId });
  }

  return { pairs, rejected };
}

/** Strip surrounding quotes and whitespace, in that order of appearance. */
function unquote(field: string): string {
  const trimmed = field.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}
