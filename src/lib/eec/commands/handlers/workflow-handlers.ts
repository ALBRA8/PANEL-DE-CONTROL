// ============================================================
// EEC — WORKFLOW ENGINE (spec §21): workflows versionados.
// El workflow CONTROLA la orquestación pero nunca salta el gateway
// de tools ni los permisos. Nodos: TASK | APPROVAL | CONDITION.
// El estado de nodos vive en run.contextJson.nodes (source of truth).
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { writeAudit } from '../../engine/audit'
import { canRuntimeTransition } from '../../domain/types'

export interface WorkflowNode {
  id: string
  name: string
  kind: 'TASK' | 'APPROVAL' | 'CONDITION'
  taskKind?: string
  title?: string
  description?: string
  agentRole?: string
  risk?: string
  priority?: string
  approvalType?: string
  dependsOn: string[]
}

interface WfState {
  nodes: Record<string, { status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'; taskId?: string; approvalId?: string; error?: string }>
}

function parseNodes(definitionJson: string): WorkflowNode[] {
  try {
    const def = JSON.parse(definitionJson || '{}')
    return def.nodes ?? []
  } catch { return [] }
}

function parseState(contextJson: string): WfState {
  try {
    const ctx = JSON.parse(contextJson || '{}')
    if (ctx.wfNodes) return { nodes: ctx.wfNodes }
  } catch { /* noop */ }
  return { nodes: {} }
}

async function saveState(runId: string, state: WfState): Promise<void> {
  const run = await db.run.findUnique({ where: { id: runId } })
  const ctx = run ? JSON.parse(run.contextJson || '{}') : {}
  ctx.wfNodes = state.nodes
  await db.run.update({ where: { id: runId }, data: { contextJson: JSON.stringify(ctx) } })
}

/** Elige un agente IDLE con runtime RUNNING para el rol; fallback: cualquier IDLE. */
async function pickAgent(role?: string): Promise<{ id: string } | null> {
  const candidates = await db.agent.findMany({
    where: { state: 'IDLE', ...(role ? { role: { contains: role } } : {}) },
    include: { runtimes: true },
  })
  const ready = candidates.filter(a => a.runtimes.some(rt => ['RUNNING', 'IDLE', 'READY'].includes(rt.status)))
  if (ready.length > 0) return { id: ready[0].id }
  const anyIdle = await db.agent.findFirst({ where: { state: 'IDLE' } })
  return anyIdle ? { id: anyIdle.id } : null
}

/** Lanza los nodos listos (deps DONE) de un run de workflow. */
export async function advanceWorkflowRun(runId: string, sim?: boolean): Promise<'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'WAITING'> {
  const run = await db.run.findUnique({ where: { id: runId } })
  if (!run || !run.workflowId || !['RUNNING', 'WAITING_APPROVAL'].includes(run.status)) return 'RUNNING'
  const workflow = await db.workflow.findUnique({ where: { id: run.workflowId } })
  if (!workflow) return 'RUNNING'
  const nodes = parseNodes(workflow.definitionJson)
  const state = parseState(run.contextJson)
  for (const n of nodes) if (!state.nodes[n.id]) state.nodes[n.id] = { status: 'PENDING' }

  const { dispatchCommand } = await import('../pipeline')
  let launched = false

