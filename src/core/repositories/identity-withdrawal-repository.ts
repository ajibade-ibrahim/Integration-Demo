/**
 * Reading and completing the tombstone written when identity evidence is
 * explicitly removed.
 *
 * The write happens inside the same transaction as the removal itself, in
 * `integration-repository` / `identity-repository`, because an audit that can
 * fail independently is an audit that can lie by omission. This module owns the
 * second half: recording whether the follow-up resolution pass actually rebuilt
 * the surviving accounts, and reading the result for the UI.
 */

import { prisma } from "@/lib/prisma";
import {
  readJsonArray,
  readJsonCounts,
} from "./json-column";

export type IdentityWithdrawalKind =
  | "integration_deleted"
  | "crosswalk_withdrawn";

export type IdentityWithdrawalStatus =
  | "recorded"
  | "reassessed"
  | "reassessment_failed";

export interface IdentityWithdrawalRecord {
  id: string;
  kind: IdentityWithdrawalKind;
  integrationId: string | null;
  providerName: string;
  instanceLabel: string | null;
  sourceAccountId: string | null;
  foreignProvider: string | null;
  removed: Record<string, number>;
  removedRecords: number;
  retiredKeys: number;
  affectedAccountCount: number;
  accountsReassessed: number;
  accountsReaped: number;
  status: IdentityWithdrawalStatus;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Mark whether the pass after a withdrawal completed.
 *
 * `accountsReassessed` is derived from the affected ids that still exist, not
 * from the run's global counts. A whole-tenant pass may reap shells unrelated
 * to this deletion; attributing those to this audit would explain a change that
 * this withdrawal did not cause.
 *
 * A failed reassessment remains a complete audit of the removal. The status is
 * what tells the reader that derived data may still need another pass.
 */
export async function finishIdentityWithdrawal(args: {
  userId: string;
  auditId: string;
  reassessed: boolean;
}): Promise<void> {
  const withdrawal = await prisma.identityWithdrawal.findFirst({
    where: { id: args.auditId, userId: args.userId },
    select: { affectedAccountIdsJson: true },
  });
  if (withdrawal === null) return;

  const affected = readJsonArray<string>(
    withdrawal.affectedAccountIdsJson
  ).filter((id) => typeof id === "string");

  let accountsReassessed = 0;
  let accountsReaped = 0;
  if (args.reassessed) {
    const remaining =
      affected.length === 0
        ? 0
        : await prisma.customerAccount.count({
            where: { userId: args.userId, id: { in: affected } },
          });
    accountsReassessed = remaining;
    accountsReaped = affected.length - remaining;
  }

  await prisma.identityWithdrawal.updateMany({
    where: { id: args.auditId, userId: args.userId },
    data: {
      status: args.reassessed ? "reassessed" : "reassessment_failed",
      accountsReassessed,
      accountsReaped,
      completedAt: new Date(),
    },
  });
}

/** A deletion notice the signed-in owner is allowed to see. */
export async function findIdentityWithdrawalForUser(
  userId: string,
  id: string,
  kind?: IdentityWithdrawalKind
): Promise<IdentityWithdrawalRecord | undefined> {
  const row = await prisma.identityWithdrawal.findFirst({
    where: {
      id,
      userId,
      ...(kind === undefined ? {} : { kind }),
    },
  });
  if (row === null) return undefined;

  return {
    id: row.id,
    kind: row.kind as IdentityWithdrawalKind,
    integrationId: row.integrationId,
    providerName: row.providerName,
    instanceLabel: row.instanceLabel,
    sourceAccountId: row.sourceAccountId,
    foreignProvider: row.foreignProvider,
    removed: readJsonCounts(row.removedJson),
    removedRecords: row.removedRecords,
    retiredKeys: row.retiredKeys,
    affectedAccountCount: readJsonArray<string>(
      row.affectedAccountIdsJson
    ).length,
    accountsReassessed: row.accountsReassessed,
    accountsReaped: row.accountsReaped,
    status: row.status as IdentityWithdrawalStatus,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
