/**
 * The resolution pass: every `Customer` row in a tenant, onto one
 * `CustomerAccount` per real company.
 *
 * Framework-free. Every database call goes through `identity-repository`, which
 * is the only module that touches these tables and the only place the `userId`
 * filter has to be audited.
 *
 * ## Per user, not per integration
 *
 * `sync-engine` holds a per-integration lock and knows nothing about the other
 * connections. Resolution is cross-integration by definition, so it runs as its
 * own per-user pass afterwards. `sync-engine.ts` gains no import from here — a
 * sync that succeeded must not be reported as failed because resolution
 * hiccuped, so the callers wrap this in try/catch.
 *
 * ## Invariants
 *
 * Stated here, asserted in `tests/property/identity-resolution.property.test.ts`:
 *
 * 1. **Total.** Every customer ends with a non-null `customerAccountId`. A row
 *    with no usable key gets a singleton, rather than being left out.
 * 2. **Idempotent.** A second pass over unchanged data creates no account,
 *    moves no customer and writes no key.
 * 3. **Order-independent.** Shuffling the input rows yields the same partition.
 *    This is what the canonical ordering in `loadResolutionInput` buys, and why
 *    `same` groups are processed as a unit rather than member by member — if
 *    the first member to be handled chose the account, the group's home would
 *    depend on row order.
 * 4. **A `distinct` assertion is never overridden by an inferred key.**
 * 5. **The resolver never writes an assertion.** It only reads them, which is
 *    what makes a human verdict survive a pass that recomputes everything else.
 * 6. **A key never leaves an account that survives.** Keys move only when their
 *    account is absorbed and deleted.
 *
 * ## What it will not do
 *
 * Merge two accounts that both have members. When several accounts claim one
 * customer's keys the pass picks a home deterministically and reports the rest
 * as `key_claimed_elsewhere`; it does not re-parent anybody else. A false merge
 * has no undo, while an unmade merge is one `same` assertion away.
 */

import {
  absorbAccount,
  attachCustomerToAccount,
  createAccountForCustomer,
  finishResolutionRun,
  findAccountsForKeys,
  loadAccountSummaries,
  loadAssertions,
  loadResolutionInput,
  reapEmptyAccounts,
  startResolutionRun,
  updateAccountFields,
  type AccountSummary,
  type IdentityKeyRow,
  type NewIdentityKey,
  type ResolutionCustomer,
  type ResolutionRunCounts,
} from "../repositories/identity-repository";
import {
  identityKeyStrength,
  type IdentityIssue,
  type IdentityRunTrigger,
  type SyncRunStatus,
} from "../types/common";
import { buildSameGroups, DistinctPairs } from "./assertions";
import { buildEvidence, buildForeignScopes } from "./evidence";
import { resolveAccountFields } from "./survivorship";

export interface ResolutionOutcome {
  /**
   * The run row, or `null` when the pass was discarded for contention.
   *
   * Null rather than a row with `status: "discarded"`, matching `executeSync`:
   * a discard is not an execution, and writing one row per overlapping caller
   * would fill the user's history with records of nothing having happened.
   */
  runId: string | null;
  status: SyncRunStatus;
  counts: ResolutionRunCounts;
  issues: IdentityIssue[];
}

