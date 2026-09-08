"use client";

import { useMemo, useState } from "react";

export interface FunctionOption {
  name: string;
  label: string;
  description: string;
  dataModels: string[];
  providers: string[];
  scopesByProvider: Record<string, string[]>;
  hasHandler: boolean;
}

export interface ProviderOption {
  name: string;
  label: string;
  description: string;
  configured: boolean;
  authKind: "oauth" | "apiKey";
  /** What the user must do before this provider works, if anything. */
  credentialHint: string;
}

export function NewIntegrationForm({
  functions,
  providers,
}: {
  functions: FunctionOption[];
  providers: ProviderOption[];
}) {
  const [selectedFunctions, setSelectedFunctions] = useState<string[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Providers covering *every* selected function. An integration is a single
   * OAuth grant, so a provider serving only part of the set cannot be used.
   */
  const candidates = useMemo(() => {
    if (selectedFunctions.length === 0) return [];
    return providers.filter((provider) =>
      selectedFunctions.every((fn) =>
        functions.find((f) => f.name === fn)?.providers.includes(provider.name)
      )
    );
  }, [selectedFunctions, providers, functions]);

  /** Exactly what will be requested at consent. */
  const scopes = useMemo(() => {
    if (selectedProvider === null) return [];
    const union = new Set<string>();
    for (const fn of selectedFunctions) {
      const definition = functions.find((f) => f.name === fn);
      for (const scope of definition?.scopesByProvider[selectedProvider] ?? []) {
        union.add(scope);
      }
    }
    return [...union].sort();
  }, [selectedFunctions, selectedProvider, functions]);

  function toggleFunction(name: string): void {
    setError(null);
    setSelectedFunctions((current) => {
      const next = current.includes(name)
        ? current.filter((f) => f !== name)
        : [...current, name];
      // The chosen provider may not cover the new set.
      setSelectedProvider((provider) =>
        provider !== null &&
        next.every((fn) =>
          functions.find((f) => f.name === fn)?.providers.includes(provider)
        )
          ? provider
          : null
      );
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (selectedProvider === null) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: selectedProvider,
          functionNames: selectedFunctions,
          instanceLabel: label,
        }),
      });
      const body = (await response.json()) as {
        connectUrl?: string;
        error?: string;
      };

      if (!response.ok || body.connectUrl === undefined) {
        setError(body.error ?? "Could not create the integration");
        setSubmitting(false);
        return;
      }
      window.location.href = body.connectUrl;
    } catch {
      setError("Could not reach the server");
      setSubmitting(false);
    }
  }

  const noProviders = selectedFunctions.length > 0 && candidates.length === 0;

  const isApiKeyProvider =
    providers.find((p) => p.name === selectedProvider)?.authKind === "apiKey";

  return (
    <div className="space-y-8">
      {/* Step 1 — functions */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          1. What is this integration for?
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {functions.map((fn) => {
            const checked = selectedFunctions.includes(fn.name);
            return (
              <label
                key={fn.name}
                className={`cursor-pointer rounded-xl border p-4 transition ${
                  checked
                    ? "border-slate-900 bg-white ring-1 ring-slate-900"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => toggleFunction(fn.name)}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{fn.label}</span>
                      {!fn.hasHandler && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                          no sync yet
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{fn.description}</p>
                    <p className="mt-1.5 text-xs text-slate-400">
                      {fn.providers.length === 0
                        ? "No providers available"
                        : `${fn.providers.length} provider${fn.providers.length === 1 ? "" : "s"}`}
                    </p>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* Step 2 — provider */}
      {selectedFunctions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            2. Connect which system?
          </h2>

          {noProviders ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              No provider supports every function you selected. One integration
              is a single connection to a single account, so it needs a provider
              that covers the whole set — try selecting fewer functions, or set
              up a second integration.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {candidates.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  onClick={() => setSelectedProvider(provider.name)}
                  className={`rounded-xl border p-4 text-left transition ${
                    selectedProvider === provider.name
                      ? "border-slate-900 bg-white ring-1 ring-slate-900"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.label}</span>
                    {!provider.configured && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                        needs credentials
                      </span>
                    )}
                    {/*
                      Neutral, not a warning: an API-key provider is ready to
                      use, it just connects by a different route than a
                      redirect. Saying so here avoids the surprise of clicking
                      Create and landing on a paste box instead of a consent
                      screen.
                    */}
                    {provider.authKind === "apiKey" && (
                      <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
                        API key
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {provider.description}
                  </p>
                  {(!provider.configured || provider.authKind === "apiKey") && (
                    <p className="mt-1.5 text-xs text-slate-400">
                      {provider.credentialHint}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Step 3 — scopes and confirm */}
      {selectedProvider !== null && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {isApiKeyProvider
              ? "3. Data this integration will read"
              : "3. Permissions that will be requested"}
          </h2>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <ul className="space-y-1.5">
              {scopes.map((scope) => (
                <li key={scope} className="font-mono text-[13px] text-slate-700">
                  {scope}
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {isApiKeyProvider
                ? // An API key has no consent step to narrow, so this list
                  // describes what the integration reads rather than what it
                  // is granted. Saying "requested" here would overclaim.
                  "Determined by the functions selected above. An API key grants whatever the key itself can reach, so this is what the integration reads, not a limit imposed at connect time."
                : "Determined entirely by the functions selected above. Choosing different functions changes this list."}
            </p>
          </div>

          <label className="block">
            <span className="text-sm text-slate-600">Name (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. HubSpot — production"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          {error !== null && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </section>
      )}
    </div>
  );
}
