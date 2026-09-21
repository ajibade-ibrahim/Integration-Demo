/**
 * Sync run history.
 */

import { prisma } from "@/lib/prisma";
import { readJsonArray, readJsonCounts } from "./json-column";
import type { RecordIssue, SyncRunStatus } from "../types/common";

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
    attempt: run.attempt,
    issues: readJsonArray<RecordIssue>(run.errorsJson),
  }));
}
