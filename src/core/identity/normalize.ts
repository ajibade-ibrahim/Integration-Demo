/**
 * Turning provider values into match keys.
 *
 * Pure, and the single definition of what counts as an email anywhere in the
 * codebase. `EMAIL_PATTERN` lives here rather than in the record writer because
 * validation and matching using two different notions of "a valid address" is a
 * bug waiting to happen: the writer would store something the matcher then
 * refuses to join on, and nothing would report an error.
 *
 * Every function here returns `undefined` for a value that cannot be a key,
 * rather than throwing. A record with an unusable address is normal input, not
 * an exceptional condition — the resolver keeps the record and simply has one
 * less piece of evidence about it.
 */

import { domainFromUrl } from "../field-mapper/transforms";
import {
  type EmailClass,
  type IdentityKeyKind,
} from "../types/common";
import { isFreeEmailDomain } from "./free-email-domains";

/**
 * Email shape check: a non-empty local part, an @, and a dotted domain.
 *
 * Deliberately permissive — the goal is catching obvious rubbish, not
 * adjudicating RFC 5322. Moved here from `sync/record-writer.ts`, which now
 * imports it.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Local parts that name a function rather than a person.
 *
 * Not a filter. These are classified so a conflict can be explained ("both
 * accounts claim billing@…"), and because the spec's own identity-table seeds
 * are billing addresses — Metrifox's fixtures are literally
 * `billing@acme.example` and `accounts@northwind.example`. Dropping role
 * addresses would discard the best evidence the connectors supply.
 */
const ROLE_LOCAL_PARTS = new Set([
  "accounting",
  "accounts",
  "accountspayable",
  "admin",
  "ap",
  "billing",
  "contact",
  "finance",
  "hello",
  "help",
  "info",
  "invoices",
  "no-reply",
  "noreply",
  "office",
  "sales",
  "support",
  "team",
]);

export interface NormalizedEmail {
  /** The match value: `<localPart>@<domain>`, normalized. */
  value: string;
  localPart: string;
  domain: string;
  emailClass: EmailClass;
}

/**
 * Classify an address by what its local part and host suggest.
 *
 * `freemail` wins over `role`: `billing@gmail.com` is a consumer mailbox
 * whatever the local part says, and the distinction that matters downstream is
 * whether the *host* generalizes to a company.
 */
export function classifyEmail(localPart: string, domain: string): EmailClass {
  if (isFreeEmailDomain(domain)) return "freemail";
  if (ROLE_LOCAL_PARTS.has(localPart)) return "role";
  return "corporate";
}

/**
 * Normalize an address into a match key.
 *
 * Plus-tags are stripped: `dana+stripe@acme.com` and `dana@acme.com` are the
 * same mailbox at effectively every provider, and the tag is very often added
 * *by* the integration being connected.
 *
 * Dots are **preserved**, deliberately. Collapsing them is a Gmail-specific
 * behaviour; applying it everywhere would merge `j.smith@` with `jsmith@` at
 * every other provider, where they are two different people. A false merge of
 * two humans is worse than a missed match.
 *
 * @returns The normalized parts, or `undefined` if this cannot be a key.
 */
export function normalizeEmail(raw: string | null): NormalizedEmail | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || !EMAIL_PATTERN.test(trimmed)) return undefined;

  // The pattern guarantees exactly one `@`, so either index would do.
  // `lastIndexOf` is used so that "the domain is whatever follows the final
  // separator" stays true if the pattern is ever loosened to admit a quoted
  // local part.
  const at = trimmed.lastIndexOf("@");
  const rawLocal = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = rawLocal.indexOf("+");
  const localPart = plus === -1 ? rawLocal : rawLocal.slice(0, plus);

  // `+tag@acme.com` passes the pattern but has nothing left once the tag goes.
  if (localPart === "") return undefined;

  return {
    value: `${localPart}@${domain}`,
    localPart,
    domain,
    emailClass: classifyEmail(localPart, domain),
  };
}

/**
 * Normalize a `customer.domain` value into a match key.
 *
 * Reuses `domainFromUrl` so host extraction has one definition, then re-checks
 * the result. That re-check is not belt-and-braces: `domainFromUrl` falls back
 * to the raw lowercased string when `URL` cannot parse its input, so the stored
 * column is not guaranteed to hold a host at all.
 *
 * A blocklisted host is refused. That is the whole defence against a user
 * mapping an email through `domainFromUrl` and merging every consumer-address
 * customer into one account.
 *
 * **Only ever call this on a mapped `customer.domain` value, never on a domain
 * extracted from an email address.** The blocklist catches `gmail.com`; it will
 * not catch a small regional ISP, so deriving company identity from an address
 * host stays out of bounds by construction rather than by vigilance.
 */
export function normalizeDomain(raw: string | null): string | undefined {
  if (raw === null) return undefined;

  const host = domainFromUrl(raw);
  if (host === null) return undefined;

  // Strip a trailing root dot ("acme.com.") before anything else looks at it.
  const bare = host.replace(/\.$/, "");

  // No dot means no registrable domain — "localhost", or the fallback having
  // returned something that was never a host.
  if (!bare.includes(".")) return undefined;
  if (isFreeEmailDomain(bare)) return undefined;

  return bare;
}

/**
 * Build the value for an `external_ref` key.
 *
 * The scope segment is what makes this safe. HubSpot object ids are
 * portal-scoped, so a bare `hubspot:12345` would merge company 12345 in one
 * portal with a different company 12345 in another. Callers must pass the
 * account scope for any provider whose ids are not globally unique, and must
 * skip the key entirely when they cannot — see `ProviderDefinition.externalIdScope`.
 */
export function externalRefValue(args: {
  providerName: string;
  /** Empty for providers whose ids are globally unique. */
  scope: string;
  externalId: string;
}): string | undefined {
  const providerName = args.providerName.trim().toLowerCase();
  const scope = args.scope.trim().toLowerCase();
  const externalId = args.externalId.trim();

  if (providerName === "" || externalId === "") return undefined;

  return `${providerName}:${scope}:${externalId}`;
}

/** Normalize a raw value for a given key kind, or `undefined` if unusable. */
export function normalizeKeyValue(
  kind: IdentityKeyKind,
  raw: string | null
): string | undefined {
  switch (kind) {
    case "email":
      return normalizeEmail(raw)?.value;
    case "domain":
      return normalizeDomain(raw);
    case "external_ref":
      // Already composed by `externalRefValue`; only casing is normalized here.
      return raw === null || raw.trim() === ""
        ? undefined
        : raw.trim().toLowerCase();
  }
}
