/**
 * Sync run history.
 */

import { prisma } from "@/lib/prisma";
import {
  readJsonArray,
  readJsonCounts,
  readJsonObject,
} from "./json-column";
import { parseRunCoverage } from "../sync/coverage";
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
  /**
   * Mapping content version per function, e.g. `{ identity: "v1-…" }`.
   *
   * Empty for runs recorded before mapping versions existed, and empty for a
   * run that failed before reading its rules. It is deliberately not
   * reconstructed from the current mapping: that would answer a different
   * question than "what produced this run".
   */
  mappingVersions: Record<string, string>;
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
    mappingVersions: readJsonObject(run.mappingVersionsJson),
    coverage: parseRunCoverage(run.coverageJson),
    attempt: run.attempt,
    issues: readJsonArray<RecordIssue>(run.errorsJson),
  }));
}
