import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'
import { isSimulationMode } from '@/lib/eec/commands'

export const dynamic = 'force-dynamic'

/** Snapshot completo del estado operacional (REAL STATE — la UI nunca es la fuente). */
export async function GET() {
  await ensureBoot()
  const [agents, locations, departments, tasks, runs, meetings, approvals, notifications, tools, simMode] = await Promise.all([
    db.agent.findMany({
      include: {
        department: true, office: true, location: true,
        runtimes: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { code: 'asc' },
    }),
    db.location.findMany({ orderBy: [{ x: 'asc' }, { y: 'asc' }] }),
    db.department.findMany({ include: { organization: true } }),
    db.task.findMany({
      include: { assignee: { select: { id: true, code: true, name: true, state: true } }, project: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 120,
    }),
    db.run.findMany({
      include: { task: { select: { code: true, title: true } }, workflow: { select: { code: true, name: true } }, agent: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    db.meeting.findMany({
      include: { participants: { include: { agent: { select: { id: true, code: true, name: true, state: true } } } }, location: true },
      orderBy: { scheduledStartAt: 'desc' },
      take: 30,
    }),
    db.approval.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
    db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    db.tool.findMany({ orderBy: { code: 'asc' } }),
    Promise.resolve(isSimulationMode()),
  ])

  const tasksByStatus = tasks.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc }, {})
  const agentsByState = agents.reduce<Record<string, number>>((acc, a) => { acc[a.state] = (acc[a.state] ?? 0) + 1; return acc }, {})
  const runningRuntimes = agents.flatMap(a => a.runtimes).filter(r => ['RUNNING', 'IDLE', 'READY'].includes(r.status)).length

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    simulationMode: simMode,
    health: {
      agentsTotal: agents.length,
      agentsByState,
      runtimesRunning: runningRuntimes,
      tasksByStatus,
      runsActive: runs.filter(r => ['RUNNING', 'WAITING_APPROVAL'].includes(r.status)).length,
      approvalsPending: approvals.filter(a => a.status === 'REQUESTED').length,
      meetingsActive: meetings.filter(m => ['SCHEDULED', 'INVITED', 'IN_PROGRESS'].includes(m.status)).length,
      blockedTasks: tasks.filter(t => t.status === 'BLOCKED').length,
    },
    agents, locations, departments, tasks, runs, meetings, approvals, notifications, tools,
  })
}
