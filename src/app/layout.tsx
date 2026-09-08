import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

import { auth } from "@/auth";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = {
  title: "Integration Demo",
  description:
    "Connect CRM, billing, usage, support and communication systems by function-scoped OAuth.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Drives the header only. Nothing here gates access — that is middleware.ts.
  const session = await auth();

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Integration Demo
            </Link>
            <nav className="flex gap-5 text-sm text-slate-600">
              <Link href="/integrations" className="hover:text-slate-900">
                Integrations
              </Link>
              <Link href="/customers" className="hover:text-slate-900">
                Synced data
              </Link>
            </nav>
            {session !== null && (
              <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
                <span>{session.user?.email}</span>
                <SignOutButton />
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