  for (const node of nodes) {
    const st = state.nodes[node.id]
    // ---- reconciliación: nodo RUNNING con tarea que nunca arrancó (no había agente) ----
    if (st.status === 'RUNNING' && st.taskId) {
      const nt = await db.task.findUnique({ where: { id: st.taskId } })
      if (!nt) {
        state.nodes[node.id] = { status: 'PENDING' }
      } else if (nt.status === 'DONE') {
        // tarea cerrada por humano (task.complete/kanban) → nodo completado
        state.nodes[node.id] = { status: 'DONE', taskId: st.taskId }
      } else if (['INBOX', 'BACKLOG', 'TODO'].includes(nt.status)) {
        let assignee = nt.assigneeAgentId
        if (!assignee) {
          const a = await pickAgent(node.agentRole)
          if (a) {
            assignee = a.id
            await db.task.update({ where: { id: nt.id }, data: { assigneeAgentId: a.id, status: 'TODO' } })
            await dispatchCommand({ type: 'task.assign', payload: { taskId: nt.id, agentId: a.id }, requesterType: 'SYSTEM', requesterId: `workflow:${workflow.code}` })
          }
        }
        if (assignee) {
          const holder = await db.agent.findUnique({ where: { id: assignee } })
          if (holder?.state === 'IDLE') {
            await dispatchCommand({ type: 'task.start', payload: { taskId: nt.id }, requesterType: 'SYSTEM', requesterId: `workflow:${workflow.code}` })
            launched = true
          }
        }
      }
    }
    if (st.status !== 'PENDING') continue
    const depsDone = node.dependsOn.every(d => ['DONE', 'SKIPPED'].includes(state.nodes[d]?.status ?? 'PENDING'))
    if (!depsDone) continue
    const depFailed = node.dependsOn.some(d => state.nodes[d]?.status === 'FAILED')
    if (depFailed) {
      state.nodes[node.id] = { status: 'SKIPPED' }
      continue
    }

    if (node.kind === 'TASK') {
      const agent = await pickAgent(node.agentRole)
      // Si no hay agente disponible, el nodo queda PENDIENTE y se reintenta
      // en el siguiente avance (nunca se marca RUNNING sin ejecución real).
      if (!agent) continue
      state.nodes[node.id] = { status: 'RUNNING' }
      const created = await dispatchCommand({
        type: 'task.create',
        requesterType: 'SYSTEM', requesterId: `workflow:${workflow.code}`,
        payload: {
          title: node.title ?? node.name,
          description: node.description ?? `Nodo ${node.id} del workflow ${workflow.name}`,
          projectCode: safeProject(run.contextJson),
          assigneeAgentId: agent?.id,
          risk: node.risk ?? 'LOW',
          priority: node.priority ?? 'MEDIUM',
          kind: node.taskKind ?? 'generic',
          tags: [`workflow:${workflow.code}`, `node:${node.id}`],
        },
      })
      if (created.ok && created.result?.taskId) {
        const nodeTaskId = String(created.result.taskId)
        // trazabilidad tarea ↔ workflow (imprescindible para avanzar el flujo)
        await db.task.update({
          where: { id: nodeTaskId },
          data: { workflowId: workflow.id, workflowNode: node.id },
        }).catch(() => undefined)
        state.nodes[node.id].taskId = nodeTaskId
        launched = true
        await dispatchCommand({ type: 'task.start', payload: { taskId: nodeTaskId }, requesterType: 'SYSTEM', requesterId: `workflow:${workflow.code}` })
      } else {
        state.nodes[node.id] = { status: 'FAILED', error: created.error }
      }
    }

    if (node.kind === 'APPROVAL') {
      const res = await dispatchCommand({
        type: 'approval.request',
        requesterType: 'SYSTEM', requesterId: `workflow:${workflow.code}`,
        payload: {
          requestType: 'WORKFLOW_NODE',
          title: node.title ?? `Aprobación: ${node.name}`,
          description: node.description ?? `Nodo ${node.id} del workflow ${workflow.name} requiere aprobación.`,
          subjectType: 'WORKFLOW_RUN', subjectId: run.id, nodeId: node.id,
          risk: node.risk ?? 'HIGH',
          payload: { workflowId: workflow.id, runId: run.id, nodeId: node.id },
        },
      })
      state.nodes[node.id] = { status: 'RUNNING', approvalId: res.approvalId }
      launched = true
    }
  }

  const allDone = nodes.every(n => ['DONE', 'SKIPPED'].includes(state.nodes[n.id]?.status ?? 'PENDING'))
  const anyFailed = nodes.some(n => state.nodes[n.id]?.status === 'FAILED')
  const waiting = nodes.some(n => state.nodes[n.id]?.status === 'RUNNING')

  if (allDone) {
    await db.run.update({ where: { id: runId }, data: { status: 'SUCCEEDED', progress: 100, completedAt: new Date() } })
    await eventBus.publish({ event_type: 'workflow.completed', source: 'eec.workflows', subject: `workflow:${workflow.id}`, payload: { workflowId: workflow.id, runId }, sim })
    await writeAudit({ actorId: 'eec:workflows', actorType: 'SYSTEM', action: 'workflow.completed', entityType: 'RUN', entityId: runId, result: 'SUCCEEDED' })
    await saveState(runId, state)
    return 'SUCCEEDED'
  }
  if (anyFailed && !launched) {
    await db.run.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), error: 'nodo fallido' } })
    await eventBus.publish({ event_type: 'workflow.failed', source: 'eec.workflows', subject: `workflow:${workflow.id}`, payload: { workflowId: workflow.id, runId }, sim })
    await saveState(runId, state)
    return 'FAILED'
  }
  await db.run.update({ where: { id: runId }, data: { status: waiting || launched ? 'RUNNING' : run.status, currentNode: nodes.find(n => state.nodes[n.id]?.status === 'RUNNING')?.id ?? run.currentNode } })
  await saveState(runId, state)
  if (launched) {
    await eventBus.publish({ event_type: 'workflow.node.launched', source: 'eec.workflows', subject: `workflow:${workflow.id}`, payload: { runId }, sim })
  }
  return waiting || launched ? 'RUNNING' : 'WAITING'
}

function safeProject(contextJson: string): string | undefined {
  try { return JSON.parse(contextJson || '{}').projectCode } catch { return undefined }
}

