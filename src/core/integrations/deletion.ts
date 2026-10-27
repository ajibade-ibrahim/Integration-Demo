/**
 * Deleting a connection, followed by the identity pass that makes the removal
 * visible in the accounts.
 *
 * The repository transaction removes the integration, its records and its keys.
 * That is not enough on its own: surviving accounts still carry field
 * provenance naming the deleted connection, and an account that held both this
 * source and another one still needs its fields chosen from the members that
 * remain. The whole-tenant pass is the one place that owns those rules, so this
 * service waits for any pass already in flight and then starts one that
 * observes the post-deletion data.
 *
 * Deletion must not be reported as failed because that follow-up failed. The
 * removal is durable, the audit records `reassessment_failed`, and the next
 * sync or manual resolution retries the derived-data cleanup.
 */

import { resolveAfterSync } from "../identity/resolve-after-sync";
import { finishIdentityWithdrawal } from "../repositories/identity-withdrawal-repository";
import {
  deleteIntegration,
  type IntegrationDeletionResult,
} from "../repositories/integration-repository";

export interface IntegrationDeletionOutcome extends IntegrationDeletionResult {
  /** The post-deletion resolution pass completed. */
  reassessed: boolean;
}

/**
 * @returns `undefined` when the integration was already gone.
 * @throws Only if the removal transaction itself fails. A follow-up resolution
 *   or audit update failure is logged and reflected in the audit status.
 */
export async function deleteIntegrationAndReassess(
  id: string
): Promise<IntegrationDeletionOutcome | undefined> {
  const deletion = await deleteIntegration(id);
  if (deletion === undefined) return undefined;

  const outcome = await resolveAfterSync(deletion.userId, "deletion", {
    waitForInFlight: true,
  });
  const reassessed = outcome !== undefined && outcome.status !== "discarded";

  if (deletion.auditId !== null) {
    try {
      await finishIdentityWithdrawal({
        userId: deletion.userId,
        auditId: deletion.auditId,
        reassessed,
      });
    } catch (error) {
      console.error(
        `[integrations] Could not finish deletion audit ${deletion.auditId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return { ...deletion, reassessed };
}
