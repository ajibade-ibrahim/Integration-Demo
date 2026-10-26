/**
 * Local scheduler: polls the cron route on an interval.
 *
 * Stands in for whatever drives `/api/cron/sync` in deployment. Run it beside
 * `npm run dev` to watch scheduled syncs happen; the manual "Sync now" button
 * remains the primary demo path.
 *
 *   npm run worker
 *   WORKER_INTERVAL_SECONDS=10 npm run worker
 */

// Next loads .env for the server; a standalone script does not. Without this
// the worker cannot see CRON_SECRET and 401s against its own application —
// which is exactly what happened the first time this ran.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env is fine; every value below has a default or is optional.
}

const BASE_URL = process.env["APP_BASE_URL"] ?? "http://localhost:3000";
const INTERVAL_SECONDS = Number.parseInt(
  process.env["WORKER_INTERVAL_SECONDS"] ?? "60",
  10
);
const SECRET = process.env["CRON_SECRET"];

interface TickResult {
  checked?: number;
  due?: number;
  expired?: number;
  recovered?: number;
  runs?: Array<{ label: string; status: string; customerCount: number; contactCount: number; error?: string }>;
  error?: string;
}

async function tick(): Promise<void> {
  const startedAt = new Date();

  try {
    const response = await fetch(`${BASE_URL}/api/cron/sync`, {
      method: "POST",
      headers:
        SECRET === undefined || SECRET === ""
          ? {}
          : { Authorization: `Bearer ${SECRET}` },
    });

    const body = (await response.json()) as TickResult;

    if (!response.ok) {
      console.error(
        `[worker] ${startedAt.toISOString()} — ${response.status}: ${body.error ?? "request failed"}`
      );
      return;
    }

    const runs = body.runs ?? [];
    console.log(
      `[worker] ${startedAt.toISOString()} — checked ${body.checked ?? 0}, due ${body.due ?? 0}, recovered ${body.recovered ?? 0}, expired ${body.expired ?? 0}`
    );
    for (const run of runs) {
      console.log(
        `           ${run.label}: ${run.status} (${run.customerCount} customers, ${run.contactCount} contacts)${run.error === undefined ? "" : ` — ${run.error}`}`
      );
    }
  } catch (error) {
    // A dev server that is not up yet is the common case; keep polling rather
    // than exiting, so worker and server can start in either order.
    console.error(
      `[worker] ${startedAt.toISOString()} — could not reach ${BASE_URL}: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

const intervalSeconds =
  Number.isFinite(INTERVAL_SECONDS) && INTERVAL_SECONDS > 0
    ? INTERVAL_SECONDS
    : 60;

console.log(
  `[worker] Polling ${BASE_URL}/api/cron/sync every ${intervalSeconds}s. Ctrl-C to stop.`
);

void tick();
setInterval(() => void tick(), intervalSeconds * 1000);
