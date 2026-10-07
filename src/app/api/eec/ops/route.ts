import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'
import { providerRegistry } from '@/lib/eec/domain/contracts'
import { isSimulationMode } from '@/lib/eec/commands'

export const dynamic = 'force-dynamic'

/** Operación del sistema: providers, tools, policies, comandos, métricas, logs, dead-letters. */
export async function GET() {
  await ensureBoot()
  const [providers, tools, policies, commands, metrics, logs, deadLetters, invocations, providersDb] = await Promise.all([
    Promise.resolve(providerRegistry.list().map(p => ({
      key: `${p.type}:${p.key}`, type: p.type, providerKey: p.key, adapter: p.adapter,
      status: p.status, isDefault: p.isDefault,
    }))),
    db.tool.findMany({ orderBy: { code: 'asc' } }),
    db.policy.findMany({ orderBy: [{ type: 'asc' }, { priority: 'asc' }] }),
    db.commandRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    db.metric.findMany({ orderBy: { ts: 'desc' }, take: 120 }),
    db.logRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    db.eventRecord.findMany({ where: { status: 'DEAD_LETTER' }, orderBy: { seq: 'desc' }, take: 30 }),
    db.toolInvocation.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
    db.provider.findMany({ orderBy: { key: 'asc' } }),
  ])

  const now = Date.now()
  const recentMetrics = metrics.filter(m => now - m.ts.getTime() < 30 * 60_000)
  const gauge = (name: string) => recentMetrics.find(m => m.name === name)?.value ?? 0

  return NextResponse.json({
    providers, providersDb, tools, policies, commands, metrics: recentMetrics, logs,
    deadLetters, invocations,
    simulationMode: isSimulationMode(),
    systemHealth: {
      agentsActive: gauge('eec.gauge.agents'),
      runsRunning: gauge('eec.gauge.runs_running'),
      tasksInProgress: gauge('eec.gauge.tasks_in_progress'),
      approvalsPending: gauge('eec.gauge.approvals_pending'),
    },
  })
}
