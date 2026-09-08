/**
 * Connect a drafted API-key integration — the first-time path.
 *
 * Nothing has been written to the database yet: this page is holding a draft id
 * and a paste box, and the integration comes into existence only if the key is
 * accepted. A static `new/connect` segment rather than a dynamic one so a draft
 * id can never be routed as an integration id.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { bootstrap } from "@/core/bootstrap";
import { findDraft } from "@/core/integrations/draft-store";
import { providerRegistry } from "@/core/registries/provider-registry";
import { ConnectPanel } from "@/app/integrations/_connect/connect-panel";

export const dynamic = "force-dynamic";

export default async function ConnectDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>;
}) {
  bootstrap();

  const { draft: draftId } = await searchParams;
  const draft = await findDraft(draftId ?? null);

  // Expired or never existed. Both mean the same thing to the user, and the
  // remedy is the same: start again. Drafts are in-process, so a server restart
  // lands here too.
  if (draft === undefined) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          This connection attempt expired
        </h1>
        <p className="text-sm text-slate-600">
          Integrations are only saved once a credential is accepted, so nothing
          was created and there is nothing to clean up. Set it up again and the
          key will be checked as you connect.
        </p>
        <Link
          href="/integrations/new"
          className="inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Start again
        </Link>
      </div>
    );
  }

  const provider = providerRegistry.get(draft.providerName);
  if (provider === undefined) notFound();

  // An OAuth draft has no paste box; it belongs at the authorize redirect.
  if (provider.auth.kind !== "apiKey") notFound();

  return (
    <ConnectPanel
      provider={provider}
      target={{ kind: "draft", draftId: draft.draftId }}
      backHref="/integrations/new"
      backLabel="Set up a different integration"
    />
  );
}
