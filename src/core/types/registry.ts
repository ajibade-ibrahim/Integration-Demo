/**
 * Registry types — the extension points of the platform.
 *
 * Adding a provider or a function means registering a definition, not editing
 * orchestration code. The sync engine, OAuth service, and UI all read from
 * these registries.
 */

import type { Clock } from "../sync/clock";
import type { RawRecord, TargetObject } from "./common";

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * A declared purpose for an integration — the thing the user picks first.
 *
 * `scopesByProvider` is the mechanism behind the platform's central rule: the
 * OAuth scopes requested are determined by the function selected, so consent
 * asks for exactly what the function needs and nothing more.
 */
export interface FunctionDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /**
   * Internal record types this function syncs, e.g. ["customer", "contact"]
   * for identity or ["ticket"] for support.
   *
   * Loosely typed on purpose: a function may name a data model before this
   * codebase carries a schema or handler for it, which is what lets the
   * function picker show the full roadmap honestly instead of only what is
   * already built.
   */
  readonly dataModels: readonly string[];
  /** provider name → scopes that provider requires for this function. */
  readonly scopesByProvider: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Extras captured from a token response beyond the standard fields. */
export type ProviderMetadata = Record<string, string>;

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expiresInSeconds: number;
  /**
   * Provider-specific values needed for later API calls. Salesforce puts
   * `instance_url` here; without it no Salesforce request can be addressed.
   */
  metadata: ProviderMetadata;
}

/**
 * A provider authenticated by OAuth 2.0 authorization-code.
 *
 * Everything here is a hook for a provider quirk; the flow itself lives in
 * `oauth/oauth-service.ts`.
 */
export interface OAuthProviderAuth {
  readonly kind: "oauth";

  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revokeEndpoint?: string;

  /**
   * Env var names holding this provider's credentials. Held per-provider
   * rather than globally — HubSpot and Salesforce are separate OAuth apps with
   * separate client ids, and a single shared credential cannot serve both.
   */
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;

  /** Provider quirks in the authorize request live here. */
  buildAuthorizeParams(args: {
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    state: string;
  }): URLSearchParams;

  /** Normalize a token response, capturing provider-specific metadata. */
  parseTokenResponse(json: unknown): ParsedTokenResponse;
}

/**
 * A provider authenticated by a long-lived API key the user pastes in.
 *
 * There is no redirect, no consent screen, no expiry and nothing to refresh —
 * so none of the OAuth hooks above apply. Modelling this as a separate union
 * member rather than optional fields is deliberate: it makes the compiler
 * point at every place that assumed a token endpoint exists.
 */
export interface ApiKeyProviderAuth {
  readonly kind: "apiKey";

  /** Header the key travels in, e.g. "x-api-key". */
  readonly header: string;

  /** Where the user finds their key, shown above the input. */
  readonly instructions: string;

  /** Shown in the empty input, e.g. "sk_test_…". Never a real key. */
  readonly placeholder: string;

  /**
   * Cheap local shape check, so an obviously wrong paste — a whole curl
   * command, a key from another product — is rejected without a round trip.
   *
   * @returns A message explaining the rejection, or undefined to accept.
   */
  validateKeyShape(key: string): string | undefined;

  /**
   * Prove the key works before it is stored.
   *
   * Without this a bad key is not discovered until the first sync fails, which
   * reads as a broken integration rather than a typo. Must throw
   * `InvalidApiKeyError` for a key the provider rejected and any other error
   * for a transient failure: the difference decides whether the user is told to
   * fix the key or to try again.
   *
   * @returns Non-secret facts about the credential worth keeping.
   */
  probeCredential(key: string): Promise<ProviderMetadata>;
}

/**
 * How a provider proves who it is.
 *
 * Two kinds, because not every SaaS API is an OAuth app: Metrifox issues a
 * static API key and has no authorization server at all.
 */
export type ProviderAuth = OAuthProviderAuth | ApiKeyProviderAuth;

/**
 * Whether a provider's record ids mean the same thing everywhere.
 *
 * `global` — an id identifies one record across the whole provider. A Stripe
 * `cus_…` is global: whoever holds it, it names the same customer.
 *
 * `tenant` — an id is only meaningful inside one account. A HubSpot company
 * `12345` exists in every portal that has 12345 companies, and they are
 * unrelated businesses.
 *
 * This exists because identity resolution turns provider ids into match keys.
 * Treating a tenant-scoped id as global would merge two customers' companies on
 * a numeric collision, which is the worst failure the matcher can produce.
 */
export const EXTERNAL_ID_SCOPES = ["global", "tenant"] as const;

export type ExternalIdScope = (typeof EXTERNAL_ID_SCOPES)[number];

export function isExternalIdScope(v: unknown): v is ExternalIdScope {
  return (
    typeof v === "string" &&
    (EXTERNAL_ID_SCOPES as readonly string[]).includes(v)
  );
}

