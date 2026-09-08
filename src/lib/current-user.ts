/**
 * The signed-in user, for request-scoped code.
 *
 * This lives in `src/lib` rather than `src/core/repositories` — where it used
 * to — because reading a session means importing Auth.js, which reaches for
 * `next/headers`. `src/core` is framework-free by rule (see the Layout section
 * of the README), and that rule is worth more than the shorter import path.
 * What stayed in `user-repository.ts` is the part that only talks to the
 * database.
 *
 * Callers can treat the returned id as trustworthy: it comes from a signed JWT,
 * not from anything in the request the caller controls.
 */

import { auth } from "@/auth";

/**
 * Raised when a request that requires a user does not have one.
 *
 * Should be unreachable in practice — `middleware.ts` turns away unauthenticated
 * requests before a route runs. It exists so that a route reachable by some path
 * the matcher does not cover fails closed with a 500 rather than proceeding
 * with an undefined user, which is how the ownership checks would silently
 * become no-ops.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("No authenticated user on this request");
    this.name = "UnauthenticatedError";
  }
}

/** @throws {UnauthenticatedError} If the request carries no valid session. */
export async function currentUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;

  if (id === undefined || id === "") throw new UnauthenticatedError();

  return id;
}
