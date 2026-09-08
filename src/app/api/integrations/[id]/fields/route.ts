/**
 * GET /api/integrations/[id]/fields — source fields the mapping editor offers.
 *
 * `?function=identity` selects the function; `?refresh=1` bypasses the cache
 * and re-reads the provider's schema.
 */

import { NextResponse } from "next/server";
import { bootstrap, IDENTITY_FUNCTION } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { discoverFields } from "@/core/sync/discovery-service";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const functionName = params.get("function") ?? IDENTITY_FUNCTION;

  if (!integration.functionNames.includes(functionName)) {
    return NextResponse.json(
      {
        error: `This integration does not serve '${functionName}'`,
        serves: integration.functionNames,
      },
      { status: 400 }
    );
  }

  // Discovery calls the provider's API, which needs a live grant.
  if (integration.status !== "active") {
    return NextResponse.json(
      { error: `Integration is ${integration.status}; connect it first` },
      { status: 409 }
    );
  }

  try {
    const results = await discoverFields(id, functionName, {
      refresh: params.get("refresh") === "1",
    });
    return NextResponse.json({ functionName, objects: results });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Field discovery failed";
    console.error(`[fields] Discovery failed for ${id}:`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
