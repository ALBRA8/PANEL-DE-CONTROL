// ============================================================
// EEC — ENGINE WORKERS (spec §11, §21, §22, §35, §42, §45)
// - RuntimeLoop: hace avanzar runs reales vía AgentInterface (adapter).
//   Los agentes IDLE con tarea asignada la toman (auto-pickup honesto).
// - HeartbeatMonitor: latidos de runtime; timeouts → UNHEALTHY → CRASHED.
// - SchedulerRunner: ONE_TIME / RECURRING(cron) / EVENT / DEPENDENCY.
// - ApprovalExpiry: expiración de aprobaciones (§24).
// - NotificationRouter: eventos → notificaciones según políticas (§42).
// ============================================================
import { db } from '../../../lib/db'
import { eventBus } from '../events/bus'
import { dispatchCommand, isSimulationMode } from '../commands/pipeline'
import { completeRunWithEvaluation } from '../commands/handlers/task-handlers'
import { eecAls, newTrace, withTrace, recordMetric, log } from './observability'
import type { AgentInterface, NotificationInterface } from '../domain/contracts'

interface WorkerHandle { timer: NodeJS.Timeout; name: string }
const globalForWorkers = globalThis as unknown as {
  __eecWorkers?: WorkerHandle[]
  __eecTick?: number
  __eecEventSubscribed?: boolean
}

