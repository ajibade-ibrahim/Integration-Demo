/**
 * Resolving identities after a sync, in the one way that is always safe.
 *
 * Both sync call sites — the scheduler tick and the manual sync route — need
 * exactly the same policy: run the pass, and **never let it fail the sync**. A
 * sync that fetched, mapped and wrote every record successfully has succeeded;
 * reporting it as failed because the pass that groups those records afterwards
 * hit a problem would tell the user to re-run a sync that has nothing wrong
 * with it, and would hide the real error behind a misleading one. Deletion uses
 * the same policy for the same reason, with `waitForInFlight` enabled.
 *
 * Written once here rather than as a try/catch at each call site, because "the
 * catch is not optional" is the kind of rule that survives review and then
 * quietly does not survive the third call site.
 *
 * The failure is swallowed, not lost: it is logged, and the run row is already
 * closed as `failed` by the resolver's own catch, so `listResolutionRuns` can
 * still show it. Resolution is also idempotent, so the next sync's pass simply
 * tries again — nothing has to be recovered by hand.
 */

import type { IdentityRunTrigger } from "../types/common";
import {
  resolveIdentities,
  type ResolveIdentitiesOptions,
  type ResolutionOutcome,
} from "./identity-resolver";

/**
 * @returns The outcome, or `undefined` if resolution threw. A `discarded`
 *   outcome is a normal return, not a failure — it means another pass for this
 *   user was already running and will cover the same rows.
 */
export async function resolveAfterSync(
  userId: string,
  trigger: IdentityRunTrigger,
  options: ResolveIdentitiesOptions = {}
): Promise<ResolutionOutcome | undefined> {
  try {
    return await resolveIdentities(userId, trigger, options);
  } catch (error) {
    console.error(
      `[identity] Resolution for user ${userId} threw:`,
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}
