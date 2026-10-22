import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const cmds = await db.commandRecord.findMany({ where: { type: 'task.move' }, orderBy: { createdAt: 'desc' }, take: 3, select: { type: true, status: true, payloadJson: true, rejectionReason: true, createdAt: true } })
  console.log(JSON.stringify(cmds, null, 1))
}
main().finally(() => db.$disconnect())
