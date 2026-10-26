/**
 * New integration: pick functions, then a provider that covers all of them.
 *
 * Functions come first because they determine the scopes. The provider list is
 * the intersection of providers with a working handler and scopes for every
 * selected function, and the resolved scope and target-object lists are shown
 * before connecting so there is no surprise on the consent screen.
 */

import { bootstrap } from "@/core/bootstrap";
import {
  supportedObjectsFor,
  syncableProviderNamesForFunction,
} from "@/core/capabilities";
import { functionRegistry } from "@/core/registries/function-registry";
import {
  credentialHint,
  isProviderConfigured,
  providerRegistry,
} from "@/core/registries/provider-registry";
import { NewIntegrationForm, type FunctionOption, type ProviderOption } from "./form";

export const dynamic = "force-dynamic";

export default function NewIntegrationPage() {
  bootstrap();

  const functions: FunctionOption[] = functionRegistry.getAll().map((definition) => {
    // Only pairs with a handler and scopes are offered. A declared function
    // with no implementation stays on the page as a visibly unavailable
    // roadmap item, but it cannot be selected and cannot reach a provider list.
    const providers = syncableProviderNamesForFunction(definition.name);

    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      providers,
      scopesByProvider: Object.fromEntries(
        providers.map((provider) => [
          provider,
          [...(definition.scopesByProvider.get(provider) ?? [])],
        ])
      ),
      objectsByProvider: Object.fromEntries(
        providers.map((provider) => [
          provider,
          [...supportedObjectsFor(definition.name, provider)],
        ])
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
          functions — a single billing system can supply identity, catalog,
          agreement and billing data — and the permissions requested are the
          union of what those functions need.
        </p>
      </div>
      <NewIntegrationForm functions={functions} providers={providers} />
    </div>
  );
}
