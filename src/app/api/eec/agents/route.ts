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

  const [permissions, conversations, toolInvocations, executions] = await Promise.all([
    db.permission.findMany({ where: { agentId: id } }),
    db.conversation.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 50 } },
    }),
    db.toolInvocation.findMany({ where: { agentId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    // EEC V2 §8: evidencia de ejecuciones reales (procesos) del agente
    db.executionProcess.findMany({ where: { agentId: id }, orderBy: { startedAt: 'desc' }, take: 20 }),
  ])

  // EEC V2 §8: separar lo DECLARADO (manifiesto) de lo OBSERVADO (salud real)
  let manifest: Record<string, unknown> | null = null
  let manifestError: string | null = null
  try {
    const cfg = JSON.parse(agent.providerConfigJson || '{}') as { manifest?: unknown }
    if (cfg.manifest) {
      const { validateManifest } = await import('@/lib/eec/contracts/agent-manifest')
      const v = validateManifest(cfg.manifest)
      if (v.ok && v.manifest) {
        manifest = {
          contractVersion: v.manifest.contractVersion,
          identity: v.manifest.identity,
          source: v.manifest.source,
          runtimeType: v.manifest.runtime.type,
          capabilities: v.manifest.capabilities,
          limits: v.manifest.limits,
        }
      } else {
        manifestError = v.errors.join('; ')
      }
    }
  } catch { manifestError = 'providerConfigJson ilegible' }

  const providerKind = ['local-process', 'http-agent'].includes(agent.provider)
    ? 'REAL'
    : agent.provider === 'local-sim' ? 'SIMULADO' : 'DESCONOCIDO'

  return NextResponse.json({
    agent,
    permissions,
    conversations,
    toolInvocations,
    executions,
    observability: {
      providerKind, // REAL | SIMULADO | DESCONOCIDO — nunca presentar sim como real
      manifest, // DECLARADO
      manifestError,
      declaredState: agent.state,
      observedHealth: agent.healthStatus,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      healthVerifiedAt: agent.runtimes[0]?.lastHeartbeatAt ?? null,
      runtimeStatus: agent.runtimes[0]?.status ?? 'CREATED',
    },
    metrics: {
      totalRuns: agent.runs.length,
      successfulRuns: agent.runs.filter(r => r.status === 'SUCCEEDED').length,
      failedRuns: agent.runs.filter(r => r.status === 'FAILED').length,
      unreconciledRuns: agent.runs.filter(r => r.status === 'UNRECONCILED').length,
      memories: agent.memories.length,
    },
  })
}
