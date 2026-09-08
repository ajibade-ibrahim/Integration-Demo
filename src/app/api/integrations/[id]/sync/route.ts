/**
 * POST /api/integrations/[id]/sync — trigger a sync.
 *
 * Returns 202 immediately and runs in the background: a full sync can outlast a
 * request, and the caller polls the sync-run record for progress.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { executeSync } from "@/core/sync/sync-engine";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await findIntegrationForUser(id, await currentUserId());

  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }
  if (integration.status !== "active") {
    return NextResponse.json(
      { error: `Integration is ${integration.status}; connect it first` },
      { status: 409 }
    );
  }

  const wait = new URL(request.url).searchParams.get("wait") === "1";

  // `?wait=1` runs it inline, which is what scripts and tests want.
  if (wait) {
    return NextResponse.json(await executeSync(id, { trigger: "manual" }));
  }

  void executeSync(id, { trigger: "manual" }).catch((error: unknown) => {
    console.error(
      `[sync] Background sync for ${id} threw:`,
      error instanceof Error ? error.message : error
    );
  });

  return NextResponse.json({ status: "started" }, { status: 202 });
}
