/**
 * Human verdicts, and the two structural facts that make them trustworthy.
 *
 * `same` is transitive — a user who says A is B and B is C believes A is C, and
 * reporting otherwise would put words in their mouth. `distinct` is *not* — "A
 * is not B" and "B is not C" says nothing at all about A and C, and inventing
 * that edge would block a correct merge on the strength of an assertion nobody
 * made. Getting either direction wrong is invisible until it silently changes
 * someone's customer list, so both are pinned here.
 */

import { describe, expect, it } from "vitest";

import {
  buildSameGroups,
  canonicalPair,
  DistinctPairs,
  pairKey,
  SameGroups,
} from "@/core/identity/assertions";
import type { AssertionRow } from "@/core/repositories/identity-repository";

function assertion(
  kind: "same" | "distinct",
  left: string,
  right: string
): AssertionRow {
  // Stored rows are canonically ordered by the repository; these mirror that.
  const [leftCustomerId, rightCustomerId] = canonicalPair(left, right);
  return {
    id: `${kind}-${leftCustomerId}-${rightCustomerId}`,
    kind,
    leftCustomerId,
    rightCustomerId,
    note: null,
  };
}

describe("canonicalPair", () => {
  it("sorts a pair regardless of the order it is given in", () => {
    expect(canonicalPair("b", "a")).toEqual(["a", "b"]);
    expect(canonicalPair("a", "b")).toEqual(["a", "b"]);
  });

  it("leaves an identical pair alone", () => {
    expect(canonicalPair("a", "a")).toEqual(["a", "a"]);
  });

  it("gives (A,B) and (B,A) the same key, which is what the unique relies on", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });
});

describe("SameGroups", () => {
  it("treats an unnamed customer as its own group", () => {
    const groups = new SameGroups();
    expect(groups.has("a")).toBe(false);
    expect(groups.representative("a")).toBe("a");
  });

  it("is transitive: A=B and B=C puts A with C", () => {
    const groups = buildSameGroups([
      assertion("same", "a", "b"),
      assertion("same", "b", "c"),
    ]);

    expect(groups.membersOf("a")).toEqual(["a", "b", "c"]);
    expect(groups.membersOf("c")).toEqual(["a", "b", "c"]);
    expect(groups.representative("a")).toBe(groups.representative("c"));
  });

  it("picks the smallest id as representative, whatever the assertion order", () => {
    const forward = buildSameGroups([
      assertion("same", "m", "z"),
      assertion("same", "z", "a"),
    ]);
    const backward = buildSameGroups([
      assertion("same", "z", "a"),
      assertion("same", "m", "z"),
    ]);

    expect(forward.representative("z")).toBe("a");
    expect(backward.representative("z")).toBe("a");
  });

  it("merges two chains built from opposite ends into one group", () => {
    const groups = buildSameGroups([
      assertion("same", "a", "b"),
      assertion("same", "c", "d"),
      assertion("same", "b", "c"),
    ]);

    expect(groups.membersOf("d")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps unrelated groups apart", () => {
    const groups = buildSameGroups([
      assertion("same", "a", "b"),
      assertion("same", "y", "z"),
    ]);

    expect(groups.membersOf("a")).toEqual(["a", "b"]);
    expect(groups.membersOf("z")).toEqual(["y", "z"]);
  });

  it("ignores distinct assertions entirely", () => {
    const groups = buildSameGroups([assertion("distinct", "a", "b")]);
    expect(groups.has("a")).toBe(false);
  });

  it("survives a long chain without stack trouble", () => {
    // Path compression is the reason this is not a linked-list walk. An
    // imported crosswalk can produce chains far longer than a user would type.
    const ids = Array.from({ length: 500 }, (_, i) => `c-${String(i).padStart(4, "0")}`);
    const rows = ids.slice(1).map((id, i) => assertion("same", ids[i]!, id));

    const groups = buildSameGroups(rows);
    expect(groups.membersOf(ids[499]!)).toHaveLength(500);
    expect(groups.representative(ids[499]!)).toBe(ids[0]);
  });
});

describe("DistinctPairs", () => {
  it("forbids the asserted pair in both directions", () => {
    const pairs = new DistinctPairs([assertion("distinct", "a", "b")]);

    expect(pairs.forbids("a", "b")).toBe(true);
    expect(pairs.forbids("b", "a")).toBe(true);
  });

  it("is NOT transitive", () => {
    const pairs = new DistinctPairs([
      assertion("distinct", "a", "b"),
      assertion("distinct", "b", "c"),
    ]);

    // Nobody said anything about A and C. Blocking them here would be the
    // resolver refusing a merge on an assertion the user never made.
    expect(pairs.forbids("a", "c")).toBe(false);
  });

  it("ignores same assertions", () => {
    const pairs = new DistinctPairs([assertion("same", "a", "b")]);
    expect(pairs.size).toBe(0);
    expect(pairs.forbids("a", "b")).toBe(false);
  });

  it("counts (A,B) and (B,A) once", () => {
    const pairs = new DistinctPairs([
      assertion("distinct", "a", "b"),
      assertion("distinct", "b", "a"),
    ]);
    expect(pairs.size).toBe(1);
  });

  describe("blockerAmong", () => {
    const pairs = new DistinctPairs([
      assertion("distinct", "a", "y"),
      assertion("distinct", "a", "z"),
    ]);

    it("finds the first forbidden counterpart in the order given", () => {
      // Stable ordering matters: the issue text names a counterpart, and a
      // reason that rotated between passes would look like a new problem each
      // time.
      expect(pairs.blockerAmong("a", ["x", "y", "z"])).toBe("y");
      expect(pairs.blockerAmong("a", ["x", "z", "y"])).toBe("z");
    });

    it("returns undefined when nothing in the group is forbidden", () => {
      expect(pairs.blockerAmong("a", ["x", "w"])).toBeUndefined();
      expect(pairs.blockerAmong("a", [])).toBeUndefined();
    });

    it("never blocks a customer against itself", () => {
      const selfPair = new DistinctPairs([assertion("distinct", "a", "a")]);
      expect(selfPair.blockerAmong("a", ["a"])).toBeUndefined();
    });
  });
});
