/**
 * GET /api/oauth/[provider]/callback
 *
 * Where every provider returns the user after consent. Validates state,
 * exchanges the code, stores the encrypted token, then sends the user to the
 * integration page with the outcome.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { handleCallback } from "@/core/oauth/oauth-service";

function appBase(): string {
  return (process.env["APP_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { provider } = await context.params;
  const params = new URL(request.url).searchParams;

  const result = await handleCallback({
    providerName: provider,
    code: params.get("code"),
    state: params.get("state"),
    providerError: params.get("error"),
  });

  if (!result.ok) {
    // No integration id means either state validation failed, or this was a
    // first-time connect that never got far enough to create one — which is the
    // intended outcome of a failed draft, not a missing piece of information.
    // Either way the list is the only place to return the user to, and it shows
    // the error there.
    const target =
      result.integrationId === undefined
        ? `${appBase()}/integrations`
        : `${appBase()}/integrations/${result.integrationId}`;

    const url = new URL(target);
    url.searchParams.set("error", result.error ?? "Authorization failed");
    return NextResponse.redirect(url.toString());
  }

  const url = new URL(`${appBase()}/integrations/${result.integrationId}`);
  url.searchParams.set("connected", "1");
  return NextResponse.redirect(url.toString());
}
