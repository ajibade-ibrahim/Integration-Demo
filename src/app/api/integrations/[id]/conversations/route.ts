/**
 * GET    /api/integrations/[id]/conversations — mappings and eligible conversations.
 * POST   — map one conversation to a customer (or re-point an existing one).
 * DELETE — remove a mapping and its conversation's messages.
 *
 * Every request is scoped with `findIntegrationForUser`, so an id from another
 * tenant answers 404. The POST re-validates the conversation with Slack rather
 * than trusting the client's kind and label: the picker's list can be stale, and
 * Slack silently omits archived, unshared or re-keyed conversations.
 */

import { NextResponse } from "next/server";
import { bootstrap, COMMUNICATION_FUNCTION } from "@/core/bootstrap";
import { getValidToken, refreshToken } from "@/core/oauth/oauth-service";
import { SLACK_PROVIDER_NAME } from "@/core/providers/slack/provider";
import {
  listConversationMembers,
  listEligibleConversations,
  validateConversationForMapping,
} from "@/core/providers/slack/conversations";
import {
  customerBelongsToUser,
  deleteSlackConversationMapping,
  findSlackConversationMapping,
  listSlackConversationMappings,
  upsertSlackConversationMapping,
} from "@/core/repositories/slack-conversation-mapping-repository";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import type { HandlerContext } from "@/core/types/registry";
import { currentUserId } from "@/lib/current-user";

type SlackContext = Omit<HandlerContext, "requestedSourcePaths">;

function reconnectResponse(error: unknown): NextResponse | undefined {
  if (!(error instanceof ReauthorizationRequiredError)) return undefined;
  return NextResponse.json(
    { error: error.message, reconnect: true },
    { status: 409 }
  );
}

async function resolveIntegration(id: string) {
  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) return undefined;
  if (
    integration.providerName !== SLACK_PROVIDER_NAME ||
    !integration.functionNames.includes(COMMUNICATION_FUNCTION)
  ) {
    return undefined;
  }
  return integration;
}

async function slackContext(integrationId: string): Promise<SlackContext> {
  // `getValidToken` reports a failed refresh as a plain error after marking the
  // integration `requires_reauthorization`. To this route that is still "the
  // user must reconnect", so translate it into the one error the response
  // mapping understands.
  const token = await getValidToken(integrationId).catch((error: unknown) => {
    throw new ReauthorizationRequiredError(
      error instanceof Error
        ? error.message
        : "Slack credentials are no longer usable"
    );
  });
  return {
    integrationId,
    accessToken: token.accessToken,
    metadata: token.metadata,
    refreshAccessToken: async () => {
      const refreshed = await refreshToken(integrationId).catch((error: unknown) => {
        throw new ReauthorizationRequiredError(
          error instanceof Error ? error.message : "Slack token refresh failed"
        );
      });
      return {
        accessToken: refreshed.accessToken,
        metadata: refreshed.metadata,
      };
    },
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await resolveIntegration(id);
  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }
  if (integration.status !== "active") {
    return NextResponse.json(
      { error: `Integration is ${integration.status}; connect it first`, reconnect: true },
      { status: 409 }
    );
  }

  try {
    const ctx = await slackContext(integration.id);
    const [mappings, conversations] = await Promise.all([
      listSlackConversationMappings(integration.id),
      listEligibleConversations(ctx),
    ]);
    return NextResponse.json({ mappings, conversations });
  } catch (error) {
    const reconnect = reconnectResponse(error);
    if (reconnect !== undefined) return reconnect;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list conversations" },
      { status: 502 }
    );
  }
}

interface PostBody {
  conversationId?: unknown;
  customerId?: unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await resolveIntegration(id);
  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }
  if (integration.status !== "active") {
    return NextResponse.json(
      { error: `Integration is ${integration.status}; connect it first`, reconnect: true },
      { status: 409 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (
    typeof body.conversationId !== "string" ||
    body.conversationId.trim() === "" ||
    typeof body.customerId !== "string" ||
    body.customerId.trim() === ""
  ) {
    return NextResponse.json(
      { error: "Expected non-empty 'conversationId' and 'customerId' strings" },
      { status: 400 }
    );
  }
  const conversationId = body.conversationId.trim();
  const customerId = body.customerId.trim();

  if (!(await customerBelongsToUser(customerId, integration.userId))) {
    return NextResponse.json(
      { error: "Customer not found" },
      { status: 404 }
    );
  }

  try {
    const ctx = await slackContext(integration.id);
    const validation = await validateConversationForMapping(ctx, conversationId);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // A member snapshot is refreshed here so the detail page has people to show
    // before the next message sync. A lookup failure must not block saving the
    // mapping: `undefined` keeps any previous snapshot and the next sync retries.
    let members: Awaited<ReturnType<typeof listConversationMembers>>;
    try {
      members = await listConversationMembers(
        ctx,
        validation.conversation.conversationId
      );
    } catch (error) {
      console.warn(
        `[slack] Member snapshot for ${validation.conversation.conversationId} failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }

    await upsertSlackConversationMapping({
      integrationId: integration.id,
      conversationId: validation.conversation.conversationId,
      kind: validation.conversation.conversationKind,
      label: validation.conversation.label,
      customerId,
      ...(members === undefined ? {} : { members }),
    });

    return NextResponse.json({
      ok: true,
      mapping: {
        ...validation.conversation,
        customerId,
      },
    });
  } catch (error) {
    const reconnect = reconnectResponse(error);
    if (reconnect !== undefined) return reconnect;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the mapping" },
      { status: 502 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const integration = await resolveIntegration(id);
  if (integration === undefined) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (conversationId === null || conversationId.trim() === "") {
    return NextResponse.json(
      { error: "Expected a 'conversationId' query parameter" },
      { status: 400 }
    );
  }

  const existing = await findSlackConversationMapping(integration.id, conversationId);
  if (existing === undefined) {
    return NextResponse.json(
      { error: "This conversation is not mapped" },
      { status: 404 }
    );
  }

  await deleteSlackConversationMapping(integration.id, conversationId);
  return NextResponse.json({ ok: true });
}
