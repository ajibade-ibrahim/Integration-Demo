/**
 * GET /api/oauth/[provider]/start?draftId=...
 * GET /api/oauth/[provider]/start?integrationId=...
 *
 * Redirects to the provider's consent screen with the scopes resolved from the
 * function set being connected.
 *
 * Two callers, because a first-time connect and a reconnect start from
 * different places. A new integration is still a *draft* at this point — no row
 * exists, and none is created unless the user comes back with a usable grant —
 * so it is identified by `draftId`. A reconnect has a row already and uses
 * `integrationId`. Both end up in the same authorization request; only the
 * state's subject differs, which is what tells the callback whether to create a
 * row or update one.
 */

import { NextResponse } from "next/server";
import { bootstrap } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { buildAuthorizationRequest } from "@/core/oauth/oauth-service";
import { findDraft } from "@/core/integrations/draft-store";
import { providerRegistry } from "@/core/registries/provider-registry";
import {
  connectHrefFor,
  draftConnectHrefFor,
} from "@/core/providers/connect-url";
import type { StateSubject } from "@/core/oauth/state-store";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { provider } = await context.params;
  const params = new URL(request.url).searchParams;
  const draftId = params.get("draftId");
  const integrationId = params.get("integrationId");

  const resolved =
    draftId !== null && draftId !== ""
      ? resolveDraft(draftId)
      : await resolveIntegration(integrationId);

  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.connectUrl === undefined ? {} : { connectUrl: resolved.connectUrl }) },
      { status: resolved.status }
    );
  }

  // The route's provider segment and the resolved record must agree; a mismatch
  // means a hand-edited URL, and the stored config is authoritative.
  if (resolved.providerName !== provider) {
    return NextResponse.json(
      { error: "Provider does not match this integration" },
      { status: 400 }
    );
  }

  try {
    const { url } = buildAuthorizationRequest({
      subject: resolved.subject,
      providerName: resolved.providerName,
      functionNames: resolved.functionNames,
    });
    return NextResponse.redirect(url);
  } catch (error) {
    // Unconfigured credentials and unsupported (function, provider) pairs both
    // land here; both are actionable messages, neither leaks a secret.
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not start authorization",
      },
      { status: 400 }
    );
  }
}

interface Resolved {
  subject: StateSubject;
  providerName: string;
  functionNames: readonly string[];
}

interface Unresolved {
  error: string;
  status: number;
  connectUrl?: string;
}

function resolveDraft(draftId: string): Resolved | Unresolved {
  const draft = findDraft(draftId);
  if (draft === undefined) {
    // 410, not 404: this id was valid and has expired, which is a different
    // thing for the user to be told than "no such thing".
    return {
      error: "This connection attempt expired. Start it again.",
      status: 410,
    };
  }

  const definition = providerRegistry.get(draft.providerName);
  if (definition?.auth.kind === "apiKey") {
    return {
      error: `${definition.label} connects with an API key, not OAuth`,
      status: 400,
      connectUrl: draftConnectHrefFor(draft.providerName, draft.draftId),
    };
  }

  return {
    subject: { kind: "draft", draftId: draft.draftId },
    providerName: draft.providerName,
    functionNames: draft.functionNames,
  };
}

async function resolveIntegration(
  integrationId: string | null
): Promise<Resolved | Unresolved> {
  if (integrationId === null || integrationId === "") {
    return { error: "draftId or integrationId is required", status: 400 };
  }

  // Reconnecting an integration is as sensitive as creating one: it rewrites
  // the credential the sync engine will use. Scope it to the caller.
  const integration = await findIntegrationForUser(
    integrationId,
    await currentUserId()
  );
  if (integration === undefined) {
    return { error: "Integration not found", status: 404 };
  }

  // An API-key provider has no authorization server, so this route can only be
  // reached here by a hand-typed URL. Point the user at the page that works.
  const definition = providerRegistry.get(integration.providerName);
  if (definition?.auth.kind === "apiKey") {
    return {
      error: `${definition.label} connects with an API key, not OAuth`,
      status: 400,
      connectUrl: connectHrefFor(integration.providerName, integration.id),
    };
  }

  return {
    subject: { kind: "integration", integrationId: integration.id },
    providerName: integration.providerName,
    functionNames: integration.functionNames,
  };
}
