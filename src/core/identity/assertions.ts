/**
 * Human verdicts about identity, and how they constrain the pass.
 *
 * Pure. An assertion outranks every inferred key in both directions: `same`
 * forces customers together before any matching happens, and `distinct` refuses
 * a grouping that the keys would otherwise have made.
 *
 * ## Why `distinct` carries as much weight as `same`
 *
 * The worst failure of any matcher is a false merge, and it is the one failure
 * the user cannot undo on their own. Two companies that share a role address on
 * a shared agency domain would re-merge on every single pass, forever, with
 * nothing to do about it. `distinct` is the veto that makes the pass
 * correctable.
 *
 * ## The pair is canonically ordered
 *
 * Every function here sorts a pair by id before doing anything with it, and the
 * stored row does the same. Without that, (A,B) and (B,A) are two rows, the
 * unique constraint means nothing, and a user could hold both "same" and
 * "distinct" for one pair with the outcome decided by insertion order.
 */

import type { AssertionRow } from "../repositories/identity-repository";

/** A pair of customer ids, smaller first. Lexicographic on uuid strings. */
export function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** The map key for a canonically ordered pair. */
export function pairKey(a: string, b: string): string {
  const [left, right] = canonicalPair(a, b);
  return `${left}|${right}`;
}

// ---------------------------------------------------------------------------
// `same` — union-find over customers
// ---------------------------------------------------------------------------

/**
 * Groups of customers a human has declared identical.
 *
 * Union-find rather than a pairwise scan because `same` is transitive by
 * meaning: if a user says A is B and B is C, refusing to conclude A is C would
 * be reporting back something they did not say and do not believe. The
 * representative of each group is its smallest id, so the grouping is a
 * function of the set alone — not of the order the assertions were made in, and
 * not of the order they came back from the database.
 */
export class SameGroups {
  private readonly parent = new Map<string, string>();

  private find(id: string): string {
    const seen = this.parent.get(id);
    if (seen === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (seen === id) return id;
    const root = this.find(seen);
    // Path compression: assertion chains are short, but this keeps a
    // pathological import from degrading into a linked list.
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Smaller id wins, so the representative is deterministic rather than
    // whichever side happened to be asserted first.
    const [keep, absorb] = canonicalPair(rootA, rootB);
    this.parent.set(absorb, keep);
  }

  /** The representative of `id`'s group — `id` itself when it has no group. */
  representative(id: string): string {
    return this.find(id);
  }

  /** Every member of `id`'s group, including `id`, sorted. */
  membersOf(id: string): string[] {
    const root = this.find(id);
    return [...this.parent.keys()].filter((k) => this.find(k) === root).sort();
  }

  /** Whether `id` was named by any `same` assertion. */
  has(id: string): boolean {
    return this.parent.has(id);
  }
}

/** Build the `same` groups from every assertion for a user. */
export function buildSameGroups(assertions: readonly AssertionRow[]): SameGroups {
  const groups = new SameGroups();
  for (const assertion of assertions) {
    if (assertion.kind !== "same") continue;
    groups.union(assertion.leftCustomerId, assertion.rightCustomerId);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// `distinct` — the veto
// ---------------------------------------------------------------------------

/**
 * The pairs a human has declared *not* the same company.
 *
 * A set of canonical pair keys rather than a graph: unlike `same`, this relation
 * is not transitive. "A is not B" and "B is not C" says nothing whatsoever about
 * A and C, and inventing that edge would block a correct merge on the strength
 * of an assertion nobody made.
 */
export class DistinctPairs {
  private readonly pairs = new Set<string>();

  constructor(assertions: readonly AssertionRow[]) {
    for (const assertion of assertions) {
      if (assertion.kind !== "distinct") continue;
      this.pairs.add(pairKey(assertion.leftCustomerId, assertion.rightCustomerId));
    }
  }

  get size(): number {
    return this.pairs.size;
  }

  /** Whether these two customers are forbidden from sharing an account. */
  forbids(a: string, b: string): boolean {
    return this.pairs.has(pairKey(a, b));
  }

  /**
   * The first member of `others` this customer may not join, or `undefined`.
   *
   * `others` is expected in the pass's canonical order, so the reported blocker
   * is stable across runs — the issue text names the same counterpart every
   * time rather than rotating through the group.
   */
  blockerAmong(
    customerId: string,
    others: readonly string[]
  ): string | undefined {
    return others.find(
      (other) => other !== customerId && this.forbids(customerId, other)
    );
  }
}
