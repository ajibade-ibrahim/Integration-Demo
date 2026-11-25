import Link from "next/link";
import { notFound } from "next/navigation";

import {
  bootstrap,
  COMMUNICATION_FUNCTION,
} from "@/core/bootstrap";
import { connectHrefFor } from "@/core/providers/connect-url";
import { getValidToken, refreshToken } from "@/core/oauth/oauth-service";
import { SLACK_PROVIDER_NAME } from "@/core/providers/slack/provider";
import { listEligibleConversations } from "@/core/providers/slack/conversations";
import {
  listSlackConversationMappings,
  listCustomerOptionsForUser,
} from "@/core/repositories/slack-conversation-mapping-repository";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { ReauthorizationRequiredError } from "@/core/sync/errors";
import type { HandlerContext } from "@/core/types/registry";
import { currentUserId } from "@/lib/current-user";
import {
  ConversationMapper,
  type ConversationRow,
} from "./conversation-mapper";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const userId = await currentUserId();
  const integration = await findIntegrationForUser(id, userId);
  if (integration === undefined) notFound();

  if (
    integration.providerName !== SLACK_PROVIDER_NAME ||
    !integration.functionNames.includes(COMMUNICATION_FUNCTION)
  ) {
    notFound();
  }

  const [mappings, customers] = await Promise.all([
    listSlackConversationMappings(integration.id),
    listCustomerOptionsForUser(userId),
  ]);

  let eligible: Awaited<ReturnType<typeof listEligibleConversations>> = [];
  let reconnectNeeded = integration.status !== "active";
  let conversationError: string | undefined;

  if (!reconnectNeeded) {
    try {
      // Acquiring a token is the one step that needs a live grant even to list
      // conversations. A dead grant is a reconnect prompt, not a crash.
      const token = await getValidToken(integration.id);

      try {
        const ctx: Omit<HandlerContext, "requestedSourcePaths"> = {
          integrationId: integration.id,
          accessToken: token.accessToken,
          metadata: token.metadata,
          refreshAccessToken: async () => {
            const refreshed = await refreshToken(integration.id);
            return {
              accessToken: refreshed.accessToken,
              metadata: refreshed.metadata,
            };
          },
        };
        eligible = await listEligibleConversations(ctx);
      } catch (error) {
        // A provider hiccup while listing is shown beside an otherwise usable
        // page; only a rejected grant forces the reconnect action.
        if (error instanceof ReauthorizationRequiredError) {
          reconnectNeeded = true;
        }
        conversationError =
          error instanceof Error ? error.message : "Could not list conversations";
      }
    } catch (error) {
      reconnectNeeded = true;
      conversationError =
        error instanceof Error ? error.message : "Could not acquire a Slack token";
    }
  }

  const eligibleById = new Map(
    eligible.map((conversation) => [conversation.conversationId, conversation])
  );
  const mappedIds = new Set(mappings.map((mapping) => mapping.conversationId));

  const rows: ConversationRow[] = [
    ...mappings.map<ConversationRow>((mapping) => {
      const conversation = eligibleById.get(mapping.conversationId);
      return {
        conversationId: mapping.conversationId,
        conversationKind: mapping.conversationKind,
        label: mapping.label,
        customerId: mapping.customerId,
        customerName: mapping.customerName,
        available: conversation !== undefined,
        ...(conversation === undefined
          ? {}
          : {
              isPrivate: conversation.isPrivate,
              isMember: conversation.isMember,
              ...(conversation.memberCount === undefined
                ? {}
                : { memberCount: conversation.memberCount }),
            }),
      };
    }),
    ...eligible
      .filter((conversation) => !mappedIds.has(conversation.conversationId))
      .map<ConversationRow>((conversation) => ({
        conversationId: conversation.conversationId,
        conversationKind: conversation.conversationKind,
        label: conversation.label,
        customerId: "",
        customerName: "",
        available: true,
        isPrivate: conversation.isPrivate,
        isMember: conversation.isMember,
        ...(conversation.memberCount === undefined
          ? {}
          : { memberCount: conversation.memberCount }),
      })),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/integrations/${integration.id}`}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← {integration.instanceLabel}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Conversations
        </h1>
        <p className="mt-1 max-w-3xl text-slate-600">
          Choose which Slack conversations belong to which customer. Only mapped
          conversations are read. Coverage is exactly what the authorizing
          teammate can see in Slack — shared channels, Connect DMs and group DMs
          with an external person.
        </p>
      </div>

      {reconnectNeeded && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
          <p className="text-sm font-medium text-orange-900">
            Slack needs to be reconnected
          </p>
          <p className="mt-1 text-sm text-orange-800">
            {conversationError ??
              "The stored authorization cannot list conversations. Reconnect to refresh the grant."}
          </p>
          <a
            href={connectHrefFor(SLACK_PROVIDER_NAME, integration.id)}
            className="mt-3 inline-block rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-500"
          >
            Reconnect Slack
          </a>
        </div>
      )}

      {!reconnectNeeded && conversationError !== undefined && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {conversationError}
        </p>
      )}

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Messages in a mapped conversation, including internal discussion, are
        stored and attributed to the selected customer. Unmapping a conversation
        deletes its stored messages and resets the next sync to a full scan.
      </div>

      {mappings.length === 0 && !reconnectNeeded && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
          No conversations are mapped yet. Until one is, a communication sync
          will produce no messages.
        </p>
      )}

      <ConversationMapper
        integrationId={integration.id}
        rows={rows}
        customers={customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          integrationLabel: customer.integrationLabel,
        }))}
        disabled={reconnectNeeded}
      />
    </div>
  );
}
