import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Function-scoped integrations
        </h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Choose what an integration is for before connecting it. The functions
          you pick determine the OAuth scopes requested, so consent asks for
          exactly what those functions need — nothing more.
        </p>
      </div>
      <Link
        href="/integrations"
        className="inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        View integrations
      </Link>
    </div>
  );
}
