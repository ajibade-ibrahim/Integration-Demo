/**
 * Sync run history.
 */

import { prisma } from "@/lib/prisma";
import { readJsonArray } from "./json-column";
import type { RecordIssue, SyncRunStatus } from "../types/common";

export interface SyncRunRecord {
  id: string;
  status: SyncRunStatus;
  trigger: string;
  startedAt: Date;
  completedAt: Date | null;
  customerCount: number;
  contactCount: number;
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
    customerCount: run.customerCount,
    contactCount: run.contactCount,
    attempt: run.attempt,
    issues: readJsonArray<RecordIssue>(run.errorsJson),
  }));
}
