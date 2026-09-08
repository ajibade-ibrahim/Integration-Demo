/**
 * Stop whatever is serving the dev port.
 *   npx tsx scripts/dev-stop.mts
 *
 * Exists because a running `next dev` caches `process.env` from the moment it
 * started: editing `.env` does not reach it, so every credential or base-URL
 * change needs a genuine restart. Chasing PIDs by hand is how you end up
 * debugging fixture data that a stale process is still serving.
 *
 * Finds the listener by port rather than by process name, so it stops the
 * server that is actually answering requests instead of every node process on
 * the machine — an editor's language server is also `node`.
 *
 * Exits 0 when nothing is listening, so `dev:restart` works from cold.
 */

import { execFileSync } from "node:child_process";

const port = process.env["PORT"] ?? "3000";
const isWindows = process.platform === "win32";

/** Run a command for its stdout, treating a non-zero exit as "no output". */
function tryExec(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Both netstat and lsof exit non-zero when they match nothing, which is a
    // normal outcome here rather than a failure.
    return "";
  }
}

/** PIDs listening on `port`. */
function listenerPids(): number[] {
  const pids = new Set<number>();

  if (isWindows) {
    for (const line of tryExec("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/)) {
      // Match the local-address column's port exactly, so :3000 does not also
      // match :30000, and only LISTENING rows — an outbound connection to the
      // port is somebody else's socket, not our server.
      if (!/\bLISTENING\b/.test(line)) continue;
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (match?.[1] === port && match[2] !== undefined) pids.add(Number(match[2]));
    }
  } else {
    for (const raw of tryExec("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split(/\s+/)) {
      if (raw !== "") pids.add(Number(raw));
    }
  }

  return [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Best-effort process name for `pid`, for the refuse-if-not-node check. */
function processName(pid: number): string {
  if (isWindows) {
    const row = tryExec("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
    return /^"([^"]+)"/.exec(row.trim())?.[1] ?? "";
  }
  return tryExec("ps", ["-p", String(pid), "-o", "comm="]).trim();
}

const pids = listenerPids();
if (pids.length === 0) {
  console.log(`Nothing listening on port ${port}.`);
  process.exit(0);
}

let stopped = 0;
for (const pid of pids) {
  const name = processName(pid);

  // Refuse anything that is not node. If some other service has the port, the
  // useful outcome is being told so — not having it killed.
  if (!/^node(\.exe)?$/i.test(name)) {
    console.error(
      `Refusing to stop PID ${pid} on port ${port}: it is '${name || "unknown"}', not node.`
    );
    continue;
  }

  // /T because `npm run dev` is a chain — npm, then next, then the server that
  // actually holds the port. Killing only the listener orphans its parents.
  if (isWindows) tryExec("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else tryExec("kill", ["-TERM", String(pid)]);

  console.log(`Stopped ${name} (PID ${pid}) on port ${port}.`);
  stopped += 1;
}

// Non-zero only when something was listening and none of it could be stopped,
// so `dev:stop && dev` does not restart on top of a still-occupied port.
if (stopped === 0) process.exit(1);
