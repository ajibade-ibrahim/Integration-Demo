/**
 * Sign out, as a server action in a form.
 *
 * A form rather than a link because signing out is a state change: a GET that
 * ends a session can be triggered by any image tag pointing at it.
 */

import { signOut } from "@/auth";

export function SignOutButton() {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
    >
      <button type="submit" className="text-sm text-slate-600 hover:text-slate-900">
        Sign out
      </button>
    </form>
  );
}
