import { PrismaClient } from '@prisma/client'
/**
 * Seed the demo user.
 *
 * There is one account; every integration hangs off it. `DEMO_USER_EMAIL` is
 * the stable handle the app looks it up by.
 *
 * The password comes from `DEMO_USER_PASSWORD` when set. When it is not, one is
 * generated and printed once. There is deliberately no built-in default: a
 * committed password is a published password, and this seed is the only thing
 * standing between a deployment and an account anyone can sign into.
 *
 * Re-running is safe. An existing password is left alone unless
 * `DEMO_USER_PASSWORD` is set, so seeding twice does not silently lock you out
 * of the account you just signed into.
 */

import { randomBytes } from 'node:crypto'

import { hashPassword } from '../src/lib/password'

const prisma = new PrismaClient()

export const DEMO_USER_EMAIL = 'demo@integration-demo.local'

function generatedPassword(): string {
  // base64url of 12 bytes: no ambiguous characters to transcribe, and short
  // enough to retype from a terminal.
  return randomBytes(12).toString('base64url')
}

async function main(): Promise<void> {
  const supplied = process.env['DEMO_USER_PASSWORD']

  const existing = await prisma.user.findUnique({
    where: { email: DEMO_USER_EMAIL },
    select: { id: true, passwordHash: true },
  })

  let announce: string | undefined
  let passwordHash: string | undefined

  if (supplied !== undefined && supplied !== '') {
    passwordHash = await hashPassword(supplied)
    announce = '(from DEMO_USER_PASSWORD)'
  } else if (existing?.passwordHash == null) {
    const generated = generatedPassword()
    passwordHash = await hashPassword(generated)
    announce = generated
  }

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: passwordHash === undefined ? {} : { passwordHash },
    create: { email: DEMO_USER_EMAIL, passwordHash },
    select: { id: true },
  })

  console.log(`Demo user ready: ${DEMO_USER_EMAIL} (${user.id})`)

  if (announce === undefined) {
    console.log('Password unchanged. Set DEMO_USER_PASSWORD to replace it.')
  } else {
    console.log(`Password: ${announce}`)
    console.log(
      'This is not shown again — re-run with DEMO_USER_PASSWORD set to change it.',
    )
  }

  const integrations = await prisma.integration.count({
    where: { userId: user.id },
  })
  console.log(`Existing integrations: ${integrations}`)
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
