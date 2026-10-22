import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const t = await db.task.findUnique({ where: { code: 'T-0003' }, select: { id: true, status: true } })
  const cmds = await db.commandRecord.findMany({ where: { payloadJson: { contains: t!.id } }, orderBy: { createdAt: 'desc' }, take: 5, select: { type: true, status: true, payloadJson: true, createdAt: true } })
  console.log('task:', JSON.stringify(t))
  console.log(JSON.stringify(cmds))
}
main().finally(() => db.$disconnect())
