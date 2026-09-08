/**
 * Re-key an existing API-key integration.
 *
 * The counterpart to the OAuth "Reconnect" redirect. A first-time connect does
 * not come here — it has no integration row yet and lives at
 * `/integrations/new/connect` until its key is accepted.
 *
 * An OAuth integration reaching here has taken a wrong turn, so it is bounced
 * back to its detail page rather than shown a paste box it cannot use.
 */

import { notFound, redirect } from "next/navigation";
import { bootstrap } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import { providerRegistry } from "@/core/registries/provider-registry";
import { ConnectPanel } from "@/app/integrations/_connect/connect-panel";

export const dynamic = "force-dynamic";

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  bootstrap();

  const { id } = await params;
  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) notFound();

  const provider = providerRegistry.get(integration.providerName);
  if (provider === undefined) notFound();
  if (provider.auth.kind !== "apiKey") redirect(`/integrations/${id}`);

  return (
    <ConnectPanel
      provider={provider}
      target={{ kind: "integration", integrationId: id }}
      backHref={`/integrations/${id}`}
      backLabel={integration.instanceLabel}
    />
  );
}