// ---------------- RUNTIME LOOP ----------------
async function runtimeLoopTick(): Promise<void> {
  const sim = isSimulationMode()
  const workingAgents = await db.agent.findMany({
    where: { state: 'WORKING', currentTaskId: { not: null } },
    include: { runtimes: true },
  })

  for (const agent of workingAgents) {
    const run = await db.run.findFirst({
      where: { agentId: agent.id, taskId: agent.currentTaskId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    })
    if (!run) {
      // run perdido: liberar al agente de forma honesta
      await db.agent.update({ where: { id: agent.id }, data: { currentTaskId: null } }).catch(() => undefined)
      await withTrace(newTrace({ sim }), async () => {
        const { setAgentState } = await import('./state')
        await setAgentState(agent.id, 'IDLE', 'runtime loop: run no encontrado', { sim, activity: 'Disponible' }).catch(() => undefined)
      })
      continue
    }
    // runtime del agente debe estar operativo; si no, el run espera (no se fabrica progreso)
    const rt = agent.runtimes.find(r => ['RUNNING', 'IDLE', 'READY'].includes(r.status))
    if (!rt) continue

    // agente pausado → no avanzar (sin fabricar actividad)
    if (agent.state !== 'WORKING') continue

    const startedAt = run.startedAt ?? run.createdAt
    const latencyMs = Date.now() - startedAt.getTime()

    await withTrace(newTrace({ sim, traceId: run.id, correlationId: run.id }), async () => {
      try {
        const { providerRegistry } = await import('../domain/contracts')
        const agentAdapter = providerRegistry.get<AgentInterface>('AGENT', agent.provider)
        const context = JSON.parse(run.contextJson || '{}')
        const result = await agentAdapter.tick({
          runId: run.id, agentId: agent.id, agentCode: agent.code,
          taskId: run.taskId, currentNode: run.currentNode, progress: run.progress,
          context, traceId: run.id, simulation: sim,
        })
        await db.run.update({
          where: { id: run.id },
          data: {
            progress: result.progress,
            currentNode: result.currentNode ?? run.currentNode,
            ...(result.outputs && Object.keys(result.outputs).length > 0 ? { outputsJson: JSON.stringify({ ...JSON.parse(run.outputsJson || '{}'), ...result.outputs }) } : {}),
          },
        })
        if (result.activity) {
          await db.agent.update({ where: { id: agent.id }, data: { activity: result.activity } })
        }
        if (result.done) {
          const outputs = { ...JSON.parse(run.outputsJson || '{}'), ...(result.outputs ?? {}) }
          if (result.error) {
            await db.run.update({ where: { id: run.id }, data: { status: 'FAILED', error: result.error, completedAt: new Date() } })
            await eventBus.publish({ event_type: 'run.failed', source: 'eec.runtime-loop', subject: `run:${run.id}`, payload: { runId: run.id, error: result.error }, sim })
          } else {
            await completeRunWithEvaluation({
              runId: run.id, taskId: run.taskId!, agentId: agent.id,
              outputs, latencyMs, sim,
            })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('EEC_PROVIDER_UNAVAILABLE')) {
          await log('WARN', `provider de agente no disponible: ${agent.provider}`, { agentId: agent.id })
          return
        }
        await db.run.update({ where: { id: run.id }, data: { status: 'FAILED', error: msg.slice(0, 300), completedAt: new Date() } }).catch(() => undefined)
        await eventBus.publish({ event_type: 'run.failed', source: 'eec.runtime-loop', subject: `run:${run.id}`, payload: { runId: run.id, error: msg.slice(0, 200) }, sim })
        const { setAgentState } = await import('./state')
        await setAgentState(agent.id, 'IDLE', 'run.error', { sim, activity: 'Disponible' }).catch(() => undefined)
      }
    })
  }

  // ---- auto-pickup: tareas TODO asignadas a agentes IDLE con runtime vivo ----
  const idleAgents = await db.agent.findMany({
    where: { state: 'IDLE', currentTaskId: null },
    include: { runtimes: true },
  })
  for (const agent of idleAgents) {
    if (!agent.runtimes.some(r => ['RUNNING', 'READY', 'IDLE'].includes(r.status))) continue
    const pending = await db.task.findFirst({
      where: { assigneeAgentId: agent.id, status: 'TODO' },
      orderBy: { priority: 'asc' },
    })
    if (pending) {
      await dispatchCommand({
        type: 'task.start', payload: { taskId: pending.id },
        requesterType: 'SYSTEM', requesterId: 'eec:auto-pickup',
        idempotencyKey: `auto-start:${pending.id}`,
      })
    }
  }

  // ---- heartbeats de runtimes vivos (liveness honesta) ----
  const alive = await db.agentRuntime.findMany({ where: { status: { in: ['RUNNING', 'IDLE', 'READY'] } } })
  const tick = (globalForWorkers.__eecTick = (globalForWorkers.__eecTick ?? 0) + 1)
  for (const rt of alive) {
    await db.agentRuntime.update({ where: { id: rt.id }, data: { lastHeartbeatAt: new Date() } }).catch(() => undefined)
    await db.agent.updateMany({ where: { id: rt.agentId, healthStatus: { not: 'HEALTHY' } }, data: { healthStatus: 'HEALTHY', lastHeartbeatAt: new Date() } }).catch(() => undefined)
  }
  if (tick % 6 === 0) {
    for (const rt of alive) {
      await eventBus.publish({
        event_type: 'runtime.heartbeat', source: 'eec.runtime-loop', subject: `runtime:${rt.id}`,
        payload: { runtimeId: rt.id, agentId: rt.agentId, at: new Date().toISOString() }, sim,
      }).catch(() => undefined)
    }
  }

  // ---- reconciliación periódica de workflows: nodos huérfanos + depencias completadas ----
  if (tick % 4 === 0) {
    try {
      const { advanceWorkflowRun } = await import('../commands/handlers/workflow-handlers')
      const wfRuns = await db.run.findMany({ where: { workflowId: { not: null }, status: 'RUNNING' }, take: 8, orderBy: { createdAt: 'asc' } })
      for (const wr of wfRuns) {
        await advanceWorkflowRun(wr.id, sim).catch(() => undefined)
      }
    } catch { /* reconciliación best-effort */ }
  }
}

// ---------------- HEARTBEAT MONITOR (§45) ----------------
async function heartbeatMonitorTick(): Promise<void> {
  const now = Date.now()
  const stale = await db.agentRuntime.findMany({ where: { status: { in: ['RUNNING', 'IDLE', 'READY'] } } })
  for (const rt of stale) {
    const last = rt.lastHeartbeatAt?.getTime() ?? 0
    if (now - last > 45_000) {
      await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'CRASHED', health: 'CRASHED' } }).catch(() => undefined)
      await eventBus.publish({
        event_type: 'runtime.crashed', source: 'eec.heartbeat', subject: `runtime:${rt.id}`,
        payload: { runtimeId: rt.id, agentId: rt.agentId, reason: 'heartbeat timeout' }, sim: false,
      }).catch(() => undefined)
    } else if (now - last > 25_000) {
      if (['RUNNING', 'IDLE', 'READY'].includes(rt.status)) {
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'UNHEALTHY', health: 'UNHEALTHY' } }).catch(() => undefined)
        await eventBus.publish({
          event_type: 'runtime.unhealthy', source: 'eec.heartbeat', subject: `runtime:${rt.id}`,
          payload: { runtimeId: rt.id, agentId: rt.agentId }, sim: false,
        }).catch(() => undefined)
      }
    }
  }
}

