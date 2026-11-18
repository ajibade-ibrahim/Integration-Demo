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

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface CommunicationConfig {
  lookbackDays: number;
  overlapDays: number;
  pageSize: number;
  maxPages: number;
}

export function communicationConfig(): CommunicationConfig {
  return {
    lookbackDays: positiveInt("GMAIL_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS),
    overlapDays: positiveInt(
      "GMAIL_SYNC_OVERLAP_DAYS",
      DEFAULT_SYNC_OVERLAP_DAYS
    ),
    pageSize: Math.min(
      MAX_PAGE_SIZE,
      positiveInt("GMAIL_PAGE_SIZE", DEFAULT_PAGE_SIZE)
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
