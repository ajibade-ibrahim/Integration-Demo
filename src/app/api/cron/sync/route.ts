/**
 * POST /api/cron/sync — the scheduler entry point.
 *
 * Next.js has no scheduler of its own, so something external drives this:
 * `npm run worker` locally, a platform cron in deployment. GET is accepted too
 * because most hosted cron services only issue GETs.
 *
 * Protected by a shared secret when `CRON_SECRET` is set. Unprotected it is an
 * unauthenticated endpoint that makes outbound API calls on every integration
 * in the database, which is not something to leave open by accident — so an
 * unset secret is allowed only outside production, and says so.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { runScheduledSyncs } from "@/core/sync/scheduler";
import { safeEqual } from "@/core/oauth/crypto";

/** One tick's budget, so a large backlog cannot hold the request open forever. */
const MAX_INTEGRATIONS_PER_TICK = 25;

function authorize(request: Request): NextResponse | undefined {
  const secret = process.env["CRON_SECRET"];

  if (secret === undefined || secret === "") {
    if (process.env["NODE_ENV"] === "production") {
      return NextResponse.json(
        { error: "CRON_SECRET must be set in production" },
        { status: 503 }
      );
    }
    return undefined;
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Constant-time: a naive comparison leaks the secret one character at a time
  // to anyone willing to measure.
  if (!safeEqual(offered, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return undefined;
}

async function handle(request: Request): Promise<NextResponse> {
  bootstrap();

  const rejection = authorize(request);
  if (rejection !== undefined) return rejection;

  const result = await runScheduledSyncs({
    maxIntegrations: MAX_INTEGRATIONS_PER_TICK,
  });

  return NextResponse.json(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}
