/**
 * Parsing a crosswalk someone actually pasted.
 *
 * The risk here is not malformed input — that is refused and reported. It is
 * the opposite: a line quietly dropped or half-read becomes a join that never
 * happens, with nothing on screen to say why. So every test below is about a
 * line either yielding the pair it obviously means, or being *named* as
 * rejected. There is no third outcome.
 */

import { describe, expect, it } from "vitest";
import { parseCrosswalk } from "@/core/identity/crosswalk";

describe("what counts as a pair", () => {
  it("reads the plain case", () => {
    expect(parseCrosswalk("ACME-001,cus_123\nNORTH-002,cus_456").pairs).toEqual([
      { localExternalId: "ACME-001", foreignId: "cus_123" },
      { localExternalId: "NORTH-002", foreignId: "cus_456" },
    ]);
  });

  it.each([
    ["comma", "A,1"],
    ["tab", "A\t1"],
    ["semicolon", "A;1"],
    ["padding", "  A  ,  1  "],
    ["quotes", '"A","1"'],
    ["single quotes", "'A','1'"],
  ])("accepts %s", (_label, line) => {
    // A spreadsheet column, a psv export and a hand-typed line all mean the
    // same thing. Being strict about the separator would send the user back to
    // reformat a file whose content was never in doubt.
    expect(parseCrosswalk(line).pairs).toEqual([
      { localExternalId: "A", foreignId: "1" },
    ]);
  });

  it("reads the first two fields of a wider row", () => {
    // A column pair pulled out of a full export is the common case; demanding
    // exactly two fields would mean deleting columns before we will look.
    expect(parseCrosswalk("A,1,ignored,also ignored").pairs).toEqual([
      { localExternalId: "A", foreignId: "1" },
    ]);
  });

  it("skips blank lines and comments without calling them rejects", () => {
    const result = parseCrosswalk("\n# from the 2026-02 export\nA,1\n\n");

    expect(result.pairs).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it("handles CRLF, because the file came off a spreadsheet", () => {
    expect(parseCrosswalk("A,1\r\nB,2\r\n").pairs).toHaveLength(2);
  });
});

describe("what is refused, and named", () => {
  it("reports a line with only one field, with its number", () => {
    const result = parseCrosswalk("A,1\njust-one-id\nB,2");

    expect(result.pairs).toHaveLength(2);
    expect(result.rejected).toEqual([{ line: 2, text: "just-one-id" }]);
  });

  it("refuses a half-empty pair rather than storing an empty id", () => {
    // An empty foreign id would be written as a key nothing can ever match,
    // and the user would be told the pair applied.
    const result = parseCrosswalk("A,\n,1");

    expect(result.pairs).toEqual([]);
    expect(result.rejected.map((entry) => entry.line)).toEqual([1, 2]);
  });

  it("refuses an id longer than any provider issues", () => {
    const result = parseCrosswalk(`A,${"x".repeat(256)}`);
    expect(result.pairs).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("truncates the echoed text of a very long junk line", () => {
    // The rejection is shown back to the user; a pasted binary file should not
    // become a wall of it.
    const result = parseCrosswalk("z".repeat(5000));
    expect(result.rejected[0]?.text.length).toBe(200);
  });
});

describe("a header row", () => {
  it("is parsed as a pair, not silently dropped", () => {
    // The deliberate non-feature. Every rule for guessing that a first line is
    // a header eventually eats a real pair, and a dropped pair is a join that
    // never happens with nothing to show for it. This one lands in `unmatched`
    // at import time instead, where the user reads "metrifox_id — no such
    // record" and understands at once.
    expect(parseCrosswalk("metrifox_id,stripe_id\nA,1").pairs).toEqual([
      { localExternalId: "metrifox_id", foreignId: "stripe_id" },
      { localExternalId: "A", foreignId: "1" },
    ]);
  });
});
