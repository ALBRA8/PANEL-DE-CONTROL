import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  await ensureBoot()
  const status = req.nextUrl.searchParams.get('status')
  const tasks = await db.task.findMany({
    where: status ? { status } : undefined,
    include: {
      assignee: { select: { id: true, code: true, name: true, state: true } },
      project: { select: { code: true, name: true } },
      runs: { orderBy: { createdAt: 'desc' }, take: 3 },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return NextResponse.json({ tasks })
}
