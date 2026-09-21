/**
 * One integration: deleting it, and setting its survivorship rank.
 *
 * DELETE — revoke the grant, then remove everything.
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
  clampIdentityPriority,
  deleteIntegration,
  findIntegrationForUser,
  markPendingRevocation,
  updateIdentityPriority,
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
  await discardStateFor(id);

  await deleteIntegration(id);

  return NextResponse.json({ deleted: true, revoked });
}

/**
 * PATCH /api/integrations/[id] — change the survivorship rank.
 *
 * Only `identityPriority`, deliberately. The other editable properties of an
 * integration already have routes that do more than write a column — changing
 * the function set has to re-check scope coverage, and changing credentials has
 * to prove them — so a general-purpose patch endpoint would be a way to bypass
 * all of that.
 *
 * The rank is clamped rather than validated, because there is no wrong answer:
 * it names a position in a total order, so 5000 means what 1000 means. See
 * `clampIdentityPriority`.
 *
 * Resolution is not re-run here. This route can be called several times while a
 * user drags an ordering into shape, and a whole-tenant pass per keystroke
 * would be work the next one throws away — so the page asks for the pass once,
 * through `/api/identity/resolve`, when the user is done.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    identityPriority?: unknown;
  };

  if (typeof body.identityPriority !== "number") {
    return NextResponse.json(
      { error: "identityPriority must be a number" },
      { status: 400 }
    );
  }

  const updated = await updateIdentityPriority(
    id,
    await currentUserId(),
    body.identityPriority
  );
  if (!updated) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  // Echoing the stored value rather than the requested one, so a client that
  // sent 5000 sees the 1000 it actually became instead of showing a number the
  // database does not hold.
  return NextResponse.json({
    identityPriority: clampIdentityPriority(body.identityPriority),
  });
}
