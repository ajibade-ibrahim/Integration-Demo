/**
 * Auth configuration shared between the server and the middleware.
 *
 * Split from `auth.ts` deliberately. The middleware runs in the edge runtime,
 * which cannot load Prisma — and the credentials provider's `authorize` queries
 * the database. Importing the full config into middleware would therefore drag
 * Prisma into a runtime that cannot execute it. Everything edge-safe lives
 * here; everything that touches the database lives in `auth.ts`.
 *
 * This is why the session strategy is `jwt` rather than database-backed: the
 * middleware has to be able to answer "is this caller signed in?" without a
 * query. It is also a hard requirement of the credentials provider, which
 * Auth.js does not support with database sessions.
 */

import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },

  // Filled in by `auth.ts`. The middleware needs none: verifying a JWT that
  // was already issued requires no provider.
  providers: [],

  callbacks: {
    jwt({ token, user }) {
      // `user` is present only on the request that signs in. After that the id
      // rides in the token, which is what lets the middleware authorize
      // without a database round trip.
      if (user?.id !== undefined) token.sub = user.id;
      return token;
    },

    session({ session, token }) {
      // `token.sub` is our `User.id`. Copying it onto the session is what makes
      // `currentUserId()` a property read rather than a lookup by email.
      if (token.sub !== undefined) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
