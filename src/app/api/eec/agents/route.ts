import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

/** Detalle de agente: identidad, runtime, sesiones, runs, memoria, conversaciones (§39). */
export async function GET(req: NextRequest) {
  await ensureBoot()
  const id = req.nextUrl.searchParams.get('id')

  if (!id) {
    const agents = await db.agent.findMany({
      include: {
        department: true, office: true, location: true,
        runtimes: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { code: 'asc' },
    })
    return NextResponse.json({ agents })
  }

  const agent = await db.agent.findUnique({
    where: { id },
    include: {
      department: true, office: true, location: true,
      runtimes: { orderBy: { createdAt: 'desc' } },
      sessions: { orderBy: { createdAt: 'desc' }, take: 10 },
      runs: { orderBy: { createdAt: 'desc' }, take: 20, include: { task: { select: { code: true, title: true } } } },
      tasks: { orderBy: { createdAt: 'desc' }, take: 20 },
      memories: { orderBy: { createdAt: 'desc' }, take: 30 },
    },
  })
  if (!agent) return NextResponse.json({ error: 'agent_not_found' }, { status: 404 })

  const [permissions, conversations, toolInvocations] = await Promise.all([
    db.permission.findMany({ where: { agentId: id } }),
    db.conversation.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 50 } },
    }),
    db.toolInvocation.findMany({ where: { agentId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  return NextResponse.json({
    agent,
    permissions,
    conversations,
    toolInvocations,
    metrics: {
      totalRuns: agent.runs.length,
      successfulRuns: agent.runs.filter(r => r.status === 'SUCCEEDED').length,
      failedRuns: agent.runs.filter(r => r.status === 'FAILED').length,
      memories: agent.memories.length,
    },
  })
}
