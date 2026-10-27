/**
 * Turning a proven credential into a connected integration.
 *
 * Both credential kinds converge here. OAuth arrives from `handleCallback` with
 * an exchanged token; an API key arrives from `connectWithApiKey` with a probed
 * key. What happens next — create the row if this was a first connect, store the
 * credential, mark it authorized, seed its mappings — is identical, and lives
 * here rather than in either flow so the two cannot drift apart.
 *
 * Nothing in this module is OAuth-specific, which is why it is not in
 * `oauth/`. `finalizeConnection` used to live in `oauth-service.ts` with a
 * comment explaining that the API-key flow reached across for it; moving it
 * removes the need for that explanation.
 */

import { unsupportedFunctionsFor } from "../capabilities";
import { recordSourceAccount } from "../identity/source-account";
import {
  createIntegration,
  deleteIntegration,
  markAuthorized,
  type IntegrationRecord,
} from "../repositories/integration-repository";
import { seedMappingsIfEmpty } from "../repositories/mapping-repository";
import { defaultMappingsFor } from "../providers/defaults-registry";
import { discardDraft, type IntegrationDraft } from "./draft-store";

/**
 * Everything a connection needs once a credential is proven and stored,
 * whatever kind it is.
 *
 * Seeding the mappings is the difference between "connected" and "connected and
 * able to sync".
 */
export async function finalizeConnection(
  integration: Pick<IntegrationRecord, "id" | "providerName" | "functionNames">,
  at: Date,
  sourceAccountId: string | null
): Promise<void> {
  const unsupported = unsupportedFunctionsFor(
    integration.functionNames,
    integration.providerName
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${integration.providerName} cannot sync ${unsupported.join(", ")}; no handler is available`
    );
  }

  // The credential is already stored by the caller. Recording the account here
  // means a reconnect to a different tenant retires the old keys before the
  // integration is usable again.
  await recordSourceAccount({
    integrationId: integration.id,
    sourceAccountId,
  });

  await markAuthorized(integration.id, at);

  // Only fills an empty rule set, so reconnecting never disturbs a user's edits.
  for (const functionName of integration.functionNames) {
    await seedMappingsIfEmpty(
      integration.id,
      functionName,
      defaultMappingsFor(functionName, integration.providerName)
    );
  }
}

/**
 * Create a connected integration from a draft.
 *
 * Call this only after the credential has been proven — a probe for an API key,
 * a completed code exchange for OAuth. That ordering is the whole point of the
 * draft: a rejected credential must leave nothing behind for the user to clean
 * up, so no row exists until there is something worth keeping.
 *
 * `storeCredential` receives the new integration's id because a token cannot be
 * written before the row it hangs off exists. It runs inside the rollback below,
 * so a credential that cannot be persisted does not leave a connected-looking
 * integration with no token.
 *
 * Rollback rather than a transaction: `saveToken` encrypts, and
 * `seedMappingsIfEmpty` reads the defaults registry, so both do work that does
 * not belong inside a database transaction. The window is small and the
 * compensating delete cascades, which for this failure mode — a create that got
 * part way — leaves exactly the same state as never having started.
 */
export async function createIntegrationFromDraft(args: {
  draft: IntegrationDraft;
  storeCredential: (integrationId: string) => Promise<void>;
  at: Date;
  /** Account the new credential names, or null when it does not say. */
  sourceAccountId: string | null;
}): Promise<IntegrationRecord> {
  const { draft } = args;

  // The API validates this before writing a draft, but a draft can outlive a
  // handler removal or arrive from a caller that skipped the route. Refuse
  // before the row exists rather than creating an integration whose first sync
  // is guaranteed to fail.
  const unsupported = unsupportedFunctionsFor(
    draft.functionNames,
    draft.providerName
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${draft.providerName} cannot sync ${unsupported.join(", ")}; no handler is available`
    );
  }

  const integration = await createIntegration({
    userId: draft.userId,
    providerName: draft.providerName,
    functionNames: draft.functionNames,
    instanceLabel: draft.instanceLabel,
  });

  try {
    await args.storeCredential(integration.id);
    await finalizeConnection(integration, args.at, args.sourceAccountId);
  } catch (error) {
    // Undo the row, so a half-created integration does not become exactly the
    // litter this whole mechanism exists to prevent.
    await deleteIntegration(integration.id, { audit: false }).catch(() => {
      // Report the original failure, not a cleanup failure — but say so, since
      // this is the one path that can still leave a stray row behind.
      console.error(
        `[connect] Could not roll back integration ${integration.id} after a failed connect`
      );
    });
    throw error;
  }

  // Only now: the draft has become a real integration, so replaying it would
  // create a duplicate.
  await discardDraft(draft.draftId);

  return integration;
}
