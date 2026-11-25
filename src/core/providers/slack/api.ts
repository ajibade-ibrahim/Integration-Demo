/**
 * Slack Web API transport and message parsing.
 *
 * Slack has no separate schema/describe surface worth sampling, and its failure
 * model is not HTTP's: almost every rejection is `200 OK` with `{ ok: false,
 * error: "<code>" }`. `slackGet` therefore wraps the shared provider session
 * (which already handles 401/429/5xx) and translates the Slack codes into the
 * platform's error taxonomy:
 *
 *   invalid_auth, not_authed, token_expired   refresh once, then reconnect
 *   token_revoked, account_inactive,          reconnect; retrying cannot help
 *     missing_scope
 *   ratelimited                               retry through the run-level backoff
 *   internal_error and friends                retry
 *   anything else                             a per-call code the handler may
 *                                             treat as a record skip
 *
 * No database imports here: the user cache is filled from the API, and the
 * handler owns attribution.
 */

import { communicationConfig } from "../../communication/config";
import { syncTiming } from "../../sync/clock";
import {
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "../../sync/errors";
import {
  asArray,
  asRecord,
  asString,
  createProviderSession,
  type ProviderSession,
  type SessionContext,
} from "../http";

export const SLACK_BASE = "https://slack.com/api";

/** Slack's own error code, preserved so the handler can skip one record. */
export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export function slackApiBase(): string {
  const configured = process.env["SLACK_API_BASE"];
  const base =
    configured === undefined || configured.trim() === ""
      ? SLACK_BASE
      : configured;
  return base.replace(/\/+$/, "");
}

function methodUrl(method: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${slackApiBase()}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

const REFRESHABLE_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_expired",
]);

const DEAD_AUTH_ERRORS = new Set([
  "token_revoked",
  "account_inactive",
  "missing_scope",
]);

const RETRYABLE_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/**
 * Call one Slack method and return the JSON body, or throw.
 *
 * The session is recreated after a refresh because its cached credential is
 * only replaced on an HTTP 401, and Slack's auth failures arrive as body-level
 * `ok: false`.
 */
export async function slackGet(
  ctx: SessionContext,
  method: string,
  params: Record<string, string | undefined> = {}
): Promise<Record<string, unknown>> {
  let current: SessionContext = ctx;
  let session: ProviderSession = createProviderSession(current, "Slack");
  let refreshed = false;

  for (;;) {
    const body = asRecord(await session.getJson(methodUrl(method, params)));
    if (body === undefined) {
      throw new SlackApiError(`Slack ${method} returned a non-object body`, "invalid_response");
    }
    if (body["ok"] === true) return body;

    const code = asString(body["error"]) ?? "unknown_error";

    if (REFRESHABLE_AUTH_ERRORS.has(code)) {
      if (!refreshed && ctx.refreshAccessToken !== undefined) {
        refreshed = true;
        const next = await ctx.refreshAccessToken();
        current = {
          ...ctx,
          accessToken: next.accessToken,
          metadata: next.metadata,
          // Never refresh twice inside one call: a second auth rejection means
          // the grant is dead rather than the token merely stale.
          refreshAccessToken: undefined,
        };
        session = createProviderSession(current, "Slack");
        continue;
      }
      throw new ReauthorizationRequiredError(
        `Slack rejected the credentials (${code}); reconnect Slack`
      );
    }

    if (DEAD_AUTH_ERRORS.has(code)) {
      throw new ReauthorizationRequiredError(
        `Slack grant is no longer usable (${code}); reconnect Slack`
      );
    }

    if (RETRYABLE_ERRORS.has(code)) {
      throw new RetryableSyncError(
        `Slack ${method} failed: ${code}`,
        code === "ratelimited" ? syncTiming().rateLimitFallbackMs : undefined
      );
    }

    // Everything else is the caller's business: `channel_not_found`,
    // `not_in_channel`, `is_archived`, `user_not_visible`, `thread_not_found`.
    throw new SlackApiError(`Slack ${method} failed: ${code}`, code);
  }
}

// ---------------------------------------------------------------------------
// Timestamps and message shape
// ---------------------------------------------------------------------------

