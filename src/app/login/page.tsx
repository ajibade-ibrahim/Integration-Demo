/**
 * Sign in.
 *
 * A server action rather than a client component: the password then never
 * enters client-side state, and the page works with JavaScript disabled. The
 * only cost is that errors arrive as a query parameter instead of in-place.
 */

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Reject an off-site `next`, so a crafted link cannot use the login page as an
 * open redirect. Anything not starting with a single `/` is discarded —
 * including `//evil.example`, which a browser reads as protocol-relative.
 */
function safeNext(value: string | undefined): string {
  if (value === undefined || !value.startsWith("/") || value.startsWith("//")) {
    return "/integrations";
  }
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeNext(next);

  async function authenticate(formData: FormData): Promise<void> {
    "use server";

    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: target,
      });
    } catch (caught) {
      // A successful sign-in also throws — Next signals redirects that way — so
      // only an AuthError means the credentials were refused. Anything else has
      // to keep propagating or the redirect never happens.
      if (caught instanceof AuthError) {
        redirect(`/login?error=1&next=${encodeURIComponent(target)}`);
      }
      throw caught;
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-slate-600">
          Integrations, their credentials and their synced records belong to the
          account that created them.
        </p>
      </div>

      {error !== undefined && error !== "" && (
        // Deliberately does not say which half was wrong. Distinguishing them
        // turns this form into a way to find out who has an account here.
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Those credentials were not accepted.
        </p>
      )}

      <form action={authenticate} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in
        </button>
      </form>

      <p className="text-sm text-slate-500">
        No account yet? <code className="text-slate-700">npm run seed</code>{" "}
        creates the demo user and prints its credentials.
      </p>
    </div>
  );
}
