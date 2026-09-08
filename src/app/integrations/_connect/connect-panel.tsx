/**
 * The API-key connect screen body, shared by the two routes that show it.
 *
 * `/integrations/new/connect` connects a draft (no row exists yet);
 * `/integrations/[id]/connect` re-keys an existing integration. The page is
 * identical apart from where the back link goes, so it lives here rather than
 * being copied — a divergence between the two would mean one of them quietly
 * losing the security note or the instructions.
 */

import Link from "next/link";
import type { ProviderDefinition } from "@/core/types/registry";
import { ApiKeyForm, type ConnectTarget } from "./key-form";

export function ConnectPanel({
  provider,
  target,
  backHref,
  backLabel,
}: {
  provider: ProviderDefinition;
  target: ConnectTarget;
  backHref: string;
  backLabel: string;
}) {
  if (provider.auth.kind !== "apiKey") {
    throw new Error("ConnectPanel is only for API-key providers");
  }
  const auth = provider.auth;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link
          href={backHref}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          ← {backLabel}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Connect {provider.label}
        </h1>
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        {auth.instructions}
      </p>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <ApiKeyForm target={target} placeholder={auth.placeholder} />
      </div>

      <p className="text-xs text-slate-500">
        The key is checked against {provider.label} before it is saved, so a
        typo is caught here rather than at the first sync. It is encrypted at
        rest and never displayed again.
        {target.kind === "draft" && (
          <>
            {" "}
            This integration is not created until the key is accepted — if it is
            rejected, nothing is added to your list.
          </>
        )}
      </p>
    </div>
  );
}
