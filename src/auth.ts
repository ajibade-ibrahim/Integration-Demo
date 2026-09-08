/**
 * Auth.js server entry point.
 *
 * Credentials rather than a social provider, for the same reason the mock
 * provider exists: the demo has to run end to end with no external account, no
 * OAuth app registration, and no SMTP server. `npm run seed` creates the demo
 * user and prints how to sign in.
 *
 * Adding GitHub or Google later is additive — a provider in the array, plus
 * `@auth/prisma-adapter` and its `Account` table so a social identity can be
 * linked. That is deliberately not here yet: with credentials-only, the adapter
 * models (`Account`, `Session`, `VerificationToken`) would be three empty
 * tables, and `Session` could never be used at all while the strategy is `jwt`.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "./auth.config";
import { prisma } from "@/lib/prisma";
import { equalizeFailureTiming, verifyPassword } from "@/lib/password";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      /**
       * @returns The user on success, `null` on any failure.
       *
       * Every failure path returns the same `null` and takes comparable time.
       * Distinguishing "no such account" from "wrong password" — in the message
       * or in the latency — turns this endpoint into a way to find out who has
       * an account here.
       */
      async authorize(credentials) {
        const email = asString(credentials?.email).trim().toLowerCase();
        const password = asString(credentials?.password);

        if (email === "" || password === "") return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, passwordHash: true },
        });

        // A user with no password cannot sign in. Null is a refusal, not a
        // wildcard — the opposite reading would make every passwordless row a
        // way in.
        if (user === null || user.passwordHash === null) {
          await equalizeFailureTiming();
          return null;
        }

        if (!(await verifyPassword(password, user.passwordHash))) return null;

        return { id: user.id, email: user.email };
      },
    }),
  ],
});
