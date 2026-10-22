// ============================================================
// EEC — HANDLERS: task.* (spec §11) con trazabilidad completa a
// PROJECT / WORKFLOW / RUN / AGENT / RUNTIME / EVENTS / AUDIT.
// task.start ensambla el Context Package (§20) y crea el RUN (§10).
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { setAgentState, setAgentActivity, setTaskState, TransitionError } from '../../engine/state'
import { writeAudit } from '../../engine/audit'
import { buildContextPackage } from '../../engine/context'
import { canTaskTransition, TaskStatus } from '../../domain/types'

export function registerTaskHandlers(): void {
  registerCommandHandler('task.create', async ({ payload, sim }) => {
    const p = payload as {
      title: string; description?: string; projectCode?: string; assigneeAgentId?: string
      priority: string; risk: string; dueAt?: string; tags: string[]; kind: string
    }
    const project = p.projectCode ? await db.project.findUnique({ where: { code: p.projectCode } }) : null
    const seq = await db.task.count() + 1
    const task = await db.task.create({
      data: {
        code: `T-${String(seq).padStart(4, '0')}`,
        title: p.title, description: p.description,
        projectId: project?.id, assigneeAgentId: p.assigneeAgentId,
        status: p.assigneeAgentId ? 'TODO' : 'INBOX',
        priority: p.priority, risk: p.risk,
        dueAt: p.dueAt ? new Date(p.dueAt) : null,
        tagsJson: JSON.stringify([...p.tags, `kind:${p.kind}`]),
      },
    })
    await eventBus.publish({
      event_type: 'task.created', source: 'eec.tasks', subject: `task:${task.id}`,
      payload: { taskId: task.id, code: task.code, title: task.title, priority: task.priority, risk: task.risk, projectId: project?.id },
      sim,
    })
    return { taskId: task.id, code: task.code, status: task.status }
  })

  registerCommandHandler('task.assign', async ({ payload, sim }) => {
    const p = payload as { taskId: string; agentId: string }
    const task = await db.task.findUnique({ where: { id: p.taskId } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    const agent = await db.agent.findUnique({ where: { id: p.agentId } })
    if (!agent) throw new Error('AGENT_NOT_FOUND')
    await db.task.update({ where: { id: task.id }, data: { assigneeAgentId: agent.id } })
    if (['INBOX', 'BACKLOG'].includes(task.status) && canTaskTransition(task.status, 'TODO')) {
      await db.task.update({ where: { id: task.id }, data: { status: 'TODO' } })
    }
    await eventBus.publish({
      event_type: 'task.assigned', source: 'eec.tasks', subject: `task:${task.id}`,
      payload: { taskId: task.id, code: task.code, agentId: agent.id, agentCode: agent.code, agentState: agent.state },
      sim,
    })
    return { taskId: task.id, agentId: agent.id }
  })

  registerCommandHandler('task.start', async ({ payload, sim }) => {
    const { taskId } = payload as { taskId: string }
    const task = await db.task.findUnique({ where: { id: taskId }, include: { assignee: true } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    if (!task.assignee) throw new Error('TASK_UNASSIGNED')
    const agent = task.assignee

    // ---- idempotencia operacional: run vivo existente → no duplicar ----
    // (doble task.start por auto-pickup + reconciliador de workflows no debe crear 2 runs)
    const activeRun = await db.run.findFirst({
      where: { taskId: task.id, status: 'RUNNING' }, orderBy: { createdAt: 'desc' },
    })
    if (activeRun) return { runId: activeRun.id, taskId: task.id, agentId: agent.id, deduped: true }

    // ---- transición de tarea TODO→IN_PROGRESS ----
    if (!canTaskTransition(task.status, 'IN_PROGRESS')) {
      throw new TransitionError('TASK', task.id, task.status, 'IN_PROGRESS')
    }

    // ---- CONTEXT ASSEMBLY (§20) ANTES de ejecutar ----
    const context = await buildContextPackage({ agentId: agent.id, taskId: task.id })

    const session = await db.session.findFirst({
      where: { agentId: agent.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' },
    })

    const run = await db.run.create({
      data: {
        sessionId: session?.id, taskId: task.id, agentId: agent.id,
        status: 'RUNNING', currentNode: 'PLAN', progress: 0,
        contextJson: JSON.stringify(context),
        startedAt: new Date(),
      },
    })
    await db.task.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS' } })
    try {
      if (agent.state === 'IDLE') {
        await setAgentState(agent.id, 'WORKING', `task.start:${task.code}`, { sim, activity: `Ejecutando: ${task.title}` })
      } else if (agent.state === 'WAITING' || agent.state === 'BLOCKED') {
        await setAgentState(agent.id, 'WORKING', `task.start:${task.code}`, { sim, activity: `Ejecutando: ${task.title}` })
      }
      await db.agent.update({ where: { id: agent.id }, data: { currentTaskId: task.id } })
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e
    }

    await eventBus.publish({
      event_type: 'run.started', source: 'eec.runs', subject: `run:${run.id}`,
      payload: { runId: run.id, taskId: task.id, agentId: agent.id, sessionId: session?.id, traceId: run.id, contextKeys: Object.keys(context) },
      sim,
    })
    await eventBus.publish({
      event_type: 'task.started', source: 'eec.tasks', subject: `task:${task.id}`,
      payload: { taskId: task.id, code: task.code, runId: run.id, agentId: agent.id }, sim,
    })
    await writeAudit({
      actorId: 'eec:tasks', actorType: 'SYSTEM', action: 'task.start',
      entityType: 'RUN', entityId: run.id, input: { taskId: task.id },
      output: { contextPackage: { identity: context.identity, tools: context.tools.length, memory: context.memory.length, knowledge: context.knowledge.length } },
      result: 'RUNNING',
    })
    return { runId: run.id, taskId: task.id, agentId: agent.id }
  })

  registerCommandHandler('task.pause', async ({ payload, sim }) => {
    const p = payload as { taskId: string; reason?: string }
    const task = await db.task.findUnique({ where: { id: p.taskId }, include: { assignee: true } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    if (task.assignee && task.assignee.state === 'WORKING') {
      await setAgentState(task.assignee.id, 'PAUSED', p.reason ?? 'task.pause', { sim, activity: `Pausado: ${task.title}` })
    }
    await eventBus.publish({ event_type: 'task.paused', source: 'eec.tasks', subject: `task:${task.id}`, payload: { taskId: task.id, reason: p.reason }, sim })
    return { taskId: task.id }
  })

  registerCommandHandler('task.resume', async ({ payload, sim }) => {
    const { taskId } = payload as { taskId: string }
    const task = await db.task.findUnique({ where: { id: taskId }, include: { assignee: true } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    if (task.assignee && task.assignee.state === 'PAUSED') {
      await setAgentState(task.assignee.id, 'WORKING', 'task.resume', { sim, activity: `Ejecutando: ${task.title}` })
    }
    await eventBus.publish({ event_type: 'task.resumed', source: 'eec.tasks', subject: `task:${task.id}`, payload: { taskId }, sim })
    return { taskId }
  })

  registerCommandHandler('task.cancel', async ({ payload, sim }) => {
    const p = payload as { taskId: string; reason?: string }
    const task = await db.task.findUnique({ where: { id: p.taskId } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    await setTaskState(task.id, 'CANCELLED', p.reason ?? 'task.cancel', sim)
    const runs = await db.run.findMany({ where: { taskId: task.id, status: { in: ['PENDING', 'RUNNING', 'WAITING_APPROVAL'] } } })
    for (const r of runs) {
      await db.run.update({ where: { id: r.id }, data: { status: 'CANCELLED', completedAt: new Date(), error: p.reason ?? 'cancelled' } })
      await eventBus.publish({ event_type: 'run.cancelled', source: 'eec.runs', subject: `run:${r.id}`, payload: { runId: r.id, taskId: task.id }, sim })
    }
    if (task.assigneeAgentId) {
      await db.agent.updateMany({ where: { id: task.assigneeAgentId, currentTaskId: task.id }, data: { currentTaskId: null } })
      const agent = await db.agent.findUnique({ where: { id: task.assigneeAgentId } })
      if (agent && ['WORKING', 'WAITING', 'BLOCKED'].includes(agent.state)) {
        await setAgentState(agent.id, 'IDLE', 'task.cancel: liberado', { sim, activity: 'Disponible' }).catch(() => undefined)
      }
    }
    await eventBus.publish({ event_type: 'task.cancelled', source: 'eec.tasks', subject: `task:${task.id}`, payload: { taskId: task.id, reason: p.reason }, sim })
    return { taskId: task.id, status: 'CANCELLED' }
  })

  registerCommandHandler('task.retry', async ({ payload, sim }) => {
    const { taskId } = payload as { taskId: string }
    const task = await db.task.findUnique({ where: { id: taskId } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    await setTaskState(task.id, 'TODO', 'task.retry', sim)
    await eventBus.publish({ event_type: 'task.retried', source: 'eec.tasks', subject: `task:${task.id}`, payload: { taskId }, sim })
    // auto-start si tiene asignado
    if (task.assigneeAgentId) {
      const { dispatchCommand } = await import('../pipeline')
      await dispatchCommand({ type: 'task.start', payload: { taskId }, requesterType: 'SYSTEM', requesterId: 'eec:retry' })
    }
    return { taskId, status: 'TODO' }
  })

  registerCommandHandler('task.complete', async ({ payload, sim }) => {
    const p = payload as { taskId: string; result: Record<string, unknown> }
    const task = await db.task.findUnique({ where: { id: p.taskId }, include: { assignee: true } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    await setTaskState(task.id, 'DONE', 'task.complete (humano)', sim, { resultJson: p.result })
    const runs = await db.run.findMany({ where: { taskId: task.id, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } } })
    for (const r of runs) {
      await db.run.update({ where: { id: r.id }, data: { status: 'SUCCEEDED', outputsJson: JSON.stringify(p.result), progress: 100, completedAt: new Date() } })
      await eventBus.publish({ event_type: 'run.succeeded', source: 'eec.runs', subject: `run:${r.id}`, payload: { runId: r.id, by: 'human' }, sim })
    }
    if (task.assignee) {
      await db.agent.updateMany({ where: { id: task.assignee.id, currentTaskId: task.id }, data: { currentTaskId: null } })
      if (task.assignee.state === 'WORKING') {
        await setAgentState(task.assignee.id, 'IDLE', 'task.complete', { sim, activity: 'Disponible' }).catch(() => undefined)
      }
    }
    await eventBus.publish({
      event_type: 'task.completed', source: 'eec.tasks', subject: `task:${task.id}`,
      payload: { taskId: task.id, code: task.code, by: 'human', result: p.result }, sim,
    })
    // un task de workflow completado por humano avanza el flujo (§21)
    if (task.workflowId) {
      const { advanceWorkflowForTask } = await import('./workflow-handlers')
      await advanceWorkflowForTask(task.workflowId, task.id, sim).catch(() => undefined)
    }
    return { taskId: task.id, status: 'DONE' }
  })

  registerCommandHandler('task.move', async ({ payload, sim }) => {
    const p = payload as { taskId: string; to: TaskStatus }
    const task = await db.task.findUnique({ where: { id: p.taskId } })
    if (!task) throw new Error('TASK_NOT_FOUND')
    await setTaskState(task.id, p.to, 'task.move (kanban)', sim)
    // consistencia operacional: al cerrar la tarea por kanban, los runs activos
    // se cierran y el agente se libera (la verdad del run nunca queda huérfana)
    if (p.to === 'DONE') {
      const runs = await db.run.findMany({ where: { taskId: task.id, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } } })
      for (const r of runs) {
        await db.run.update({ where: { id: r.id }, data: { status: 'SUCCEEDED', progress: 100, completedAt: new Date() } })
        await eventBus.publish({ event_type: 'run.succeeded', source: 'eec.tasks', subject: `run:${r.id}`, payload: { runId: r.id, by: 'kanban' }, sim })
      }
      if (task.assigneeAgentId) {
        await db.agent.updateMany({ where: { id: task.assigneeAgentId, currentTaskId: task.id }, data: { currentTaskId: null } })
        const { setAgentState } = await import('../../engine/state')
        const agent = await db.agent.findUnique({ where: { id: task.assigneeAgentId } })
        if (agent?.state === 'WORKING') {
          await setAgentState(agent.id, 'IDLE', 'task.move: tarea cerrada', { sim, activity: 'Disponible' }).catch(() => undefined)
        }
      }
    }
    return { taskId: task.id, status: p.to }
  })
}

/** Finaliza un run con outputs + evaluación (llamado por el runtime loop). */
export async function completeRunWithEvaluation(args: {
  runId: string; taskId: string; agentId: string; outputs: Record<string, unknown>;
  latencyMs: number; sim?: boolean;
}): Promise<{ verdict: string; taskStatus: string }> {
  const { completeWithEvaluationInner } = await import('./run-completion')
  return completeWithEvaluationInner(args)
}
