/**
 * Communication retention and fetch configuration.
 *
 * Read through functions rather than module constants so a changed environment
 * variable takes effect without a rebuild, the way the other provider settings
 * work. Invalid values fall back to the documented defaults; a zero or negative
 * window would otherwise turn a sync into an unbounded or backwards scan.
 */

export const DEFAULT_LOOKBACK_DAYS = 365;
export const DEFAULT_SYNC_OVERLAP_DAYS = 2;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
export const MAX_PAGES = 1000;

/**
 * Read a positive integer from `name`, then from its legacy spelling.
 *
 * The `GMAIL_*` names predate Slack and remain accepted so an existing
 * deployment does not silently change its retention window on upgrade. The new
 * name wins when both are set. Defaults are unchanged, which matters because
 * the lookback is part of the known-party fingerprint: changing it would force
 * one extra full scan.
 */
function positiveInt(
  name: string,
  legacyName: string,
  fallback: number
): number {
  for (const key of [name, legacyName]) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export interface CommunicationConfig {
  lookbackDays: number;
  overlapDays: number;
  pageSize: number;
  maxPages: number;
}

export function communicationConfig(): CommunicationConfig {
  return {
    lookbackDays: positiveInt(
      "COMMUNICATION_LOOKBACK_DAYS",
      "GMAIL_LOOKBACK_DAYS",
      DEFAULT_LOOKBACK_DAYS
    ),
    overlapDays: positiveInt(
      "COMMUNICATION_SYNC_OVERLAP_DAYS",
      "GMAIL_SYNC_OVERLAP_DAYS",
      DEFAULT_SYNC_OVERLAP_DAYS
    ),
    pageSize: Math.min(
      MAX_PAGE_SIZE,
      positiveInt(
        "COMMUNICATION_PAGE_SIZE",
        "GMAIL_PAGE_SIZE",
        DEFAULT_PAGE_SIZE
      )
    ),
    maxPages: MAX_PAGES,
  };
}

/** Start of the retained window at `now`. */
export function lookbackStart(now: Date): Date {
  const { lookbackDays } = communicationConfig();
  return new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
}

/** Cutoff for deleting messages older than the retained window. */
export function retentionCutoff(now: Date): Date {
  return lookbackStart(now);
}

export function overlapStart(lastCompleteSyncAt: Date): Date {
  const { overlapDays } = communicationConfig();
  return new Date(
    lastCompleteSyncAt.getTime() - overlapDays * 24 * 60 * 60 * 1000
  );
}
