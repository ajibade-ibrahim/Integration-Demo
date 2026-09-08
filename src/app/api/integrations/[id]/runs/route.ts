/** GET /api/integrations/[id]/runs — recent sync runs, newest first. */

import { NextResponse } from "next/server";
import { listRecentRuns } from "@/core/repositories/sync-run-repository";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;

  // `listRecentRuns` filters by integration, not by user, so the ownership
  // check has to happen here. Without it this route answers with another
  // account's sync history — including the provider names and record counts
  // that history carries.
  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  return NextResponse.json({ runs: await listRecentRuns(id) });
}
