/**
 * The one page size every synced-data read uses, plus the two expressions they
 * all share.
 *
 * Hoisted rather than repeated because the page number, the window and the
 * scope have to agree with each other: a page rendered at 50 rows and a total
 * counted with a different predicate produce a pager that claims rows the table
 * never fetched. One constant and two helpers is the smallest thing that keeps
 * them honest.
 *
 * `integrationId` only ever *narrows*. Ownership always comes from the
 * `userId` half of the scope, so a mistyped, deleted or foreign integration id
 * yields an empty result rather than another tenant's rows.
 */

/** Rows per page. Also the point at which a pager starts being rendered. */
export const PAGE_SIZE = 50;

export interface DataPageQuery {
  /** Narrow to one connected integration. Omit for every source the user owns. */
  integrationId?: string;
  /** 1-based. Out-of-range values are handled by the page, not here. */
  page?: number;
  /** Override only in tests; the pages always use {@link PAGE_SIZE}. */
  pageSize?: number;
}

export interface OwnedScope {
  integrationId?: string;
  integration: { userId: string };
}

/** `{ integration: { userId } }`, narrowed by `integrationId` when given. */
export function ownedScope(
  userId: string,
  integrationId?: string
): OwnedScope {
  return integrationId === undefined
    ? { integration: { userId } }
    : { integrationId, integration: { userId } };
}

/**
 * The `skip`/`take` pair for one page.
 *
 * `page` is floored and clamped to at least 1 here as well as in the URL
 * parser, because a repository is callable without a URL and a negative `skip`
 * is a Prisma error rather than an empty page.
 */
export function pageWindow(
  page = 1,
  pageSize = PAGE_SIZE
): { skip: number; take: number } {
  const safePage = page >= 1 ? Math.floor(page) : 1;
  return { skip: (safePage - 1) * pageSize, take: pageSize };
}
