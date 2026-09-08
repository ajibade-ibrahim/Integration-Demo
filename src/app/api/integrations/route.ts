/**
 * POST /api/integrations — draft an integration and hand back its connect URL.
 * GET  /api/integrations — list the demo user's integrations.
 *
 * POST deliberately writes nothing to the database. The configuration is held
 * as a draft until a credential is proven, so an abandoned or rejected connect
 * leaves no row for the user to delete by hand. The `Integration` row is created
 * by the connect flow — see `integrations/connection.ts`.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { listIntegrations } from "@/core/repositories/integration-repository";
import { createDraft } from "@/core/integrations/draft-store";
import { currentUserId } from "@/lib/current-user";
import { providerRegistry } from "@/core/registries/provider-registry";
import { draftConnectHrefFor } from "@/core/providers/connect-url";
import {
  functionRegistry,
  providerNamesForFunctions,
} from "@/core/registries/function-registry";

export async function GET(): Promise<NextResponse> {
  bootstrap();
  const userId = await currentUserId();
  return NextResponse.json({ integrations: await listIntegrations(userId) });
}

interface CreateBody {
  providerName?: unknown;
  functionNames?: unknown;
  instanceLabel?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  bootstrap();

  const body = (await request.json()) as CreateBody;

  const providerName =
    typeof body.providerName === "string" ? body.providerName : "";
  const functionNames = Array.isArray(body.functionNames)
    ? body.functionNames.filter((f): f is string => typeof f === "string")
    : [];

  if (functionNames.length === 0) {
    return NextResponse.json(
      { error: "Select at least one function" },
      { status: 400 }
    );
  }

  for (const name of functionNames) {
    if (!functionRegistry.has(name)) {
      return NextResponse.json(
        { error: `Unknown function '${name}'` },
        { status: 400 }
      );
    }
  }

  const provider = providerRegistry.get(providerName);
  if (provider === undefined) {
    return NextResponse.json(
      { error: `Unknown provider '${providerName}'` },
      { status: 400 }
    );
  }

  // The provider must cover every selected function — one integration is a
  // single grant, so a provider serving only part of the set is not valid here.
  if (!providerNamesForFunctions(functionNames).includes(providerName)) {
    return NextResponse.json(
      {
        error: `${provider.label} does not support all of: ${functionNames.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const label =
    typeof body.instanceLabel === "string" && body.instanceLabel.trim() !== ""
      ? body.instanceLabel.trim()
      : provider.label;

  const draft = createDraft({
    userId: await currentUserId(),
    providerName,
    functionNames,
    instanceLabel: label,
  });

  // `connectUrl`, not `authorizeUrl`: for an API-key provider there is no
  // authorization request, just a page with a paste box.
  //
  // No `integration` in the response, because there is not one yet. Callers get
  // the draft and the URL that turns it into an integration.
  return NextResponse.json({
    draft: {
      draftId: draft.draftId,
      providerName: draft.providerName,
      functionNames: draft.functionNames,
      instanceLabel: draft.instanceLabel,
      expiresAt: new Date(draft.expiresAt).toISOString(),
    },
    connectUrl: draftConnectHrefFor(providerName, draft.draftId),
  });
}
