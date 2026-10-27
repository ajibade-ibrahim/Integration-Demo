/**
 * Importing a crosswalk: `<local id>, <foreign id>` pairs, pasted or uploaded.
 *
 * This is the direct answer for Metrifox's `payments_stripe_customers`. The
 * spec calls that table "the join that makes one customer_account_id possible",
 * and no API exposes it — the connector cannot fetch it, and pretending
 * otherwise would leave the strongest key kind with no way to be supplied for
 * the case it was designed for. A file is the honest route.
 *
 * Two parameters beyond the text, and both are required rather than inferred:
 *
 *   `integrationId`   — which connection the *left* column's ids belong to.
 *   `foreignProvider` — which system the *right* column's ids belong to.
 *
 * Neither can be guessed from the file. A bare `cus_...` looks like Stripe, but
 * matching on id prefixes would mean a wrong guess silently joins two unrelated
 * companies with the strongest key kind there is — precisely the failure the
 * whole scope-segment design exists to prevent. Asking is cheap; the user knows
 * which export they are holding.
 *
 * DELETE withdraws a whole provider's imported pairs for one integration. Not
 * optional: a file pasted against the wrong connection would otherwise keep
 * making the same wrong join on every pass, and no inference will ever revise
 * it.
 *
 * Importing does not run resolution. `/api/identity/resolve` is the trigger,
 * so a user importing three files pays for one pass instead of three.
 *
 * Withdrawing **does** run it, after retiring the affected keys. The removal is
 * the change the user asked for; making them trigger a second pass would leave
 * a window in which the pairs are gone from the records but the derived keys
 * and account fields still describe them.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { MAX_CROSSWALK_PAIRS, parseCrosswalk } from "@/core/identity/crosswalk";
import { withdrawImportedCrosswalk } from "@/core/identity/withdrawal";
import { importCrosswalk } from "@/core/repositories/identity-repository";
import { providerRegistry } from "@/core/registries/provider-registry";
import { currentUserId } from "@/lib/current-user";

export async function POST(request: Request): Promise<NextResponse> {
  // The registry has to be populated before `foreignProvider` can be checked
  // against it, and before the pass that consumes these keys can scope them.
  bootstrap();

  const body = (await request.json().catch(() => ({}))) as {
    integrationId?: unknown;
    foreignProvider?: unknown;
    text?: unknown;
  };

  if (typeof body.integrationId !== "string" || body.integrationId === "") {
    return NextResponse.json(
      { error: "integrationId is required" },
      { status: 400 }
    );
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Validated against the registry for the same reason a `crossRef.<provider>`
  // mapping target is: a key naming a provider that does not exist can never be
  // scoped, so it would be written and then silently ignored by every pass.
  if (
    typeof body.foreignProvider !== "string" ||
    providerRegistry.get(body.foreignProvider) === undefined
  ) {
    return NextResponse.json(
      { error: "foreignProvider must name a registered provider" },
      { status: 400 }
    );
  }

  const parsed = parseCrosswalk(body.text);

  if (parsed.pairs.length > MAX_CROSSWALK_PAIRS) {
    return NextResponse.json(
      {
        error: `That file holds ${parsed.pairs.length} pairs; the limit is ${MAX_CROSSWALK_PAIRS}`,
      },
      { status: 400 }
    );
  }

  const result = await importCrosswalk({
    userId: await currentUserId(),
    integrationId: body.integrationId,
    foreignProvider: body.foreignProvider,
    pairs: parsed.pairs,
  });

  if (result === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  // Everything the import could not use comes back, rather than a bare success
  // count. A crosswalk that matched two of four hundred rows is the common
  // first attempt — wrong integration, or wrong column order — and a user who
  // is only told "2 applied" has nothing to correct from.
  return NextResponse.json({
    applied: result.applied,
    unmatched: result.unmatched,
    rejectedLines: parsed.rejected,
  });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  bootstrap();

  const params = new URL(request.url).searchParams;
  const integrationId = params.get("integrationId") ?? "";
  const foreignProvider = params.get("foreignProvider") ?? "";

  if (integrationId === "" || foreignProvider === "") {
    return NextResponse.json(
      { error: "integrationId and foreignProvider are required" },
      { status: 400 }
    );
  }

  const withdrawal = await withdrawImportedCrosswalk({
    userId: await currentUserId(),
    integrationId,
    foreignProvider,
  });

  return NextResponse.json({
    cleared: withdrawal.cleared,
    retiredKeys: withdrawal.retiredKeys,
    reassessed: withdrawal.reassessed,
  });
}
