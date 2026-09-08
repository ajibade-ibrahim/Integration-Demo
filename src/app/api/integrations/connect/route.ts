/**
 * POST /api/integrations/connect — connect a draft with an API key.
 *
 * The first-time counterpart to `POST /api/integrations/[id]/credentials`,
 * which re-keys an integration that already exists. This one has no integration
 * id to be addressed by, because the whole point of the draft is that no row
 * exists until the key is accepted — so the draft id travels in the body
 * alongside the key.
 *
 * POST-only and body-only for the same reason as its sibling: a key in a query
 * string lands in access logs, browser history, and the Referer header. Nothing
 * here logs the body, and the response carries only a verdict plus the id of
 * whatever was created.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { connectDraftWithApiKey } from "@/core/credentials/api-key-service";

interface ConnectBody {
  draftId?: unknown;
  apiKey?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  bootstrap();

  let body: ConnectBody;
  try {
    body = (await request.json()) as ConnectBody;
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  if (typeof body.draftId !== "string" || body.draftId === "") {
    return json({ error: "Expected a draftId string" }, 400);
  }
  if (typeof body.apiKey !== "string") {
    return json({ error: "Expected an apiKey string" }, 400);
  }

  const result = await connectDraftWithApiKey({
    draftId: body.draftId,
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

  // The id the client needs in order to navigate to something that now exists.
  return json({ ok: true, integrationId: result.integrationId }, 200);
}

/** Every response is no-store: the request that produced it carried a secret. */
function json(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
