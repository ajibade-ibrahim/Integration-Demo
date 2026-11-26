/**
 * What a scoped data page says it is showing, and how to leave the scope.
 *
 * The banner exists so the filter is never invisible. A page that silently
 * shows one connection's rows is indistinguishable from a page missing data
 * after a failed sync — and the user's way out ("Show all sources") has to be
 * on the page rather than in the address bar.
 *
 * `note` is used by the Accounts tab, which is a cross-source merge and cannot
 * honestly promise "only this connection".
 */

import Link from "next/link";

export function ScopeBanner({
  label,
  clearHref,
  note,
}: {
  label: string;
  clearHref: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-700">
          Showing data synced from{" "}
          <span className="font-medium">{label}</span>.
        </p>
        <Link
          href={clearHref}
          className="text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900"
        >
          Show all sources
        </Link>
      </div>
      {note !== undefined && (
        <p className="mt-2 text-sm text-slate-500">{note}</p>
      )}
    </div>
  );
}

/**
 * The amber counterpart: a connection was named, but it is gone or not yours.
 *
 * The page renders unfiltered rather than 404ing, because a stale bookmark is
 * a bookmarked view, not a broken route. Ownership still came from `userId`, so
 * this is a notice about the *filter*, never a disclosure about the id.
 */
export function UnresolvedScopeNotice() {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      That connection is no longer available, so all sources are shown.
    </p>
  );
}
