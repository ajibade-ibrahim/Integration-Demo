/**
 * Domains that identify a mailbox provider rather than a company.
 *
 * This list exists to stop one specific, easy mistake. `customer.domain` wants
 * a bare host, and `src/core/providers/stripe/defaults.ts` documents that a
 * user can map Stripe's `email` through `domainFromUrl` in one click to get
 * one — which yields "gmail.com" for every consumer address. Harmless as a
 * displayed column; catastrophic as a *match key*, because it would merge every
 * unrelated consumer-email customer into a single account.
 *
 * So a blocklisted domain is never admitted as a `domain` key. Emails at these
 * domains still match perfectly well as `email` keys — it is only the
 * generalization from address to company that is refused.
 *
 * Reserved and documentation TLDs are included for the same reason: the
 * fixtures in this repo use `.example` throughout, and without this a test run
 * would cheerfully merge Acme with Northwind.
 *
 * Sorted, and asserted sorted in the tests. A list this long is only reviewable
 * if it has an order, and sortedness is the cheapest invariant that catches a
 * careless append.
 */

const FREE_EMAIL_DOMAINS = [
  "163.com",
  "aol.com",
  "att.net",
  "bellsouth.net",
  "btinternet.com",
  "comcast.net",
  "cox.net",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "fastmail.com",
  "free.fr",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.fr",
  "icloud.com",
  "invalid",
  "laposte.net",
  "libero.it",
  "live.co.uk",
  "live.com",
  "local",
  "localhost",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "orange.fr",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "rediffmail.com",
  "rocketmail.com",
  "sbcglobal.net",
  "sky.com",
  "test",
  "verizon.net",
  "web.de",
  "yahoo.co.in",
  "yahoo.co.jp",
  "yahoo.co.uk",
  "yahoo.com",
  "yahoo.fr",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
] as const;

export type FreeEmailDomain = (typeof FREE_EMAIL_DOMAINS)[number];

/** Every blocklisted domain, in sorted order. Exposed for tests and for docs. */
export const freeEmailDomains: readonly string[] = FREE_EMAIL_DOMAINS;

const lookup = new Set<string>(FREE_EMAIL_DOMAINS);

/**
 * Whether a host identifies a mailbox provider rather than a company.
 *
 * Matches the host exactly. Subdomain matching is *not* done on purpose:
 * `mail.acme.com` is Acme's own mail host, not a public provider, and treating
 * any host ending in a blocked domain as blocked would refuse it.
 *
 * @param host A normalized bare host — already trimmed and lowercased.
 */
export function isFreeEmailDomain(host: string): boolean {
  return lookup.has(host);
}
