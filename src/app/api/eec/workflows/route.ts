import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const workflows = await db.workflow.findMany({ orderBy: { code: 'asc' } })
  const runs = await db.run.findMany({
    where: { workflowId: { not: null } },
    include: {
      workflow: { select: { code: true, name: true } },
      task: { select: { code: true, title: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json({ workflows, runs })
}
