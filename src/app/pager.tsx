/**
 * Server-rendered Previous/Next for one data-page table.
 *
 * No `"use client"`: paging is a URL change, so a link is the whole mechanism.
 * The range text is rendered beside it because "Page 2 of 3" alone does not
 * say how many rows that page actually holds.
 *
 * Disabled ends are plain spans rather than dimmed links, so a reader cannot
 * tab to a page that does not exist.
 */

import Link from "next/link";

import { PAGE_SIZE } from "@/core/repositories/data-page";
import {
  buildDataHref,
  pageCount,
  type DataPagePath,
} from "@/lib/integration-scope";

export function Pager({
  page,
  total,
  path,
  params,
}: {
  page: number;
  total: number;
  path: DataPagePath;
  /** `tab`, `integration` and `kind` only — `page` is computed by this component. */
  params: { tab?: string; integration?: string; kind?: string };
}) {
  if (total <= PAGE_SIZE) return null;

  const pages = pageCount(total);
  // The page redirects before rendering this, but clamping keeps a bad URL
  // from producing "Showing 2501–2510 of 120".
  const current = Math.min(Math.max(page, 1), pages);
  const from = (current - 1) * PAGE_SIZE + 1;
  const to = Math.min(current * PAGE_SIZE, total);

  const linkClass =
    "rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50";
  const disabledClass =
    "rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-300";

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p className="text-slate-500">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-slate-500">
          Page {current} of {pages}
        </span>
        {current > 1 ? (
          <Link
            href={buildDataHref(path, { ...params, page: current - 1 })}
            className={linkClass}
            rel="prev"
          >
            Previous
          </Link>
        ) : (
          <span className={disabledClass}>Previous</span>
        )}
        {current < pages ? (
          <Link
            href={buildDataHref(path, { ...params, page: current + 1 })}
            className={linkClass}
            rel="next"
          >
            Next
          </Link>
        ) : (
          <span className={disabledClass}>Next</span>
        )}
      </div>
    </nav>
  );
}
