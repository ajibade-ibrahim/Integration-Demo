/**
 * Authentication gate.
 *
 * Default-deny: everything the matcher reaches requires a session unless it is
 * named below. The alternative — protecting a list of private paths — fails
 * open, and a route added later without a matching entry is unprotected with
 * nothing to notice it. That is the shape of the bug this replaced.
 *
 * Runs on `authConfig` only, never `auth.ts`: the credentials provider queries
 * Prisma, which cannot load in the edge runtime. With a JWT session strategy
 * the cookie is self-contained, so the check here costs no database round trip.
 *
 * This is a gate, not an authorization check. It proves *a* user is signed in;
 * it says nothing about whether they own the integration in the path. That is
 * `findIntegrationForUser`'s job, at every route, and it is deliberately not
 * centralized here — a middleware cannot know which of the many id-shaped path
 * segments in this app denotes an integration.
 */

import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "./auth.config";

const { auth } = NextAuth(authConfig);

/**
 * Paths reachable with no session, each for a reason that is not "convenience".
 *
 * - `/login` — the way in. Gating it would be a redirect loop.
 * - `/api/auth` — Auth.js's own endpoints, including the sign-in POST.
 * - `/api/cron/sync` — called by a platform scheduler with no browser and no
 *   cookie. It carries its own bearer secret and refuses to run in production
 *   without one.
 * - `/api/oauth` — the provider redirects the browser back to `.../callback`,
 *   and the fake/mock endpoints are reached server-to-server by the sync engine
 *   with no session at all. The callback's protection is its single-use state
 *   value, and `/start` — the only place that state is issued — checks
 *   ownership before issuing it.
 * - `/api/fake` — the in-app Metrifox stand-in, fetched by the sync engine over
 *   HTTP as if it were a third party. Off unless `ENABLE_METRIFOX_FAKE` is set.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/cron/sync",
  "/api/oauth",
  "/api/fake",
] as const;

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export default auth((request) => {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname) || request.auth !== null) return NextResponse.next();

  // An API caller wants a status it can branch on, not a login page it would
  // have to parse to discover it was never signed in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const login = new URL("/login", request.nextUrl);
  // Preserved so a bookmarked deep link survives the round trip through login.
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
});

export const config = {
  /*
   * Everything except Next's own assets and the favicon. Those are matched out
   * here rather than added to PUBLIC_PREFIXES because they are not routes —
   * running the gate on every static chunk would be pure overhead.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