// ---------------- SCHEDULER (§22) ----------------
function cronMatches(cron: string, d: Date): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts
  const match = (field: string, value: number, minV: number, maxV: number): boolean => {
    if (field === '*') return true
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10)
      return (value - minV) % step === 0
    }
    return field.split(',').some(f => parseInt(f, 10) === value)
  }
  const jf = (f: string, v: number, mn: number, mx: number) => match(f, v, mn, mx)
  return jf(min, d.getMinutes(), 0, 59) && jf(hour, d.getHours(), 0, 23) &&
    (dom === '*' || jf(dom, d.getDate(), 1, 31)) && (mon === '*' || jf(mon, d.getMonth() + 1, 1, 12)) &&
    (dow === '*' || jf(dow, d.getDay(), 0, 6))
}

async function schedulerTick(): Promise<void> {
  const now = new Date()
  const schedules = await db.schedule.findMany({ where: { enabled: true } })
  for (const s of schedules) {
    let due = false
    if (s.kind === 'ONE_TIME') {
      due = !!s.nextRunAt && s.nextRunAt <= now
    } else if (s.kind === 'RECURRING') {
      const from = s.lastRunAt ?? new Date(now.getTime() - 120_000)
      // ¿hubo un minuto de match entre lastRunAt y ahora? (ventana acotada)
      const cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000)
      let steps = 0
      while (cursor <= now && steps < 90) {
        if (cronMatches(s.expression, cursor)) { due = true; break }
        cursor.setMinutes(cursor.getMinutes() + 1)
        steps++
      }
    } else if (s.kind === 'DEPENDENCY_TRIGGERED' && s.dependsOnJson) {
      try {
        const dep = JSON.parse(s.dependsOnJson) as { taskId: string; status: string }
        const t = await db.task.findUnique({ where: { id: dep.taskId } })
        due = t?.status === dep.status
      } catch { /* noop */ }
    }
    if (!due) continue
    await withTrace(newTrace({ sim: isSimulationMode() }), async () => {
      await eventBus.publish({
        event_type: 'system.schedule.fired', source: 'eec.scheduler', subject: `schedule:${s.id}`,
        payload: { scheduleId: s.id, name: s.name, commandType: s.commandType },
      })
      await dispatchCommand({
        type: s.commandType,
        payload: JSON.parse(s.commandPayloadJson || '{}'),
        requesterType: 'SYSTEM', requesterId: 'eec:scheduler',
        idempotencyKey: `sched:${s.id}:${s.lastRunAt?.toISOString() ?? 'never'}`,
      })
    })
    await db.schedule.update({
      where: { id: s.id },
      data: {
        lastRunAt: now,
        nextRunAt: s.kind === 'ONE_TIME' ? null : new Date(now.getTime() + 60_000),
        enabled: s.kind === 'ONE_TIME' ? false : s.enabled,
      },
    }).catch(() => undefined)
  }
}

// ---------------- APPROVAL EXPIRY (§24) ----------------
async function approvalExpiryTick(): Promise<void> {
  const expired = await db.approval.findMany({
    where: { status: 'REQUESTED', expiresAt: { lt: new Date() } },
    take: 20,
  })
  for (const a of expired) {
    await db.approval.update({ where: { id: a.id }, data: { status: 'EXPIRED', decidedAt: new Date() } })
    await eventBus.publish({
      event_type: 'approval.expired', source: 'eec.approvals', subject: `approval:${a.id}`,
      payload: { approvalId: a.id, title: a.title },
    })
    if (a.subjectType === 'COMMAND' && a.subjectId) {
      await db.commandRecord.update({
        where: { id: a.subjectId }, data: { status: 'REJECTED', rejectionReason: 'approval_expired' },
      }).catch(() => undefined)
    }
  }
}

