/**
 * POST /api/oauth/mock/revoke — the mock provider's revocation endpoint.
 *
 * Accepts anything and reports success. Set `MOCK_REVOKE_FAILS=true` to make it
 * fail instead, which exercises the deletion path where revocation cannot be
 * confirmed and the integration is flagged for follow-up.
 */

import { NextResponse } from "next/server";
import { isMockEnabled } from "@/core/providers/mock/provider";

export async function POST(): Promise<NextResponse> {
  if (!isMockEnabled()) {
    return NextResponse.json({ error: "Mock provider is disabled" }, { status: 404 });
  }
  if (process.env["MOCK_REVOKE_FAILS"] === "true") {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
