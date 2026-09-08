import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Next dev-mode hot reload re-evaluates modules on every edit, which would
 * otherwise leak a new connection pool per reload until SQLite starts refusing
 * handles. Stashing the client on globalThis survives reload; production gets a
 * plain instance.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
