/**
 * POST /api/identity/resolve — run identity resolution for the signed-in user.
 *
 * The on-demand trigger. Resolution normally rides along after a sync, but it
 * also has to be runnable on its own, because two of its three inputs change
 * without any sync happening: an integration's `identityPriority`, and the
 * `same` / `distinct` assertions a user makes in the Accounts view. Both need
 * to take effect while the user is looking at the page, not at the next
 * scheduled tick.
 *
 * Unlike the sync call sites this does **not** swallow a failure. There, a
 * failed pass must not be reported as a failed sync; here the pass is the whole
 * request, so its failure is the answer.
 *
 * No route parameter, and none possible: the user comes from the session, and
 * every query in `identity-repository` is scoped by it. A route that took a
 * userId would be a cross-tenant read waiting to be called.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { currentUserId } from "@/lib/current-user";

export async function POST(): Promise<NextResponse> {
  // The pass reads `externalIdScope` and the tenant-scope hook off the provider
  // definitions, so the registry has to be populated before it runs.
  bootstrap();

  const outcome = await resolveIdentities(await currentUserId(), "manual");

  // 200 with `status: "discarded"` rather than a 409, matching the sync route:
  // the request was handled, and what happened to it is in the body. A pass was
  // already running over the same rows, so the caller's intent is being served
  // either way.
  return NextResponse.json(outcome);
}