export interface ProviderDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;

  readonly auth: ProviderAuth;

  /**
   * How widely this provider's record ids are unique.
   *
   * Not optional, so adding a provider is a decision about this rather than an
   * omission that defaults to the unsafe answer.
   */
  readonly externalIdScope: ExternalIdScope;

  /**
   * The connected account's stable id, read from stored token metadata.
   *
   * Required for a `tenant`-scoped provider and enforced at registration.
   * Returning `undefined` means "this credential does not tell us which
   * account it belongs to", and the caller must then emit **no** identity key
   * rather than an unscoped one — losing a join is recoverable, a false merge
   * across two accounts is not.
   *
   * Must be stable for the life of the account. An instance host is not: with
   * Salesforce's legacy pod hostnames, thousands of unrelated orgs shared
   * `na1.salesforce.com`, so scoping by host would have been no scoping at all.
   */
  readonly tenantScopeValue?: (
    metadata: ProviderMetadata
  ) => string | undefined;
}

// ---------------------------------------------------------------------------
// Sync handlers
// ---------------------------------------------------------------------------

/** Credentials and context handed to a handler for one sync run. */
export interface HandlerContext {
  readonly integrationId: string;
  /** Bearer token for an OAuth provider; the raw API key for a key-based one. */
  readonly accessToken: string;
  readonly metadata: ProviderMetadata;
  /** Source paths the user mapped, so handlers can request only those fields. */
  readonly requestedSourcePaths: ReadonlyMap<TargetObject, readonly string[]>;
  /**
   * Time, injected so rate-limit waits are instant in tests. Defaults to the
   * system clock when a caller does not supply one.
   */
  readonly clock?: Clock;
  /**
   * Exchange the refresh token for a new access token, mid-run.
   *
   * A long sync can outlive its access token, and a 401 halfway through
   * pagination should refresh and continue rather than discard the pages
   * already fetched. Injected rather than imported so provider code carries no
   * dependency on the OAuth service or the database.
   *
   * Absent means refresh is impossible, and a 401 is terminal.
   */
  readonly refreshAccessToken?: () => Promise<{
    accessToken: string;
    metadata: ProviderMetadata;
  }>;
}

/** One page of source records for a given object. */
export interface SourcePage {
  readonly object: TargetObject;
  readonly records: readonly RawRecord[];
}

/**
 * A record's parent references, keyed by the object each points at.
 *
 * `Partial`, because which keys are present is a property of the object: a
 * customer has none, a contact has one, an agreement has two. An absent key and
 * an unresolvable id are different facts, and only the second produces an issue
 * on the run.
 */
export type ExternalRefs = Readonly<Partial<Record<TargetObject, string>>>;

/**
 * Provider-specific fetching. Every object streams page by page — buffering an
 * entire org before mapping buys nothing and risks exhausting memory on large
 * tenants.
 *
 * **One obligation, and it is the only place in this interface where an
 * omission destroys data rather than merely losing it.**
 *
 * > A handler that yields any `agreementItem` for an agreement must yield
 * > **all** of that agreement's items, or fail. A partial list licenses
 * > `writeAgreementItems` to delete the remainder.
 *
 * Every other object here is written by upsert, so a record a handler fails to
 * yield simply keeps its previous value — the known gap that lets a detached
 * `Feature` attachment linger. Agreement items are the exception: they are
 * reconciled, because a removed add-on that lingers makes the line list wrong
 * in a way nothing else on the row contradicts. That trade only holds while
 * "the handler yielded every line" is true, so it is stated here as a contract
 * rather than left as a property of whichever provider happened to be first.
 *
 * Meeting it is provider-specific work. Stripe inlines only the first ten
 * subscription items and sets `items.has_more` beyond that, so its handler
 * pages `/v1/subscription_items` to finish the list. A provider whose items
 * are a separate association — Salesforce `ContractLineItem`, HubSpot deal
 * line items — must page that association to exhaustion. Failing the run is
 * always the correct answer to a list that cannot be completed: a failed sync
 * costs a retry, and a successful one that deleted live lines costs the data.
 */
export interface SyncHandler {
  fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage>;
  /**
   * Provider ids of the records this one hangs off, keyed by what each is —
   * `{ customer }` for a contact, `{ product }` for an offering,
   * `{ customer, offering }` for an agreement.
   *
   * A map rather than a single id because an agreement genuinely has two
   * parents: it is an arrangement *between* a customer and something sold, and
   * neither half is the primary one. Every other record returns one key, or an
   * empty object when it is a root.
   *
   * Keyed by `TargetObject` rather than by free strings because a reference is
   * always named after the object it points at, so the compiler can reject a
   * misspelled relationship instead of the writer silently resolving nothing.
   *
   * An omitted key means the provider gave no association. The engine treats
   * that as "not linked" rather than an error, and the writer keeps the row —
   * except where the column is required, which it says for itself.
   *
   * Takes the object because one handler serves several, and what counts as a
   * parent differs between them.
   */
  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs;
  /** Provider id of a record; the upsert key. */
  externalIdOf(record: RawRecord): string | undefined;
}

/** A field offered in the mapping editor's source dropdown. */
export interface DiscoveredFieldDef {
  readonly path: string;
  readonly label: string;
  readonly type: string;
}

/** Reads a provider's schema API so users can see what they can map from. */
export interface FieldDiscovery {
  discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]>;
}
