/**
 * Where a function's synced records can be browsed.
 *
 * The link is offered only for functions that actually write records — the
 * integration page gates this on `supportedObjectsFor(...).length > 0`, the
 * same condition that enables "Edit field mapping". `support` and `usage` are
 * declared functions with no handler and no data page, so they answer `null`
 * rather than a promise of rows that do not exist.
 *
 * Function names are string literals for the same reason `object-schema.ts`
 * uses them: importing `bootstrap.ts` would close a cycle, and
 * `tests/unit/catalog-schema.test.ts` already pins the registered set.
 */

import { buildDataHref, type DataPagePath } from "@/lib/integration-scope";

const FUNCTION_DATA_TARGETS: Readonly<
  Record<string, { path: DataPagePath; tab?: string }>
> = {
  identity: { path: "/customers" },
  communication: { path: "/customers", tab: "messages" },
  catalog: { path: "/catalog" },
  agreement: { path: "/agreements" },
  billing: { path: "/billing" },
};

export function functionDataHref(
  functionName: string,
  integrationId: string
): string | null {
  const target = FUNCTION_DATA_TARGETS[functionName];
  if (target === undefined) return null;

  return buildDataHref(target.path, { tab: target.tab, integration: integrationId });
}
