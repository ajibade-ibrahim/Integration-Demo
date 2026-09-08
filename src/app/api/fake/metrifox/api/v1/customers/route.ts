/**
 * A fake Metrifox, served over real HTTP.
 *
 * Mirrors the mock provider's approach: the fake lives behind a route in this
 * app, so the real client code runs unchanged — real headers, real pagination,
 * real status codes, and the real failure policy in `createProviderSession`.
 * An in-process stub would bypass all of that and prove much less.
 *
 * Point `METRIFOX_API_BASE` at `{APP_BASE_URL}/api/fake/metrifox` and set
 * `ENABLE_METRIFOX_FAKE=true`. The nested `api/v1` in this path is deliberate:
 * the client appends `/api/v1/customers` to whatever base it is given, and
 * keeping that identical for the fake is what makes the test meaningful.
 *
 * Tests do not use this route — they run msw against the real host. This is for
 * the credential-free demo.
 */

import { NextResponse } from "next/server";
import { isMetrifoxFakeEnabled } from "@/core/providers/metrifox/fake";
import {
  METRIFOX_CUSTOMERS,
  type MetrifoxCustomer,
} from "@/core/providers/metrifox/fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 25;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isMetrifoxFakeEnabled()) {
    return NextResponse.json(
      { statusCode: 404, message: "Not found" },
      { status: 404 }
    );
  }

  // Authenticate the way the real API does, so the rejected-key path is
  // demonstrable rather than theoretical. Any well-formed sk_ key works —
  // except one ending in `_denied`, which is how you show a 401 on demand.
  const key = request.headers.get("x-api-key") ?? "";
  if (!/^sk_(test|live)_[A-Za-z0-9_-]{8,}$/.test(key) || key.endsWith("_denied")) {
    return NextResponse.json(
      { statusCode: 401, message: "Invalid API key" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const page = positiveInt(url.searchParams.get("page")) ?? 1;
  const perPage = positiveInt(url.searchParams.get("per_page")) ?? DEFAULT_PER_PAGE;

  const total = METRIFOX_CUSTOMERS.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const data: MetrifoxCustomer[] = METRIFOX_CUSTOMERS.slice(start, start + perPage);

  return NextResponse.json({
    statusCode: 200,
    message: "Customers fetched",
    meta: {
      current_page: page,
      prev_page: page > 1 ? page - 1 : null,
      next_page: page < totalPages ? page + 1 : null,
      per_page: perPage,
      total_pages: totalPages,
      total_records: total,
    },
    data,
  });
}

function positiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? undefined : parsed;
}
