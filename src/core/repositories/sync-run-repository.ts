/**
 * Sync run history.
 */

import { prisma } from "@/lib/prisma";
import { readJsonArray, readJsonCounts } from "./json-column";
import type {
  RecordIssue,
  SyncRunCoverage,
  SyncRunStatus,
} from "../types/common";

export interface SyncRunRecord {
  id: string;
  status: SyncRunStatus;
  trigger: string;
  startedAt: Date;
  completedAt: Date | null;
  /**
   * Rows written per target object, e.g. `{ product: 4, offering: 9 }`.
   *
   * A map rather than a column per object. An absent key means this run did
   * not write that object at all, which is what the report should say for a
   * catalog sync rather than "0 customers".
   */
  recordCounts: Record<string, number>;
  /** Pages, records, completeness and omissions per function/object. */
  coverage: SyncRunCoverage;
  attempt: number;
  issues: RecordIssue[];
}

export async function listRecentRuns(
  integrationId: string,
  take = 10
): Promise<SyncRunRecord[]> {
  const runs = await prisma.syncRun.findMany({
    where: { integrationId },
    orderBy: { startedAt: "desc" },
    take,
  });

  return runs.map((run) => ({
    id: run.id,
    status: run.status as SyncRunStatus,
    trigger: run.trigger,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    recordCounts: readJsonCounts(run.recordCountsJson),
    coverage: readCoverage(run.coverageJson),
    attempt: run.attempt,
    issues: readJsonArray<RecordIssue>(run.errorsJson),
  }));
}

/**
 * A malformed or pre-coverage row reads as "coverage not recorded". Treating
 * it as complete would be the one wrong default: absence of evidence is not
 * evidence that a run acquired everything.
 */
function readCoverage(raw: string): SyncRunCoverage {
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
  return { functions: [] };
}
