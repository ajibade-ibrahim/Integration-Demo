/**
 * Create login accounts listed in `scripts/users.json`.
 *   npx tsx scripts/add-users.mts        # or: npm run users:add
 *
 * The file is a list of `{ email, password }` objects and is gitignored,
 * because it holds plaintext passwords. `scripts/users.example.json` is the
 * committed template — copy it, edit it, run this.
 *
 * Existing accounts are skipped, never updated. That makes the script safe to
 * re-run after adding a name to the list, and means it can never silently
 * change the password of an account someone is already signed into. Rotating a
 * password is a different job, and deliberately not this one: use
 * `DEMO_USER_PASSWORD` with `npm run seed` for the demo user.
 *
 * Nothing here prints a password. They are already sitting in the file in
 * plaintext; echoing them into a terminal buffer and CI log as well earns
 * nothing.
 */

import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'

import { hashPassword } from '../src/lib/password'

const USERS_FILE = new URL('./users.json', import.meta.url)

interface Entry {
  email: string
  password: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the parsed file into entries, or collect every problem with it.
 *
 * Reports all bad rows rather than throwing on the first, so fixing a
 * hand-edited file takes one pass instead of one run per typo.
 */
function parseEntries(raw: unknown): { entries: Entry[]; errors: string[] } {
  const errors: string[] = []

  if (!Array.isArray(raw)) {
    return {
      entries: [],
      errors: ['expected a JSON array of { email, password }'],
    }
  }

  const entries: Entry[] = []
  const seen = new Set<string>()

  raw.forEach((item, index) => {
    const at = `entry ${index}`

    if (!isRecord(item)) {
      errors.push(`${at}: expected an object`)
      return
    }

    const { email, password } = item

    if (typeof email !== 'string' || email.trim() === '') {
      errors.push(`${at}: "email" must be a non-empty string`)
      return
    }

    // The login lowercases and trims before looking a row up, so storing any
    // other casing creates an account nobody can ever sign into.
    const normalized = email.trim().toLowerCase()

    if (typeof password !== 'string' || password === '') {
      errors.push(
        `${at} (${normalized}): "password" must be a non-empty string`,
      )
      return
    }

    // A duplicate is ambiguous about which password wins, and the answer would
    // depend on list order. Refuse instead of picking one.
    if (seen.has(normalized)) {
      errors.push(`${at}: duplicate email ${normalized}`)
      return
    }

    seen.add(normalized)
    entries.push({ email: normalized, password })
  })

  return { entries, errors }
}

async function main(): Promise<void> {
  let contents: string
  try {
    contents = await readFile(USERS_FILE, 'utf8')
  } catch {
    console.error(
      'No scripts/users.json. Copy scripts/users.example.json to it and edit.',
    )
    process.exitCode = 1
    return
  }

  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error: unknown) {
    console.error(`scripts/users.json is not valid JSON: ${String(error)}`)
    process.exitCode = 1
    return
  }

  const { entries, errors } = parseEntries(raw)

  if (errors.length > 0) {
    console.error('scripts/users.json is not usable:')
    for (const error of errors) console.error(`  - ${error}`)
    process.exitCode = 1
    return
  }

  if (entries.length === 0) {
    console.log('scripts/users.json lists no users. Nothing to do.')
    return
  }

  const prisma = new PrismaClient()

  try {
    // One query for the whole list. Checking per entry would be N round trips
    // to answer a question a single `in` can answer.
    const existing = await prisma.user.findMany({
      where: { email: { in: entries.map((entry) => entry.email) } },
      select: { email: true, passwordHash: true },
    })

    const existingByEmail = new Map(existing.map((user) => [user.email, user]))

    let created = 0

    for (const entry of entries) {
      const match = existingByEmail.get(entry.email)

      if (match !== undefined) {
        // `passwordHash` is nullable and a null is a refusal, so this row
        // exists but cannot sign in. Skipping is still right — overwriting is
        // this script's one prohibition — but silence would look like success.
        const note =
          match.passwordHash === null
            ? ' (warning: no password set, so this account cannot sign in)'
            : ''
        console.log(`skip    ${entry.email}${note}`)
        continue
      }

      // Hash inside the loop rather than up front: scrypt is memory-hard by
      // design, and hashing entries that turn out to be skips wastes the one
      // resource it is deliberately expensive in.
      await prisma.user.create({
        data: {
          email: entry.email,
          passwordHash: await hashPassword(entry.password),
        },
      })

      created += 1
      console.log(`created ${entry.email}`)
    }

    console.log(`\n${created} created, ${entries.length - created} skipped.`)
  } finally {
    await prisma.$disconnect()
  }
}

await main()
