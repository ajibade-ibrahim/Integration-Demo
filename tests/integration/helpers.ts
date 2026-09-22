/**
 * Shared scaffolding for provider HTTP tests.
 */

import { createFakeClock, type Clock } from "@/core/sync/clock";
import type { SourcePage, SyncHandler } from "@/core/types/registry";
import type { TargetObject } from "@/core/types/common";

export interface TestContextOptions {
  accessToken?: string;
  metadata?: Record<string, string>;
  sources?: Partial<Record<TargetObject, string[]>>;
  /** Absent means refresh is impossible, so a 401 is terminal. */
  refresh?: () => Promise<{
    accessToken: string;
    metadata: Record<string, string>;
  }>;
}

export function testContext(options: TestContextOptions = {}) {
  const clock = createFakeClock(1_700_000_000_000) as Clock & {
    sleeps: number[];
  };

  const requestedSourcePaths = new Map<TargetObject, readonly string[]>();
  for (const [object, paths] of Object.entries(options.sources ?? {})) {
    requestedSourcePaths.set(object as TargetObject, paths);
  }

  return {
    clock,
    ctx: {
      integrationId: "int-test",
      accessToken: options.accessToken ?? "token-1",
      metadata: options.metadata ?? {},
      requestedSourcePaths,
      clock,
      ...(options.refresh === undefined
        ? {}
        : { refreshAccessToken: options.refresh }),
    },
  };
}

/** Drain a handler's pages into a flat, inspectable shape. */
export async function collect(
  handler: SyncHandler,
  ctx: Parameters<SyncHandler["fetchPages"]>[0]
): Promise<{
  pages: SourcePage[];
  byObject: Record<TargetObject, Record<string, unknown>[]>;
}> {
  const pages: SourcePage[] = [];
  // Every object, not just the identity pair: a handler that yields a page for
  // an object missing from this map would otherwise drop it silently, and the
  // test would assert against a shape that never arrived.
  const byObject: Record<TargetObject, Record<string, unknown>[]> = {
    customer: [],
    contact: [],
    product: [],
    offering: [],
    productFeature: [],
    agreement: [],
    subscription: [],
  };

  for await (const page of handler.fetchPages(ctx)) {
    pages.push(page);
    byObject[page.object].push(...(page.records as Record<string, unknown>[]));
  }

  return { pages, byObject };
}