/** Slack timestamps are `<seconds>.<microseconds>`, as a string. */
export function slackTsToDate(ts: string): Date | undefined {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(Math.round(seconds * 1000));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Convert back to Slack's `<seconds>.<microseconds>` form. */
export function dateToSlackTs(date: Date): string {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const micros = String(ms % 1000).padStart(3, "0") + "000";
  return `${seconds}.${micros}`;
}

/** The first line of text, collapsed, capped for the list view. */
export function snippetOf(message: Record<string, unknown>): string | undefined {
  const text = asString(message["text"]);
  if (text === undefined) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 197)}...`;
}

/**
 * Whether a Slack message is communication that actually happened.
 *
 * Slack's own joins and bookkeeping arrive as messages with a `subtype`; the
 * allowlist covers the three that still carry a human's words. Bot and app
 * messages are excluded outright — a workspace's bots are not its customers'
 * people — and a message with no `user` has no author to attribute.
 */
export function isIngestibleMessage(message: Record<string, unknown>): boolean {
  const subtype = asString(message["subtype"]);
  if (
    subtype !== undefined &&
    subtype !== "thread_broadcast" &&
    subtype !== "file_share" &&
    subtype !== "me_message"
  ) {
    return false;
  }
  if (message["bot_id"] !== undefined || message["app_id"] !== undefined) {
    return false;
  }
  return asString(message["user"]) !== undefined;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface SlackUser {
  id: string;
  name?: string;
  email?: string;
  teamId?: string;
  enterpriseId?: string;
  isExternal: boolean;
  isStranger: boolean;
  isBot: boolean;
  deleted: boolean;
}

export interface InstallingWorkspace {
  teamId?: string;
  enterpriseId?: string;
}

/**
 * Whether a Slack user represents a customer outside the authorizing workspace.
 *
 * Order matters: a bot or a deactivated account is never a customer, and a user
 * from the same Enterprise Grid enterprise is internal even if Slack flags them
 * as external to this workspace. Only after those facts does team membership
 * decide. Pure and exported so the rule can be tested without a server.
 */
export function isExternalSlackUser(
  user: SlackUser,
  installing: InstallingWorkspace
): boolean {
  if (user.isBot || user.deleted) return false;

  if (
    installing.enterpriseId !== undefined &&
    user.enterpriseId === installing.enterpriseId
  ) {
    return false;
  }

  if (user.isExternal || user.isStranger) return true;

  return (
    user.teamId !== undefined &&
    installing.teamId !== undefined &&
    user.teamId !== installing.teamId
  );
}

function toSlackUser(raw: Record<string, unknown>): SlackUser | undefined {
  const id = asString(raw["id"]);
  if (id === undefined) return undefined;

  const profile = asRecord(raw["profile"]);
  const name =
    asString(profile?.["real_name"]) ??
    asString(profile?.["display_name"]) ??
    asString(raw["real_name"]) ??
    asString(raw["name"]);
  const email = asString(profile?.["email"]);

  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(asString(raw["team_id"]) === undefined
      ? {}
      : { teamId: asString(raw["team_id"]) }),
    ...(asString(raw["enterprise_id"]) === undefined
      ? {}
      : { enterpriseId: asString(raw["enterprise_id"]) }),
    isExternal: raw["is_external"] === true,
    isStranger: raw["is_stranger"] === true,
    isBot: raw["is_bot"] === true,
    deleted: raw["deleted"] === true,
  };
}

/**
 * Who a Slack user is, for external classification and display names.
 *
 * `users.list` is preloaded once because the alternative — `users.info` per
 * message — is a tier-4 call on the hot path. The cache only falls back to
 * `users.info` for ids the list did not include, which is precisely the set of
 * external and invisible users the list omits.
 */
export class SlackUserCache {
  private readonly users = new Map<string, SlackUser>();
  private readonly missing = new Set<string>();

  private constructor(
    private readonly ctx: SessionContext,
    private readonly installingTeamId: string | undefined,
    private readonly installingEnterpriseId: string | undefined
  ) {}

  static async load(
    ctx: SessionContext,
    args: { teamId?: string; enterpriseId?: string }
  ): Promise<SlackUserCache> {
    const cache = new SlackUserCache(
      ctx,
      args.teamId,
      args.enterpriseId
    );

    let cursor: string | undefined;
    const maxPages = communicationConfig().maxPages;
    for (let page = 0; page < maxPages; page += 1) {
      const body = await slackGet(ctx, "users.list", {
        limit: "200",
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const item of asArray(body["members"])) {
        const record = asRecord(item);
        if (record === undefined) continue;
        const user = toSlackUser(record);
        if (user !== undefined) cache.users.set(user.id, user);
      }

      const next = asString(
        asRecord(body["response_metadata"])?.["next_cursor"]
      );
      if (next === undefined || next === cursor) break;
      cursor = next;
    }

    return cache;
  }

  /** Cached only; does not call the API. */
  peek(userId: string): SlackUser | undefined {
    return this.users.get(userId);
  }

  async get(userId: string): Promise<SlackUser | undefined> {
    const cached = this.users.get(userId);
    if (cached !== undefined) return cached;
    if (this.missing.has(userId)) return undefined;

    try {
      const body = await slackGet(this.ctx, "users.info", {
        user: userId,
      });
      const user = toSlackUser(asRecord(body["user"]) ?? {});
      if (user === undefined) {
        this.missing.add(userId);
        return undefined;
      }
      this.users.set(user.id, user);
      return user;
    } catch (error) {
      // An invisible user is a per-record gap, not a failed listing. Auth and
      // transport errors keep their original meaning and propagate.
      if (error instanceof SlackApiError) {
        this.missing.add(userId);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Whether this user represents a customer outside the authorizing workspace.
   *
   * Order matters: a bot or a deactivated account is never a customer, and a
   * user from the same Enterprise Grid enterprise is internal even if Slack
   * flags them as external to this workspace. Only after those facts does team
   * membership decide.
   */
  isExternal(user: SlackUser): boolean {
    return isExternalSlackUser(user, {
      ...(this.installingTeamId === undefined
        ? {}
        : { teamId: this.installingTeamId }),
      ...(this.installingEnterpriseId === undefined
        ? {}
        : { enterpriseId: this.installingEnterpriseId }),
    });
  }

  displayName(user: SlackUser | undefined, fallbackId: string): string {
    return user?.name ?? fallbackId;
  }
}
