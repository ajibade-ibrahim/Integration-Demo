import Link from "next/link";
import { notFound } from "next/navigation";

import { bootstrap } from "@/core/bootstrap";
import {
  findSlackConversationForUser,
  type SlackConversationThreadMessage,
} from "@/core/repositories/slack-conversation-repository";
import { currentUserId } from "@/lib/current-user";
import { SLACK_CONVERSATION_KIND_LABELS } from "../../slack-kind";

export const dynamic = "force-dynamic";

export default async function SlackConversationDetailPage({
  params,
}: {
  params: Promise<{ mappingId: string }>;
}) {
  bootstrap();

  const { mappingId } = await params;
  const conversation = await findSlackConversationForUser(
    mappingId,
    await currentUserId()
  );
  if (conversation === undefined) notFound();

  const truncated =
    conversation.loadedMessageCount < conversation.totalMessageCount;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/customers?tab=slack"
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← Slack conversations
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {conversation.label}
        </h1>
        <p className="mt-1 text-slate-600">
          {SLACK_CONVERSATION_KIND_LABELS[conversation.conversationKind].singular}{" "}
          · {conversation.integrationLabel}
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Conversation
        </h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Label</dt>
            <dd className="text-slate-900">{conversation.label}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Kind</dt>
            <dd className="text-slate-900">
              {SLACK_CONVERSATION_KIND_LABELS[conversation.conversationKind].singular}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Slack conversation id</dt>
            <dd className="font-mono text-xs text-slate-700">
              {conversation.conversationId}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Mapped customer</dt>
            <dd className="text-slate-900">
              <Link href="/customers" className="hover:underline">
                {conversation.customer.name}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Members</dt>
            <dd className="text-slate-900">{conversation.members.length}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Messages</dt>
            <dd className="text-slate-900">{conversation.totalMessageCount}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Members
        </h2>
        {conversation.members.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No member snapshot has been stored for this conversation.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {conversation.members.map((member) => (
              <li key={member.slackUserId} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">
                    {member.name ?? member.slackUserId}
                  </span>
                  <AudienceBadge external={member.isExternal} />
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  <span className="font-mono">{member.slackUserId}</span>
                  {member.email === null ? "" : ` · ${member.email}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Threads
          </h2>
          {truncated && (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              Showing latest {conversation.loadedMessageCount} of{" "}
              {conversation.totalMessageCount} messages
            </p>
          )}
        </div>

        {conversation.threads.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            No messages have been stored for this conversation.
          </p>
        ) : (
          conversation.threads.map((thread) => (
            <article
              key={thread.threadRootTs}
              className="rounded-xl border border-slate-200 bg-white"
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Thread
                </p>
                <p className="font-mono text-xs text-slate-400">
                  root {thread.threadRootTs}
                </p>
              </header>

              {!thread.rootRetained && (
                <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  Earlier thread messages not loaded. The root (
                  <span className="font-mono">{thread.threadRootTs}</span>) is
                  older than the retained window; these are its retained replies.
                </p>
              )}

              <ul className="divide-y divide-slate-100">
                {thread.messages.map((message) => (
                  <MessageRow key={message.id} message={message} />
                ))}
              </ul>
            </article>
          ))
        )}
      </section>
    </div>
  );
}

function MessageRow({
  message,
}: {
  message: SlackConversationThreadMessage;
}) {
  return (
    <li id={message.id} className="scroll-mt-6 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">
          {message.authorName ?? message.authorId}
        </span>
        <AudienceBadge external={message.authorIsExternal} />
        {message.isThreadRoot && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
            root
          </span>
        )}
        <span className="text-xs text-slate-400">
          {message.sentAt.toLocaleString()} · {message.direction}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        <span className="font-mono">{message.authorId}</span>
        {message.authorEmail === null ? "" : ` · ${message.authorEmail}`}
        {message.authorContactName === null
          ? ""
          : ` · matched contact: ${message.authorContactName}`}
      </p>
      {message.bodyText === null ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-slate-800">
          {message.snippet ?? "No message text."}
        </p>
      ) : (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-sans text-slate-800">
          {message.bodyText}
        </pre>
      )}
    </li>
  );
}

function AudienceBadge({ external }: { external: boolean }) {
  return (
    <span
      className={
        external
          ? "rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
          : "rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700"
      }
    >
      {external ? "external" : "internal"}
    </span>
  );
}
