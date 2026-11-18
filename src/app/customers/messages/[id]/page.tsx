import Link from "next/link";
import { notFound } from "next/navigation";

import { bootstrap } from "@/core/bootstrap";
import { findMessageForUser } from "@/core/repositories/message-repository";
import { currentUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function MessageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const message = await findMessageForUser(id, await currentUserId());
  if (message === undefined) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/customers?tab=messages"
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← Messages
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {message.subject ?? "(no subject)"}
        </h1>
        <p className="mt-1 text-slate-600">
          {message.direction} · {message.sentAt.toLocaleString()} ·{" "}
          {message.integrationLabel}
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Addresses
        </h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">From</dt>
            <dd className="text-slate-900">
              {message.fromName ?? message.fromEmail ?? "—"}
              {message.fromName !== null && message.fromEmail !== null && (
                <span className="ml-1 text-slate-500">
                  &lt;{message.fromEmail}&gt;
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">To</dt>
            <dd className="break-words text-slate-900">
              {message.toEmails.length === 0 ? "—" : message.toEmails.join(", ")}
            </dd>
          </div>
          {message.ccEmails.length > 0 && (
            <div>
              <dt className="text-slate-500">Cc</dt>
              <dd className="break-words text-slate-900">
                {message.ccEmails.join(", ")}
              </dd>
            </div>
          )}
          {message.threadId !== null && (
            <div>
              <dt className="text-slate-500">Thread</dt>
              <dd className="font-mono text-xs text-slate-700">
                {message.threadId}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Participants
        </h2>
        <ul className="mt-3 divide-y divide-slate-100">
          {message.participants.map((participant) => (
            <li key={participant.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                  {participant.role}
                </span>
                <span className="font-medium text-slate-900">
                  {participant.contactName ??
                    participant.customerName ??
                    participant.accountName ??
                    participant.matchedValue}
                </span>
                {participant.isPrimary && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">
                    primary
                  </span>
                )}
                {participant.disputed && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                    ambiguous
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {participant.matchKind} · {participant.matchedValue} · rank{" "}
                {participant.rank}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Body
        </h2>
        {message.bodyText === null ? (
          <p className="mt-2 text-sm text-slate-500">No plain-text body.</p>
        ) : (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-sm text-slate-800">
            {message.bodyText}
          </pre>
        )}
      </section>

      {message.bodyHtml !== null && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              HTML source (not rendered)
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {message.bodyHtml}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
