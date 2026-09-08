/**
 * Put our `User.id` on the session type.
 *
 * Auth.js's default session user carries name, email and image but no id. Every
 * query in this app is scoped by `userId`, so without this augmentation
 * `currentUserId()` would have to cast, and a typo in the property name would
 * compile.
 */

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}