/** A set of customers that must share an account: one row, or a `same` group. */
interface Cluster {
  /** Members in the pass's canonical order. */
  members: ResolutionCustomer[];
  /** The union of the members' keys, deduplicated, strongest first. */
  keys: NewIdentityKey[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Users with a resolution pass in flight.
 *
 * On `globalThis` for the same reason as `syncInFlight` in `sync-engine.ts`:
 * route modules are compiled separately and reloaded in dev, so a per-module
 * Set would let two concurrent requests each believe they hold the lock. It
 * carries the same accepted limitation — one process only, so two deployed
 * instances can still overlap.
 *
 * Keyed by user, because that is the scope of the pass. Two of one user's
 * integrations finishing a sync at the same moment must produce one resolution,
 * not two racing ones, and the guard here is what makes the caller-side
 * "resolve after every sync" wiring cheap enough to be unconditional.
 *
 * An overlap that slips past this is degraded rather than corrupting: the
 * `(userId, kind, value)` unique is the real backstop, and `insertKeys` uses
 * `skipDuplicates`, so the loser of a race silently declines to re-claim a key
 * the winner already holds.
 */
const globalForIdentity = globalThis as unknown as {
  identityResolveInFlight: Set<string> | undefined;
};
const inFlight: Set<string> =
  globalForIdentity.identityResolveInFlight ?? new Set<string>();
globalForIdentity.identityResolveInFlight = inFlight;

function emptyCounts(): ResolutionRunCounts {
  return {
    accountsCreated: 0,
    accountsAbsorbed: 0,
    accountsReaped: 0,
    customersLinked: 0,
    keysIndexed: 0,
  };
}

/**
 * Resolve every customer in one tenant onto a canonical account.
 *
 * @returns A `discarded` outcome, having written nothing at all, when a pass
 *   for this user is already running. The second caller is told rather than
 *   left to believe it did the work — and rather than being queued, because the
 *   pass it is waiting on reads the same rows it would have read.
 */
export async function resolveIdentities(
  userId: string,
  trigger: IdentityRunTrigger = "sync"
): Promise<ResolutionOutcome> {
  if (inFlight.has(userId)) {
    return {
      runId: null,
      status: "discarded",
      counts: emptyCounts(),
      issues: [],
    };
  }
  inFlight.add(userId);

  try {
    return await runResolution(userId, trigger);
  } finally {
    // Must release even if something throws, or this user's resolution is
    // wedged until the process restarts.
    inFlight.delete(userId);
  }
}

async function runResolution(
  userId: string,
  trigger: IdentityRunTrigger
): Promise<ResolutionOutcome> {
  const runId = await startResolutionRun(userId, trigger);
  const counts = emptyCounts();
  const issues: IdentityIssue[] = [];

  try {
    // Step 0, and not housekeeping. An account whose members were deleted with
    // their integration still claims its keys, and the unique on
    // `(userId, kind, value)` cannot tell a live claim from an abandoned one —
    // so a stale shell would block the correct account from ever forming.
    counts.accountsReaped += (await reapEmptyAccounts(userId)).length;

    const customers = await loadResolutionInput(userId);
    const assertions = await loadAssertions(userId);
    const sameGroups = buildSameGroups(assertions);
    const distinctPairs = new DistinctPairs(assertions);
    const foreignScopes = buildForeignScopes(customers);

    const evidence = new Map<string, NewIdentityKey[]>();
    for (const customer of customers) {
      evidence.set(customer.id, buildEvidence(customer, foreignScopes));
    }

    for (const cluster of buildClusters(customers, sameGroups, evidence)) {
      await placeCluster({
        userId,
        cluster,
        distinctPairs,
        counts,
        issues,
      });
    }

    // Reap again. The first pass cleared shells left by a previous run; this
    // one clears shells *this* run emptied by moving their last member. Without
    // it those keys would stay claimed until the next pass, which is a real
    // delay rather than a theoretical one — the account they block is usually
    // the one the user is waiting to see.
    const reaped = await reapEmptyAccounts(userId);
    counts.accountsReaped += reaped.length;
    dropConflictsWithReapedAccounts(issues, reaped);

    issues.push(...(await recomputeAccountFields(userId)));

    // `partial` rather than `success` whenever anything went unresolved, in the
    // same spirit as a sync run: the pass finished, and it is also telling the
    // user there is something here only they can settle.
    const status: SyncRunStatus = issues.length === 0 ? "success" : "partial";
    await finishResolutionRun({ userId, runId, status, counts, issues });
    return { runId, status, counts, issues };
  } catch (error) {
    await finishResolutionRun({
      userId,
      runId,
      status: "failed",
      counts,
      issues,
    });
    throw error;
  }
}

/**
 * Forget conflicts whose rival account no longer exists.
 *
 * A cluster that moves every member off a multi-member account empties it — and
 * that happens *after* the keys that account held were reported as claimed
 * elsewhere. Left alone, the pass would finish by telling the user that two
 * accounts disagree over an address when one of the two was deleted moments
 * later: a conflict with nothing behind it, and no action available that could
 * clear it.
 *
 * Only the reap at the *end* of the pass can produce this. The one at the start
 * runs before any issue has been raised.
 */
function dropConflictsWithReapedAccounts(
  issues: IdentityIssue[],
  reaped: readonly string[]
): void {
  if (reaped.length === 0) return;
  const gone = new Set(reaped);

  // Backwards, so splicing does not skip the next element. In place, because
  // this array is the run's issue list and the counts were accumulated
  // alongside it — returning a new one would leave two lists to keep in step.
  for (let i = issues.length - 1; i >= 0; i -= 1) {
    const issue = issues[i];
    if (issue?.kind !== "key_claimed_elsewhere") continue;

    // The winner gained a member rather than losing one, so it cannot have been
    // reaped; only the losing claims need re-examining.
    const remaining = issue.losingAccountIds.filter((id) => !gone.has(id));
    if (remaining.length === 0) issues.splice(i, 1);
    else issue.losingAccountIds = remaining;
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Group the input into units that must be placed together.
 *
 * A `same` assertion is applied here, before any key is looked up, because a
 * human verdict outranks every inferred key. Grouping first — rather than
 * placing members individually and reconciling — is also what makes the pass
 * order-independent: the group pools its evidence and gets one home, instead of
 * whichever member happened to be handled first choosing for the others.
 *
 * Assertions naming a customer that no longer exists are ignored rather than
 * treated as an error. An integration can be deleted at any time, and a
 * dangling `same` should cost nothing.
 */
function buildClusters(
  customers: readonly ResolutionCustomer[],
  sameGroups: ReturnType<typeof buildSameGroups>,
  evidence: ReadonlyMap<string, NewIdentityKey[]>
): Cluster[] {
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const placed = new Set<string>();
  const clusters: Cluster[] = [];

  for (const customer of customers) {
    if (placed.has(customer.id)) continue;

    const peerIds = sameGroups.has(customer.id)
      ? sameGroups.membersOf(customer.id)
      : [customer.id];

    // Back to canonical order: `membersOf` sorts by id, but the pass's order is
    // by priority, and the first member is the one that creates the account.
    const members = customers.filter(
      (candidate) => peerIds.includes(candidate.id) && byId.has(candidate.id)
    );

    for (const member of members) placed.add(member.id);

    clusters.push({ members, keys: poolKeys(members, evidence) });
  }

  return clusters;
}

/** Union the members' keys, first occurrence winning, strongest kind first. */
function poolKeys(
  members: readonly ResolutionCustomer[],
  evidence: ReadonlyMap<string, NewIdentityKey[]>
): NewIdentityKey[] {
  const pooled = new Map<string, NewIdentityKey>();
  for (const member of members) {
    for (const key of evidence.get(member.id) ?? []) {
      const dedupe = `${key.kind} ${key.value}`;
      if (!pooled.has(dedupe)) pooled.set(dedupe, key);
    }
  }

  return [...pooled.values()].sort(
    (a, b) =>
      identityKeyStrength(a.kind) - identityKeyStrength(b.kind) ||
      a.value.localeCompare(b.value)
  );
}

// ---------------------------------------------------------------------------
// Placing one cluster
// ---------------------------------------------------------------------------

async function placeCluster(args: {
  userId: string;
  cluster: Cluster;
  distinctPairs: DistinctPairs;
  counts: ResolutionRunCounts;
  issues: IdentityIssue[];
}): Promise<void> {
  const { userId, cluster, distinctPairs, counts, issues } = args;
  const memberIds = cluster.members.map((member) => member.id);

  // Read fresh rather than tracking state in memory. Every write below lands
  // before the next cluster is considered, so the database is the accurate
  // picture of what this pass has done so far — and keeping one source of truth
  // is worth more than the queries it costs at this scale.
  const matches = await findAccountsForKeys(userId, cluster.keys);
  const currentAccountIds = unique(
    cluster.members.flatMap((member) =>
      member.customerAccountId === null ? [] : [member.customerAccountId]
    )
  );
  const summaries = await loadAccountSummaries(
    userId,
    unique([...matches.map((match) => match.customerAccountId), ...currentAccountIds])
  );

  const { candidates, vetoed } = applyDistinctVeto({
    matches,
    summaries,
    memberIds,
    distinctPairs,
  });
  issues.push(...vetoed);

  /**
   * Keys the user has already adjudicated, which are therefore not open
   * conflicts.
   *
   * A `distinct` assertion demotes the shared key to non-joining, so this
   * cluster cannot index it and it comes back contested by the account that
   * does hold it. Reporting *that* as `key_claimed_elsewhere` as well would
   * ask the user on every pass, forever, to settle a question they have
   * already settled — with the very answer that produced this state.
   */
  const adjudicated = new Set(
    vetoed.map((issue) => `${issue.keyKind} ${issue.keyValue}`)
  );

  // Drop accounts the cluster already has entirely to itself before ranking.
  //
  // Not an optimization — without it the pass cannot move a record it has
  // already placed. Every customer contributes a self-key, that key is an
  // `external_ref`, and `external_ref` is the strongest kind, so a customer's
  // own account would win every strength contest against the account its email
  // actually matches. The match would be reported as a key conflict and the two
  // records would sit apart forever, which is precisely the failure the whole
  // pass exists to prevent.
  //
  // The underlying point is that a self-key is a tautology: it says this record
  // is itself. It is evidence for *other* records naming that id, never for
  // where this one belongs.
  const foreign = candidates.filter((candidate) => {
    const summary = summaries.get(candidate.customerAccountId);
    return (
      summary !== undefined &&
      !summary.memberIds.every((id) => memberIds.includes(id))
    );
  });

  const target =
    chooseWinner(foreign, summaries) ??
    reusableAccount(currentAccountIds, summaries, memberIds);

  if (target === undefined) {
    await createCluster({
      userId,
      cluster,
      counts,
      issues,
      matches,
      adjudicated,
    });
    return;
  }

  // Absorbed accounts are gone by the time issues are written, so a key they
  // held must not be reported as claimed by them.
  const absorbed = new Set<string>();

  for (const member of cluster.members) {
    await placeMember({
      userId,
      member,
      target,
      cluster,
      summaries,
      counts,
      issues,
      matches,
      absorbed,
      adjudicated,
    });
  }
}

/**
 * Drop candidate accounts a `distinct` assertion forbids.
 *
 * The key that would have joined them is demoted to non-joining *for this
 * cluster* — a deliberate simplification over splitting the group precisely. It
 * errs toward not merging, which is the right direction: a `same` assertion can
 * always put two records back together, whereas an unwanted merge has no
 * user-facing undo.
 *
 * Note the asymmetry with `same`, which is applied unconditionally during
 * clustering. A user who asserts A=B, A=C and B≠C has contradicted themselves;
 * `same` wins that, because it is the assertion that names the pair the pass is
 * actually being asked to group. Only *inferred* groupings are vetoed.
 */
function applyDistinctVeto(args: {
  matches: readonly IdentityKeyRow[];
  summaries: ReadonlyMap<string, AccountSummary>;
  memberIds: readonly string[];
  distinctPairs: DistinctPairs;
}): {
  candidates: IdentityKeyRow[];
  /** Narrowed, so the caller can read `keyValue` off them without a check. */
  vetoed: Extract<IdentityIssue, { kind: "blocked_by_assertion" }>[];
} {
  const { matches, summaries, memberIds, distinctPairs } = args;
  if (distinctPairs.size === 0) return { candidates: [...matches], vetoed: [] };

  const candidates: IdentityKeyRow[] = [];
  const vetoed: Extract<IdentityIssue, { kind: "blocked_by_assertion" }>[] = [];
  const reported = new Set<string>();

  for (const match of matches) {
    const summary = summaries.get(match.customerAccountId);
    const outsiders = (summary?.memberIds ?? []).filter(
      (id) => !memberIds.includes(id)
    );

    let blocker: string | undefined;
    let blocked: string | undefined;
    for (const memberId of memberIds) {
      const found = distinctPairs.blockerAmong(memberId, outsiders);
      if (found !== undefined) {
        blocker = found;
        blocked = memberId;
        break;
      }
    }

    if (blocker === undefined || blocked === undefined) {
      candidates.push(match);
      continue;
    }

    // One issue per (customer, account) pair, not per key — three shared keys
    // between the same two records is one decision the user already made, not
    // three notifications.
    const once = `${blocked}|${blocker}|${match.customerAccountId}`;
    if (reported.has(once)) continue;
    reported.add(once);

    vetoed.push({
      kind: "blocked_by_assertion",
      reason: `Kept apart by your "not the same company" note, despite a shared ${match.kind === "domain" ? "domain" : match.kind === "email" ? "email address" : "cross-reference"}`,
      customerId: blocked,
      otherCustomerId: blocker,
      keyKind: match.kind,
      keyValue: match.value,
    });
  }

  return { candidates, vetoed };
}

/**
 * Pick one account from the candidates.
 *
 * Strongest matching key kind, then oldest account, then smallest id. The chain
 * ends in a unique column so there is never an unbroken tie, and the strength
 * step is the one that carries meaning: a hard foreign id beats an email beats
 * a shared domain, so a `crossRef` join is not outvoted by two companies that
 * happen to share a parent's web address.
 */
function chooseWinner(
  candidates: readonly IdentityKeyRow[],
  summaries: ReadonlyMap<string, AccountSummary>
): string | undefined {
  let winner: IdentityKeyRow | undefined;

  for (const candidate of candidates) {
    if (winner === undefined) {
      winner = candidate;
      continue;
    }

    const byStrength =
      identityKeyStrength(candidate.kind) - identityKeyStrength(winner.kind);
    if (byStrength !== 0) {
      if (byStrength < 0) winner = candidate;
      continue;
    }

    const candidateAge = summaries.get(candidate.customerAccountId)?.createdAt;
    const winnerAge = summaries.get(winner.customerAccountId)?.createdAt;
    if (
      candidateAge !== undefined &&
      winnerAge !== undefined &&
      candidateAge.getTime() !== winnerAge.getTime()
    ) {
      if (candidateAge < winnerAge) winner = candidate;
      continue;
    }

    if (candidate.customerAccountId < winner.customerAccountId) {
      winner = candidate;
    }
  }

  return winner?.customerAccountId;
}

/**
 * An account the cluster already has entirely to itself.
 *
 * The idempotence guard for a cluster with no keys at all. Such a cluster
 * matches nothing, so without this it would be handed a brand new singleton on
 * every single pass and the old one reaped behind it — churning ids that other
 * tables are about to reference.
 */
function reusableAccount(
  currentAccountIds: readonly string[],
  summaries: ReadonlyMap<string, AccountSummary>,
  memberIds: readonly string[]
): string | undefined {
  const owned = currentAccountIds
    .map((id) => summaries.get(id))
    .filter((summary): summary is AccountSummary => summary !== undefined)
    .filter((summary) => summary.memberIds.every((id) => memberIds.includes(id)))
    .sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );

  return owned[0]?.id;
}

/** The 0-candidate path: a new account for the cluster's first member. */
async function createCluster(args: {
  userId: string;
  cluster: Cluster;
  counts: ResolutionRunCounts;
  issues: IdentityIssue[];
  matches: readonly IdentityKeyRow[];
  adjudicated: ReadonlySet<string>;
}): Promise<void> {
  const { userId, cluster, counts, issues, matches, adjudicated } = args;
  const first = cluster.members[0];
  if (first === undefined) return;

  // Placeholder values. Survivorship recomputes every account's fields at the
  // end of the pass from its final membership, so writing anything considered
  // here would be a second, weaker answer to a question already owned by one
  // module.
  const { fields } = resolveAccountFields("pending", [first]);

  const { accountId, contested, keysIndexed } = await createAccountForCustomer({
    userId,
    customerId: first.id,
    fields,
    keys: cluster.keys,
  });

  counts.accountsCreated += 1;
  counts.customersLinked += 1;
  counts.keysIndexed += keysIndexed;
  issues.push(
    ...contestedIssues({
      customerId: first.id,
      winningAccountId: accountId,
      contested,
      matches,
      absorbed: new Set(),
      adjudicated,
    })
  );

  for (const member of cluster.members.slice(1)) {
    const result = await attachCustomerToAccount({
      userId,
      customerId: member.id,
      accountId,
      keys: [],
    });
    if (result.linked) counts.customersLinked += 1;
  }
}

/** Move one member onto the chosen account, absorbing its shell if it can. */
async function placeMember(args: {
  userId: string;
  member: ResolutionCustomer;
  target: string;
  cluster: Cluster;
  summaries: ReadonlyMap<string, AccountSummary>;
  counts: ResolutionRunCounts;
  issues: IdentityIssue[];
  matches: readonly IdentityKeyRow[];
  absorbed: Set<string>;
  adjudicated: ReadonlySet<string>;
}): Promise<void> {
  const {
    userId,
    member,
    target,
    cluster,
    summaries,
    counts,
    issues,
    matches,
    absorbed,
    adjudicated,
  } = args;

  const current = member.customerAccountId;
  let moved = false;

  // The absorb case, and it is the common path rather than an optimization.
  // Without it whichever integration synced first would permanently decide the
  // grouping: its customer already holds an account by the time the second one
  // arrives, and a plain attach would strand that account's keys to be reaped
  // rather than carrying them over.
  if (current !== null && current !== target) {
    const summary = summaries.get(current);
    const isSingleton =
      summary !== undefined &&
      summary.memberIds.length === 1 &&
      summary.memberIds[0] === member.id;

    if (isSingleton) {
      const result = await absorbAccount({
        userId,
        fromAccountId: current,
        intoAccountId: target,
      });
      if (result.absorbed) {
        counts.accountsAbsorbed += 1;
        counts.customersLinked += 1;
        absorbed.add(current);
        moved = true;
      }
    }
  }

  // Attach regardless, including right after an absorb. The absorb carried over
  // the keys the old account *held*; this indexes the keys the cluster supplies
  // *now*, which is a different set whenever a record has gained a field since
  // it was last resolved. Both are idempotent, so the overlap costs nothing.
  const { linked, contested, keysIndexed } = await attachCustomerToAccount({
    userId,
    customerId: member.id,
    accountId: target,
    keys: cluster.keys,
  });

  if (!linked) return;
  if (!moved && current !== target) counts.customersLinked += 1;
  counts.keysIndexed += keysIndexed;
  issues.push(
    ...contestedIssues({
      customerId: member.id,
      winningAccountId: target,
      contested,
      matches,
      absorbed,
      adjudicated,
    })
  );
}

/**
 * Explain the keys that could not be indexed.
 *
 * A key held by an account we can see is `key_claimed_elsewhere` — two accounts
 * claim one address and only a human can say whether they are one company. A
 * key held by nobody we saw is `key_race_lost`: a concurrent pass inserted it
 * between the lookup and the write. The distinction matters because only the
 * first is worth showing a user; the second resolves itself on the next pass.
 *
 * A key the user has already ruled on explains itself, and is reported by the
 * `blocked_by_assertion` issue instead of twice.
 */
function contestedIssues(args: {
  customerId: string;
  winningAccountId: string;
  contested: readonly NewIdentityKey[];
  matches: readonly IdentityKeyRow[];
  absorbed: ReadonlySet<string>;
  adjudicated: ReadonlySet<string>;
}): IdentityIssue[] {
  const {
    customerId,
    winningAccountId,
    contested,
    matches,
    absorbed,
    adjudicated,
  } = args;

  return contested.flatMap((key) => {
    if (adjudicated.has(`${key.kind} ${key.value}`)) return [];
    const holders = unique(
      matches
        .filter((match) => match.kind === key.kind && match.value === key.value)
        .map((match) => match.customerAccountId)
    ).filter((id) => id !== winningAccountId && !absorbed.has(id));

    if (holders.length === 0) {
      return {
        kind: "key_race_lost",
        reason: `Another resolution pass indexed ${key.rawValue} first; the next pass will pick it up`,
        customerId,
        keyKind: key.kind,
        keyValue: key.value,
      };
    }

    return {
      kind: "key_claimed_elsewhere",
      reason: `${holders.length + 1} accounts claim ${key.rawValue}; they were not merged`,
      customerId,
      keyKind: key.kind,
      keyValue: key.value,
      winningAccountId,
      losingAccountIds: holders,
    };
  });
}

// ---------------------------------------------------------------------------
// Survivorship
// ---------------------------------------------------------------------------

/**
 * Recompute every account's resolved fields from its final membership.
 *
 * A second full read, deliberately. Field values depend on who ended up in the
 * account, and that is not known until the last cluster is placed — resolving
 * as we went would leave the accounts written early holding values computed
 * from a membership that has since changed.
 */
async function recomputeAccountFields(userId: string): Promise<IdentityIssue[]> {
  const customers = await loadResolutionInput(userId);

  const byAccount = new Map<string, ResolutionCustomer[]>();
  for (const customer of customers) {
    if (customer.customerAccountId === null) continue;
    const members = byAccount.get(customer.customerAccountId) ?? [];
    members.push(customer);
    byAccount.set(customer.customerAccountId, members);
  }

  const issues: IdentityIssue[] = [];
  for (const [accountId, members] of [...byAccount.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const resolved = resolveAccountFields(accountId, members);
    await updateAccountFields({ userId, accountId, fields: resolved.fields });
    issues.push(...resolved.issues);
  }

  return issues;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
