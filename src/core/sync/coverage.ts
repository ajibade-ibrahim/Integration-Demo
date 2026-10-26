/**
 * Build the coverage report for a run.
 *
 * The sync engine knows three facts the run history did not previously keep:
 * which pages it saw, which records those pages carried, and what the writer
 * persisted. This module turns those facts into a report that keeps "the write
 * succeeded" separate from "the acquisition was whole".
 *
 * `complete` is inherited from `SourcePage.complete`, not invented here. Most
 * handlers do not claim completeness on the root object — they upsert and leave
 * reconciliation alone — so `null` is a normal, honest answer. A handler that
 * stops at the shared 1000-page guard is marked `atPageLimit`, because returning
 * from the iterator is not proof that the provider had no more records.
 */

import type {
  RecordIssue,
  SyncFunctionCoverage,
  SyncObjectCoverage,
  SyncRunCoverage,
  TargetObject,
} from "../types/common";

/** Every provider handler uses the same safety guard for a page loop. */
const PAGE_GUARD = 1000;

export function emptyRunCoverage(): SyncRunCoverage {
  return { functions: [] };
}

/**
 * Parse a persisted coverage report.
 *
 * A malformed or pre-coverage row reads as "coverage not recorded". Treating it
 * as complete would be the one wrong default: absence of evidence is not
 * evidence that a run acquired everything.
 */
export function parseRunCoverage(raw: string): SyncRunCoverage {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { functions?: unknown }).functions)
    ) {
      return parsed as SyncRunCoverage;
    }
  } catch {
    // Fall through to the empty report.
  }
  return emptyRunCoverage();
}

/** Add a run-level reason without discarding coverage already recorded. */
export function coverageWithError(raw: string, error: string): string {
  const coverage = parseRunCoverage(raw);
  coverage.error = error;
  return JSON.stringify(coverage);
}

interface CreateFunctionCoverageArgs {
  functionName: string;
  supportedObjects: readonly TargetObject[];
  mappedObjects: ReadonlySet<TargetObject>;
}

export function createFunctionCoverage({
  functionName,
  supportedObjects,
  mappedObjects,
}: CreateFunctionCoverageArgs): SyncFunctionCoverage {
  const objects = [...new Set(supportedObjects)].map<SyncObjectCoverage>(
    (object) => ({
      object,
      mapped: mappedObjects.has(object),
      yielded: false,
      pages: 0,
      recordsRead: 0,
      recordsWritten: 0,
      complete: null,
      warnings: 0,
      rejected: 0,
      atPageLimit: false,
    })
  );

  return {
    functionName,
    objects,
    omittedObjects: [],
    unmappedObjects: [],
    pages: 0,
    recordsRead: 0,
    recordsWritten: 0,
    warnings: 0,
    rejected: 0,
  };
}

/**
 * Record one page.
 *
 * `complete` is ANDed only when a page actually declares it. An undeclared page
 * must not turn a previous `true` into `false`, and a declaration must not be
 * lost just because a later page omitted the field.
 */
export function recordCoveragePage(
  coverage: SyncFunctionCoverage,
  object: TargetObject,
  recordCount: number,
  complete: boolean | undefined
): void {
  const entry = ensureEntry(coverage, object);
  entry.yielded = true;
  entry.pages += 1;
  entry.recordsRead += recordCount;

  if (complete !== undefined) {
    entry.complete =
      entry.complete === null ? complete : entry.complete && complete;
  }
}

/** Record the writer's per-object counts, including legitimate zeroes. */
export function recordCoverageWrites(
  coverage: SyncFunctionCoverage,
  counts: Readonly<Partial<Record<TargetObject, number>>>
): void {
  for (const entry of coverage.objects) entry.recordsWritten = 0;
  for (const [object, count] of Object.entries(counts)) {
    const entry = ensureEntry(coverage, object as TargetObject);
    entry.recordsWritten = count ?? 0;
  }
}

/** Attribute per-record issues to their object. */
export function recordCoverageIssues(
  coverage: SyncFunctionCoverage,
  issues: readonly RecordIssue[]
): void {
  for (const issue of issues) {
    const entry = ensureEntry(coverage, issue.targetObject);
    if (issue.severity === "rejected") entry.rejected += 1;
    else entry.warnings += 1;
  }
}

export function recordFunctionError(
  coverage: SyncFunctionCoverage,
  error: string
): void {
  coverage.error = error;
}

/**
 * Finalise the derived fields.
 *
 * Called on both success and failure: a failed run still has the pages and
 * writes that happened before the throw, and that partial evidence is the point.
 */
export function finishFunctionCoverage(coverage: SyncFunctionCoverage): void {
  for (const entry of coverage.objects) {
    entry.atPageLimit =
      entry.pages >= PAGE_GUARD && entry.complete !== true;
  }

  coverage.omittedObjects = coverage.objects
    .filter((entry) => entry.mapped && !entry.yielded)
    .map((entry) => entry.object);
  coverage.unmappedObjects = coverage.objects
    .filter((entry) => !entry.mapped)
    .map((entry) => entry.object);

  coverage.pages = sum(coverage.objects, "pages");
  coverage.recordsRead = sum(coverage.objects, "recordsRead");
  coverage.recordsWritten = sum(coverage.objects, "recordsWritten");
  coverage.warnings = sum(coverage.objects, "warnings");
  coverage.rejected = sum(coverage.objects, "rejected");
}

function ensureEntry(
  coverage: SyncFunctionCoverage,
  object: TargetObject
): SyncObjectCoverage {
  const existing = coverage.objects.find((entry) => entry.object === object);
  if (existing !== undefined) return existing;

  // A handler that yields an object outside its declared capability is a bug,
  // but dropping the observation would hide it and losing the run would hide
  // the data it did write. Keep the entry and let the count speak.
  const entry: SyncObjectCoverage = {
    object,
    mapped: true,
    yielded: false,
    pages: 0,
    recordsRead: 0,
    recordsWritten: 0,
    complete: null,
    warnings: 0,
    rejected: 0,
    atPageLimit: false,
  };
  coverage.objects.push(entry);
  return entry;
}

function sum(
  objects: readonly SyncObjectCoverage[],
  key: "pages" | "recordsRead" | "recordsWritten" | "warnings" | "rejected"
): number {
  return objects.reduce((total, entry) => total + entry[key], 0);
}
