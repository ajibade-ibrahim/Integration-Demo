/**
 * POST /api/integrations/[id]/credentials — connect an API-key provider.
 *
 * POST-only and body-only: a key in a query string lands in access logs,
 * browser history, and the Referer header. Nothing here logs the body, and the
 * response carries only a verdict.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { connectWithApiKey } from "@/core/credentials/api-key-service";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";

interface CredentialsBody {
  apiKey?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await params;

  // Ownership is checked before the body is even read. `connectWithApiKey`
  // resolves the integration by id alone, so without this an authenticated
  // caller could write their own credential onto someone else's integration,
  // overwriting the one already there. 404 rather than 403, matching the other
  // id routes: a distinct status would confirm the id names a real record.
  if ((await findIntegrationForUser(id, await currentUserId())) === undefined) {
    return json({ error: "Integration not found" }, 404);
  }

  let body: CredentialsBody;
  try {
    body = (await request.json()) as CredentialsBody;
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  if (typeof body.apiKey !== "string") {
    return json({ error: "Expected an apiKey string" }, 400);
  }

  const result = await connectWithApiKey({
    integrationId: id,
    apiKey: body.apiKey,
  });

  if (!result.ok) {
    return json(
      {
        error: result.error ?? "Could not connect",
        ...(result.retryable === true ? { retryable: true } : {}),
      },
      // A rejected key is the caller's problem; an unreachable provider is not.
      result.retryable === true ? 502 : 400
    );
  }

  return json({ ok: true }, 200);
}

/** Every response is no-store: the request that produced it carried a secret. */
function json(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
