// ============================================================
// EEC — STATE CORE: únicas puertas de mutación de estado operacional.
// STATE ≠ ACTIVITY ≠ LOCATION ≠ TASK (spec §12).
// Transiciones inválidas se rechazan Y se auditan.
// ============================================================
import { db } from '../../../lib/db'
import { canTransition, canTaskTransition } from '../domain/types'
import { eventBus } from '../events/bus'
import { writeAudit } from './audit'

export class TransitionError extends Error {
  constructor(public entity: string, public id: string, public from: string, public to: string) {
    super(`INVALID_TRANSITION:${entity}:${id}:${from}->${to}`)
  }
}

export async function setAgentState(
  agentId: string, to: string,
  reason: string,
  opts?: { activity?: string | null; sim?: boolean; correlationId?: string },
): Promise<{ from: string; to: string }> {
  const agent = await db.agent.findUnique({ where: { id: agentId } })
  if (!agent) throw new Error(`AGENT_NOT_FOUND:${agentId}`)
  const from = agent.state
  if (from === to) return { from, to }
  if (!canTransition(from, to)) {
    await eventBus.publish({
      event_type: 'agent.state.rejected',
      source: 'eec.state',
      subject: `agent:${agentId}`,
      payload: { agentId, code: agent.code, from, to, reason },
      sim: opts?.sim,
    })
    await writeAudit({
      actorId: 'eec:state-machine', actorType: 'SYSTEM',
      action: 'agent.state.transition_rejected', entityType: 'AGENT', entityId: agentId,
      input: { from, to, reason }, result: 'REJECTED',
      why: 'transición no permitida por la máquina de estados operacional',
    })
    throw new TransitionError('AGENT', agentId, from, to)
  }
  await db.agent.update({
    where: { id: agentId },
    data: { state: to, ...(opts?.activity !== undefined ? { activity: opts.activity } : {}) },
  })
  await eventBus.publish({
    event_type: 'agent.state.changed',
    source: 'eec.state',
    subject: `agent:${agentId}`,
    payload: { agentId, code: agent.code, from, to, reason },
    sim: opts?.sim,
  })
  return { from, to }
}

export async function setAgentActivity(agentId: string, activity: string | null, sim?: boolean): Promise<void> {
  await db.agent.update({ where: { id: agentId }, data: { activity } })
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { code: true } })
  await eventBus.publish({
    event_type: 'agent.activity.changed',
    source: 'eec.state',
    subject: `agent:${agentId}`,
    payload: { agentId, code: agent?.code, activity },
    sim,
  })
}

/**
 * Cambio de ubicación derivable — el MOVIMIENTO visual nace de este evento
 * (from → to), jamás se anima sin él (spec §40, NO FABRICATION §56).
 */
export async function setAgentLocation(
  agentId: string, toLocationId: string | null,
  reason: string, sim?: boolean,
): Promise<{ from: string | null; to: string | null }> {
  const agent = await db.agent.findUnique({ where: { id: agentId } })
  if (!agent) throw new Error(`AGENT_NOT_FOUND:${agentId}`)
  const from = agent.locationId
  if (from === toLocationId) return { from, to: toLocationId }
  await db.agent.update({ where: { id: agentId }, data: { locationId: toLocationId } })
  await eventBus.publish({
    event_type: 'agent.location.changed',
    source: 'eec.state',
    subject: `agent:${agentId}`,
    payload: { agentId, code: agent.code, from, to: toLocationId, reason },
    sim,
  })
  return { from, to: toLocationId }
}

export async function setTaskState(
  taskId: string, to: string, reason: string, sim?: boolean,
  extra?: { resultJson?: Record<string, unknown> },
): Promise<{ from: string; to: string }> {
  const task = await db.task.findUnique({ where: { id: taskId } })
  if (!task) throw new Error(`TASK_NOT_FOUND:${taskId}`)
  const from = task.status
  if (from === to) return { from, to }
  if (!canTaskTransition(from, to)) {
    await eventBus.publish({
      event_type: 'task.state.rejected',
      source: 'eec.state',
      subject: `task:${taskId}`,
      payload: { taskId, code: task.code, from, to, reason },
      sim,
    })
    await writeAudit({
      actorId: 'eec:state-machine', actorType: 'SYSTEM',
      action: 'task.state.transition_rejected', entityType: 'TASK', entityId: taskId,
      input: { from, to, reason }, result: 'REJECTED',
      why: 'transición no permitida por la máquina de estados de tareas',
    })
    throw new TransitionError('TASK', taskId, from, to)
  }
  await db.task.update({
    where: { id: taskId },
    data: { status: to, ...(extra?.resultJson ? { resultJson: JSON.stringify(extra.resultJson) } : {}) },
  })
  await eventBus.publish({
    event_type: 'task.state.changed',
    source: 'eec.state',
    subject: `task:${taskId}`,
    payload: { taskId, code: task.code, from, to, reason },
    sim,
  })
  return { from, to }
}