// ---------------- NOTIFICATION ROUTER (§42) ----------------
function subscribeNotificationRouter(): void {
  if (globalForWorkers.__eecEventSubscribed) return
  globalForWorkers.__eecEventSubscribed = true

  const RULES: Record<string, { severity: string; title: (p: Record<string, unknown>) => string; channels?: string[] }> = {
    'agent.error': { severity: 'ERROR', title: p => `Agente en ERROR: ${String(p.agentCode ?? p.agentId)}` },
    'runtime.crashed': { severity: 'CRITICAL', title: p => `Runtime CRASHED: ${String(p.runtimeId)}` },
    'runtime.unhealthy': { severity: 'WARNING', title: p => `Runtime UNHEALTHY: ${String(p.runtimeId)}` },
    'approval.requested': { severity: 'WARNING', title: p => `Aprobación requerida: ${String(p.title ?? p.approvalId)}` },
    'task.failed': { severity: 'ERROR', title: p => `Tarea fallida: ${String(p.taskId)}` },
    'workflow.failed': { severity: 'ERROR', title: p => `Workflow fallido: run ${String(p.runId)}` },
    'meeting.started': { severity: 'INFO', title: p => `Reunión iniciada: ${String(p.code ?? '')}` },
    'system.schedule.fired': { severity: 'INFO', title: p => `Schedule disparado: ${String(p.name ?? '')}` },
    'system.permission.denied': { severity: 'WARNING', title: p => `Permiso denegado: ${String(p.commandType)}` },
    'system.policy.denied': { severity: 'WARNING', title: p => `Política denegó comando: ${String(p.commandType)}` },
    'client.stage.changed': { severity: 'INFO', title: p => `CRM: ${String(p.name ?? '')} → ${String(p.to)}` },
  }

  eventBus.subscribe('*', async (event) => {
    const rule = RULES[event.event_type]
    if (!rule) return
    // canales configurables por política de notificación (§42)
    const pol = await db.policy.findFirst({
      where: { enabled: true, type: 'NOTIFICATION', actionJson: { contains: event.event_type } },
    }).catch(() => null)
    const channels = pol ? safeChannels(pol.conditionsJson) : (rule.channels ?? ['UI'])
    if (channels.length === 0) return
    await db.notification.create({
      data: {
        type: event.event_type, severity: rule.severity,
        title: rule.title(event.payload),
        body: JSON.stringify(event.payload).slice(0, 300),
        channelsJson: JSON.stringify(channels),
        subjectType: event.subject.split(':')[0],
        subjectId: event.subject.split(':')[1],
        sim: event.sim ?? false,
      },
    }).catch(() => undefined)
    // provider de notificación externo (email/webhook) vía adapter si existe
    try {
      const { providerRegistry } = await import('../domain/contracts')
      const notif = providerRegistry.get<NotificationInterface>('NOTIFICATION')
      await notif.send({ title: rule.title(event.payload), body: JSON.stringify(event.payload).slice(0, 200), severity: rule.severity, channels })
    } catch { /* sin provider externo registrado: solo UI */ }
  })
}

function safeChannels(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : (v.channels ?? ['UI'])
  } catch { return ['UI'] }
}

// ---------------- MANAGER ----------------
export function startWorkers(): void {
  if (globalForWorkers.__eecWorkers && globalForWorkers.__eecWorkers.length > 0) return
  const handles: WorkerHandle[] = []
  const every = (ms: number, name: string, fn: () => Promise<void>) => {
    const timer = setInterval(() => {
      void eecAls.run(newTrace(), async () => {
        try { await fn() } catch (err) {
          console.error(`[EEC-WORKER:${name}]`, err instanceof Error ? err.message : err)
        }
      })
    }, ms)
    timer.unref?.()
    handles.push({ timer, name })
  }
  every(2500, 'runtime-loop', runtimeLoopTick)
  every(10_000, 'heartbeat-monitor', heartbeatMonitorTick)
  every(5000, 'scheduler', schedulerTick)
  every(30_000, 'approval-expiry', approvalExpiryTick)
  every(60_000, 'metrics-flush', async () => {
    const [agents, running, tasks, approvals] = await Promise.all([
      db.agent.count(), db.run.count({ where: { status: 'RUNNING' } }),
      db.task.count({ where: { status: 'IN_PROGRESS' } }),
      db.approval.count({ where: { status: 'REQUESTED' } }),
    ])
    await recordMetric('eec.gauge.agents', agents)
    await recordMetric('eec.gauge.runs_running', running)
    await recordMetric('eec.gauge.tasks_in_progress', tasks)
    await recordMetric('eec.gauge.approvals_pending', approvals)
  })
  subscribeNotificationRouter()
  globalForWorkers.__eecWorkers = handles
  console.log(`[EEC] workers iniciados: ${handles.map(h => h.name).join(', ')}`)
}

export function stopWorkers(): void {
  for (const h of globalForWorkers.__eecWorkers ?? []) clearInterval(h.timer)
  globalForWorkers.__eecWorkers = []
}

/** Tick determinista para tests/aceptación: ejecuta una pasada de cada worker. */
export async function runTicksOnce(): Promise<void> {
  await runtimeLoopTick()
  await schedulerTick()
  await approvalExpiryTick()
}
