/**
 * POST /api/oauth/mock/token
 *
 * The mock provider's token endpoint. Handles both the authorization_code and
 * refresh_token grants so the full token lifecycle — including proactive
 * refresh — is exercisable without a real provider.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { isMockEnabled } from "@/core/providers/mock/provider";

/** Short, so the 5-minute refresh leeway is reachable in a demo. */
const ACCESS_TOKEN_TTL_SECONDS = 900;

function token(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isMockEnabled()) {
    return NextResponse.json({ error: "Mock provider is disabled" }, { status: 404 });
  }

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    if (form.get("code") === null) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    return NextResponse.json({
      access_token: token("mock-at"),
      refresh_token: token("mock-rt"),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      token_type: "bearer",
      // Echoed back the way Salesforce does, so the granted-scope path is
      // exercised rather than only the HubSpot-style fallback.
      scope: form.get("scope") ?? "",
    });
  }

  if (grantType === "refresh_token") {
    if (form.get("refresh_token") === null) {
      return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    return NextResponse.json({
      access_token: token("mock-at"),
      // Deliberately omits refresh_token, as most providers do on refresh —
      // this is what proves the stored one is preserved rather than wiped.
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      token_type: "bearer",
    });
  }

  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
}
