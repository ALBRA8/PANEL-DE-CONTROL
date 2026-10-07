import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __eecDbPragmas?: Promise<void>
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * SQLite en modo WAL + busy_timeout: permite lectores concurrentes
 * (dev server + workers + tests + bridge) sin errores de lock.
 */
export async function initDbPragmas(): Promise<void> {
  if (!globalForPrisma.__eecDbPragmas) {
    globalForPrisma.__eecDbPragmas = (async () => {
      await db.$executeRawUnsafe('PRAGMA journal_mode=WAL;')
      await db.$executeRawUnsafe('PRAGMA busy_timeout=8000;')
      await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL;')
    })().catch(() => undefined)
  }
  await globalForPrisma.__eecDbPragmas
}
