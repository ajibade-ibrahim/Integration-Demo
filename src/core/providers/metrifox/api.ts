/**
 * Metrifox REST specifics: base URL, pagination, and the flattening of nested
 * contact people into standalone records.
 *
 * Docs: https://docs.metrifox.com/api-reference/customers/get
 */

import type { RawRecord } from '../../types/common'
import { asArray, asRecord, asString } from '../http'

/** Records per page. Metrifox's own default is 25. */
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

/**
 * Runaway guard. Cursor pagination terminates when the cursor is absent, but
 * page numbers have no natural end — a provider echoing `next_page` forever
 * would page until the process died.
 */
export const METRIFOX_MAX_PAGES = 1000

/** How many customers discovery samples to find tenant-specific metadata keys. */
export const METRIFOX_DISCOVERY_SAMPLE = 25

/**
 * Base URL for the Metrifox API.
 *
 * Overridable so tests and the built-in fake can point elsewhere, exactly like
 * `hubspotApiBase()`.
 */
export function metrifoxApiBase(): string {
  const base = process.env['METRIFOX_API_BASE']
  const resolved =
    base === undefined || base === ''
      ? 'https://api-staging.metrifox.com'
      : base

  // The API key travels in a header on every one of these requests. A base
  // that is neither HTTPS nor loopback would put a live credential on the
  // wire in clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved)
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1'
  if (protocol !== 'https:' && !loopback) {
    throw new Error(
      `METRIFOX_API_BASE must use https (or localhost); got '${resolved}'`,
    )
  }
  return resolved
}

export function metrifoxPageSize(): number {
  const raw = process.env['METRIFOX_PAGE_SIZE']
  if (raw === undefined || raw === '') return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

export function customersUrl(page: number, perPage: number): string {
  // Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
  // base's own path entirely, which would silently strip the `/api/fake/...`
  // prefix the built-in fake is mounted under.
  const url = new URL(
    `${metrifoxApiBase().replace(/\/$/, '')}/api/v1/customers`,
  )
  url.searchParams.set('page', String(page))
  url.searchParams.set('per_page', String(perPage))
  return url.toString()
}

export interface MetrifoxPage {
  readonly customers: readonly RawRecord[]
  /** Next page number, or undefined on the last page. */
  readonly nextPage: number | undefined
}

/**
 * Read one customers response.
 *
 * `meta.next_page` is the provider's own end-of-data signal, the way HubSpot
 * uses the absence of `paging.next.after`. It is trusted over `total_pages`
 * because it is the field the API documents as authoritative.
 */
export function parseCustomersPage(json: unknown): MetrifoxPage {
  const body = asRecord(json)
  const data = asArray(body?.['data'])
  const meta = asRecord(body?.['meta'])

  const next = meta?.['next_page']
  return {
    customers: data.filter(
      (row): row is RawRecord => asRecord(row) !== undefined,
    ),
    nextPage: typeof next === 'number' && next > 0 ? next : undefined,
  }
}

// ---------------------------------------------------------------------------
// Contact flattening
// ---------------------------------------------------------------------------

/**
 * The stable synthetic id for one nested contact person.
 *
 * ALGORITHM v1 — changing any of this re-keys every existing Metrifox contact.
 * `Contact` is unique on `(integrationId, externalSourceId)`, so an id that
 * shifts between runs does not error: it silently inserts a duplicate person
 * and orphans the old row. That is why the array index is the last resort
 * rather than the obvious first choice — inserting one contact person would
 * renumber every contact after it.
 *
 * Prefixing with the customer id is deliberate. The same person listed under
 * two customers becomes two Contact rows, which is correct: our `Contact`
 * holds exactly one `customerId`, and the source really is asserting two
 * distinct relationships.
 *
 * @param taken Slots already used by earlier people on this same customer, so
 *   two contacts sharing an email cannot collide. The first occurrence keeps
 *   the clean id, so a later duplicate never destabilises an existing row.
 */
export function metrifoxContactExternalId(
  customerId: string,
  person: RawRecord,
  index: number,
  taken: Set<string>,
): string {
  const email = asString(person['email_address'])?.trim().toLowerCase()

  let slot: string
  if (email !== undefined && email !== '') {
    // The only field that is both usually present and genuinely identifying.
    slot = email
  } else {
    const name = [
      asString(person['first_name']),
      asString(person['last_name']),
      asString(person['designation']),
    ]
      .map((part) => part?.trim().toLowerCase() ?? '')
      .join('|')
    // Stable as long as nobody is renamed — far better than an index. A person
    // with neither email nor name is rejected downstream for a missing name
    // anyway; the index branch exists so this function is total.
    slot = name === '||' ? `#${index}` : name
  }

  const candidate = `${customerId}:${slot}`
  return taken.has(candidate) ? `${candidate}#${index}` : candidate
}

/**
 * Flatten one customer's `contact_people[]` into standalone contact records.
 *
 * The engine calls `externalIdOf(record)` with the raw record alone — it has no
 * access to the parent or the index — so the synthesized id has to be embedded
 * in the record rather than computed later.
 *
 * `full_name` is synthesized here too. `Contact.name` is required, and Metrifox
 * splits names the way HubSpot does; because we are already building the record
 * we can join it once, correctly, instead of warning users that surnames vanish.
 */
export function flattenContacts(customer: RawRecord): RawRecord[] {
  const customerId = asString(customer['id'])
  if (customerId === undefined) return []

  const people = asArray(customer['contact_people'])
  const taken = new Set<string>()
  const flattened: RawRecord[] = []

  people.forEach((entry, index) => {
    const person = asRecord(entry)
    if (person === undefined) return

    const contactId = metrifoxContactExternalId(
      customerId,
      person,
      index,
      taken,
    )
    taken.add(contactId)

    const fullName = [
      asString(person['first_name'])?.trim(),
      asString(person['last_name'])?.trim(),
    ]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ')

    flattened.push({
      ...person,
      contact_id: contactId,
      full_name: fullName,
      customer_id: customerId,
      ...(asString(customer['customer_key']) !== undefined
        ? { customer_key: customer['customer_key'] }
        : {}),
    })
  })

  return flattened
}
