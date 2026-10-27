/**
 * Explicitly withdrawing imported crosswalk evidence, and making the accounts
 * observe the withdrawal.
 *
 * The repository removes the pairs and their keys atomically. The keys are the
 * part that matters immediately: a withdrawn reference that still holds its
 * place on an account is still matching new records. The resolution pass then
 * rebuilds what it can from the evidence that remains, and the audit records
 * whether that follow-up finished.
 *
 * Like deletion, this is a safe operation even if the pass fails: the evidence
 * is gone and cannot re-supply a merge, which is the durable part. The status
 * says the derived data still needs another pass.
 */

import { resolveAfterSync } from "./resolve-after-sync";
import {
  clearImportedCrossRefs,
  type ImportedCrosswalkWithdrawal,
} from "../repositories/identity-repository";
import { finishIdentityWithdrawal } from "../repositories/identity-withdrawal-repository";

export interface ImportedCrosswalkWithdrawalOutcome
  extends ImportedCrosswalkWithdrawal {
  reassessed: boolean;
}

export async function withdrawImportedCrosswalk(args: {
  userId: string;
  integrationId: string;
  foreignProvider: string;
}): Promise<ImportedCrosswalkWithdrawalOutcome> {
  const withdrawal = await clearImportedCrossRefs(args);
  if (withdrawal.auditId === null) {
    return { ...withdrawal, reassessed: false };
  }

  const outcome = await resolveAfterSync(args.userId, "deletion", {
    waitForInFlight: true,
  });
  const reassessed = outcome !== undefined && outcome.status !== "discarded";

  try {
    await finishIdentityWithdrawal({
      userId: args.userId,
      auditId: withdrawal.auditId,
      reassessed,
    });
  } catch (error) {
    console.error(
      `[identity] Could not finish withdrawal audit ${withdrawal.auditId}:`,
      error instanceof Error ? error.message : error
    );
  }

  return { ...withdrawal, reassessed };
}
