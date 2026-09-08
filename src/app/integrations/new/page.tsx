/**
 * New integration: pick functions, then a provider that covers all of them.
 *
 * Functions come first because they determine the scopes. The provider list is
 * the intersection of providers supporting every selected function, and the
 * resolved scope list is shown before connecting so there is no surprise on the
 * consent screen.
 */

import { bootstrap } from "@/core/bootstrap";
import { functionRegistry } from "@/core/registries/function-registry";
import {
  credentialHint,
  isProviderConfigured,
  providerRegistry,
} from "@/core/registries/provider-registry";
import { getSyncHandler } from "@/core/registries/handler-registry";
import { NewIntegrationForm, type FunctionOption, type ProviderOption } from "./form";

export const dynamic = "force-dynamic";

export default function NewIntegrationPage() {
  bootstrap();

  const functions: FunctionOption[] = functionRegistry.getAll().map((definition) => {
    const providers = [...definition.scopesByProvider.entries()]
      .filter(([, scopes]) => scopes.length > 0)
      .map(([provider]) => provider);

    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      dataModels: [...definition.dataModels],
      providers,
      scopesByProvider: Object.fromEntries(
        [...definition.scopesByProvider.entries()].map(([p, s]) => [p, [...s]])
      ),
      // A function with no registered handler can be selected in principle but
      // would authorize and then have nothing to sync, so it is offered as
      // visibly unavailable rather than hidden.
      hasHandler: providers.some(
        (provider) => getSyncHandler(definition.name, provider) !== undefined
      ),
    };
  });

  const providers: ProviderOption[] = providerRegistry.getAll().map((provider) => ({
    name: provider.name,
    label: provider.label,
    description: provider.description,
    configured: isProviderConfigured(provider),
    authKind: provider.auth.kind,
    credentialHint: credentialHint(provider),
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New integration</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Pick what this integration is for. One connection can serve several
          functions — a single CRM account can supply identity data and support
          tickets — and the permissions requested are the union of what those
          functions need.
        </p>
      </div>
      <NewIntegrationForm functions={functions} providers={providers} />
    </div>
  );
}
