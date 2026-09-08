/**
 * DELETE /api/integrations/[id] — revoke the grant, then remove everything.
 *
 * Order matters: revocation needs the token, so it has to happen before the
 * cascade deletes it. But a provider outage must not strand an integration the
 * user asked to remove, so an unconfirmed revocation is recorded and the
 * deletion proceeds. Leaving the row behind would mean the only way to retry is
 * to fix someone else's server.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import {
  deleteIntegration,
  findIntegrationForUser,
  markPendingRevocation,
} from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { revokeTokens } from "@/core/oauth/oauth-service";
import { discardStateFor } from "@/core/oauth/state-store";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await findIntegrationForUser(id, await currentUserId());

  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  const revoked = await revokeTokens(id);
  if (!revoked) {
    // Flagged before deletion so the failure is durable for at least as long as
    // the row is — and so the log line below has something to point at.
    await markPendingRevocation(id);
    console.warn(
      `[integrations] Deleting ${id} with an unconfirmed revocation at ${integration.providerName}`
    );
  }

  // An in-flight authorization for a deleted integration can never complete;
  // dropping its state stops a stale callback from resurrecting anything.
  discardStateFor(id);

  await deleteIntegration(id);

  return NextResponse.json({ deleted: true, revoked });
}
