/**
 * User rows.
 *
 * Session handling deliberately does *not* live here: resolving the signed-in
 * user needs Auth.js, which imports `next/headers`, and `src/core` holds no
 * framework imports. That job moved to `src/lib/current-user.ts`; what remains
 * is the database-only half, which the seed and the auth layer both use.
 */

import { prisma } from "@/lib/prisma";

export const DEMO_USER_EMAIL = "demo@integration-demo.local";

/**
 * Look up a user id by email.
 *
 * @returns The id, or `undefined` if no such user exists. Callers must not
 *   treat a miss as a reason to create one — a login that silently provisioned
 *   an account for any address typed into it would not be a login.
 */
export async function findUserIdByEmail(
  email: string
): Promise<string | undefined> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true },
  });
  return user?.id;
}