/** Llamado cuando una tarea de workflow termina (desde run-completion). */
export async function advanceWorkflowForTask(workflowId: string, taskId: string, sim?: boolean): Promise<void> {
  const run = await db.run.findFirst({
    where: { workflowId, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!run) return
  const state = parseState(run.contextJson)
  for (const [nodeId, st] of Object.entries(state.nodes)) {
    if (st.taskId === taskId && st.status === 'RUNNING') {
      const task = await db.task.findUnique({ where: { id: taskId } })
      state.nodes[nodeId] = { status: task?.status === 'DONE' ? 'DONE' : 'FAILED', taskId }
    }
  }
  await saveState(run.id, state)
  await advanceWorkflowRun(run.id, sim)
}

export function registerWorkflowHandlers(): void {
  registerCommandHandler('workflow.start', async ({ payload, sim }) => {
    const p = payload as { workflowId?: string; code?: string; context: Record<string, unknown> }
    const workflow = p.workflowId
      ? await db.workflow.findUnique({ where: { id: p.workflowId } })
      : await db.workflow.findUnique({ where: { code: p.code! } })
    if (!workflow) throw new Error('WORKFLOW_NOT_FOUND')
    if (workflow.status !== 'ACTIVE') throw new Error(`WORKFLOW_NOT_ACTIVE:${workflow.status}`)
    const nodes = parseNodes(workflow.definitionJson)
    if (nodes.length === 0) throw new Error('WORKFLOW_EMPTY')

    const run = await db.run.create({
      data: {
        workflowId: workflow.id, status: 'RUNNING', currentNode: nodes[0].id,
        contextJson: JSON.stringify({ ...p.context, projectCode: p.context.projectCode }),
        startedAt: new Date(),
      },
    })
    await eventBus.publish({
      event_type: 'workflow.started', source: 'eec.workflows', subject: `workflow:${workflow.id}`,
      payload: { workflowId: workflow.id, code: workflow.code, runId: run.id, nodes: nodes.map(n => n.id) }, sim,
    })
    await writeAudit({ actorId: 'eec:workflows', actorType: 'SYSTEM', action: 'workflow.start', entityType: 'RUN', entityId: run.id, input: { code: workflow.code }, result: 'RUNNING' })
    const outcome = await advanceWorkflowRun(run.id, sim)
    return { runId: run.id, workflowId: workflow.id, outcome }
  })

  registerCommandHandler('workflow.pause', async ({ payload, sim }) => {
    const { runId } = payload as { runId: string }
    const run = await db.run.findUnique({ where: { id: runId } })
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (!canRuntimeTransition('RUNNING', 'IDLE')) throw new Error('BAD_TRANSITION')
    // pausa lógica: detiene el lanzamiento de nuevos nodos
    await db.run.update({ where: { id: runId }, data: { currentNode: `PAUSED@${run.currentNode ?? ''}` } })
    await eventBus.publish({ event_type: 'workflow.paused', source: 'eec.workflows', subject: `workflow:${run.workflowId}`, payload: { runId }, sim })
    return { runId }
  })

  registerCommandHandler('workflow.resume', async ({ payload, sim }) => {
    const { runId } = payload as { runId: string }
    const run = await db.run.findUnique({ where: { id: runId } })
    if (!run) throw new Error('RUN_NOT_FOUND')
    await db.run.update({ where: { id: runId }, data: { currentNode: (run.currentNode ?? '').replace(/^PAUSED@/, '') } })
    const outcome = await advanceWorkflowRun(runId, sim)
    await eventBus.publish({ event_type: 'workflow.resumed', source: 'eec.workflows', subject: `workflow:${run.workflowId}`, payload: { runId, outcome }, sim })
    return { runId, outcome }
  })

  registerCommandHandler('workflow.cancel', async ({ payload, sim }) => {
    const p = payload as { runId: string; reason?: string }
    const run = await db.run.findUnique({ where: { id: p.runId } })
    if (!run) throw new Error('RUN_NOT_FOUND')
    const state = parseState(run.contextJson)
    const { dispatchCommand } = await import('../pipeline')
    for (const [, st] of Object.entries(state.nodes)) {
      if (st.status === 'RUNNING' && st.taskId) {
        await dispatchCommand({ type: 'task.cancel', payload: { taskId: st.taskId, reason: 'workflow cancelado' }, requesterType: 'SYSTEM' })
      }
      if (st.status === 'RUNNING' && st.approvalId) {
        await dispatchCommand({ type: 'approval.cancel', payload: { approvalId: st.approvalId, note: 'workflow cancelado' }, requesterType: 'SYSTEM' })
      }
    }
    await db.run.update({ where: { id: p.runId }, data: { status: 'CANCELLED', completedAt: new Date(), error: p.reason ?? 'cancelled' } })
    await eventBus.publish({ event_type: 'workflow.cancelled', source: 'eec.workflows', subject: `workflow:${run.workflowId}`, payload: { runId: p.runId, reason: p.reason }, sim })
    return { runId: p.runId, status: 'CANCELLED' }
  })

  registerCommandHandler('workflow.retry', async ({ payload, sim }) => {
    const { runId } = payload as { runId: string }
    const run = await db.run.findUnique({ where: { id: runId } })
    if (!run || !run.workflowId) throw new Error('RUN_NOT_FOUND')
    await db.run.update({ where: { id: runId }, data: { status: 'RUNNING', error: null } })
    const outcome = await advanceWorkflowRun(runId, sim)
    await eventBus.publish({ event_type: 'workflow.retried', source: 'eec.workflows', subject: `workflow:${run.workflowId}`, payload: { runId, outcome }, sim })
    return { runId, outcome }
  })
}
