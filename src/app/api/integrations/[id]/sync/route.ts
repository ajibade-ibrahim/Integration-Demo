/**
 * POST /api/integrations/[id]/sync — trigger a sync.
 *
 * Returns 202 immediately and runs in the background: a full sync can outlast a
 * request, and the caller polls the sync-run record for progress.
 *
 * Identity resolution follows the sync, because new records are not grouped
 * until the pass runs and this is the moment there is something new to group.
 * It cannot fail the sync — see `resolveAfterSync`.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { unsupportedFunctionsFor } from "@/core/capabilities";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { executeSync } from "@/core/sync/sync-engine";
import { resolveAfterSync } from "@/core/identity/resolve-after-sync";

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

  const unsupported = unsupportedFunctionsFor(
    integration.functionNames,
    integration.providerName
  );
  if (unsupported.length > 0) {
    return NextResponse.json(
      {
        error: `This integration cannot sync ${unsupported.join(", ")}; no handler is available`,
      },
      { status: 409 }
    );
  }

  const wait = new URL(request.url).searchParams.get("wait") === "1";

  // `?wait=1` runs it inline, which is what scripts and tests want. Resolution
  // is inside the wait, so a caller that waited sees grouped accounts rather
  // than records that are about to be grouped.
  if (wait) {
    const result = await executeSync(id, { trigger: "manual" });
    // A discarded run means another worker owns the integration; that worker
    // resolves after its own run. Running a second whole-tenant pass here would
    // duplicate work against a sync that is still in flight.
    if (result.status !== "discarded") {
      await resolveAfterSync(integration.userId, "sync");
    }
    return NextResponse.json(result);
  }

  void executeSync(id, { trigger: "manual" })
    .catch((error: unknown) => {
      console.error(
        `[sync] Background sync for ${id} threw:`,
        error instanceof Error ? error.message : error
      );
    })
    // Resolve either way, and after the catch rather than in it: a sync that
    // threw may still have written records before it did, and the pass covers
    // the whole tenant rather than this one run. A discarded run is skipped
    // because the worker that owns the lease will resolve. `resolveAfterSync`
    // never rejects, so nothing escapes this chain unhandled.
    .then((result) => {
      if (result?.status === "discarded") return;
      return resolveAfterSync(integration.userId, "sync");
    });

  return NextResponse.json({ status: "started" }, { status: 202 });
}
