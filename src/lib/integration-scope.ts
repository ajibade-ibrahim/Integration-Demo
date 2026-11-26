/**
 * Reading and writing the data pages' `?integration=` and `?page=` parameters.
 *
 * The scope is one **connection**, not a provider: two HubSpot portals are two
 * separate views. Resolving it here rather than in each page keeps the
 * "never throw, never 404" rule in one place — a stale bookmark has to render
 * the page, with a notice, because a deleted connection is not a missing route.
 *
 * Every link is built through {@link buildDataHref}. The failure this prevents
 * is quiet: a tab link that dropped `integration` would leave the filter
 * looking applied while showing every source.
 */

import { PAGE_SIZE } from "@/core/repositories/data-page";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";

export type DataPagePath =
  | "/customers"
  | "/catalog"
  | "/agreements"
  | "/billing";

export interface IntegrationScope {
  integrationId: string;
  /** The user-facing connection name, e.g. "HubSpot — Acme sandbox". */
  label: string;
}

export interface ResolvedScope {
  scope: IntegrationScope | null;
  /** Whether the request actually named a connection. */
  requested: boolean;
  /** The request named one, but it is gone or belongs to someone else. */
  unresolved: boolean;
}

/**
 * Resolve `?integration=` for the current user.
 *
 * A missing or unowned id is reported as `unresolved` rather than raised: the
 * data page still renders, unfiltered, with an amber notice. Ownership stays
 * with `findIntegrationForUser`, so a mistyped id can never widen access.
 * Must be called after `bootstrap()` — the repository reaches the provider
 * registries.
 */
export async function resolveIntegrationScope(
  raw: string | undefined,
  userId: string
): Promise<ResolvedScope> {
  if (raw === undefined || raw === "") {
    return { scope: null, requested: false, unresolved: false };
  }

  const integration = await findIntegrationForUser(raw, userId);
  if (integration === undefined) {
    return { scope: null, requested: true, unresolved: true };
  }

  return {
    scope: { integrationId: integration.id, label: integration.instanceLabel },
    requested: true,
    unresolved: false,
  };
}

/**
 * `?page=` as a 1-based page number.
 *
 * A positive *integer* or nothing: `"2.7"` is not half a page, and treating it
 * as 2 would make the URL lie about where it is.
 */
export function parsePage(raw: string | undefined): number {
  if (raw === undefined) return 1;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 1;

  const page = Number.parseInt(trimmed, 10);
  return page >= 1 ? page : 1;
}

/**
 * A data-page URL with only the parameters that are present.
 *
 * `page=1` is omitted so the first page has one canonical URL — a tab link and
 * a hand-typed `/customers` should not be two different addresses for the same
 * rows.
 *
 * `kind` is the Slack tab's conversation-kind filter. It lives here rather than
 * in that page because the pager and the tab links have to clear it or carry it
 * consistently: a chip click must reset to page 1, and a pager link must keep
 * the chip that is active.
 */
export function buildDataHref(
  path: DataPagePath,
  params: {
    tab?: string;
    integration?: string;
    page?: number;
    kind?: string;
  }
): string {
  const search = new URLSearchParams();

  if (params.tab !== undefined && params.tab !== "") {
    search.set("tab", params.tab);
  }
  if (params.integration !== undefined && params.integration !== "") {
    search.set("integration", params.integration);
  }
  if (params.kind !== undefined && params.kind !== "") {
    search.set("kind", params.kind);
  }
  if (params.page !== undefined && params.page > 1) {
    search.set("page", String(params.page));
  }

  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}

/**
 * The last page for a total.
 *
 * At least 1 even with no rows: an empty tab has a page 1, not page 0, and the
 * out-of-range redirect must be able to name it.
 */
export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
