// ============================================================
// EEC — HANDLERS: CRM (§32), Calendar (§33), Scheduler (§22),
// Memory (§18), Knowledge (§19), Tools (§17), System (§42/§46/§52)
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler, dispatchCommand, setSimulationMode } from '../pipeline'
import { writeAudit, correctAudit } from '../../engine/audit'
import { memoryService } from '../../engine/memory'
import { invokeTool } from '../../engine/gateway'
import { CRM_STAGES } from '../../domain/types'

export function registerBizHandlers(): void {
  // ---------------- CRM ----------------
  registerCommandHandler('client.create', async ({ payload, sim }) => {
    const p = payload as { name: string; segment?: string; contactName?: string; contactEmail?: string; notes?: string; ownerAgentId?: string; tags: string[] }
    const client = await db.client.create({
      data: {
        name: p.name, segment: p.segment, contactName: p.contactName, contactEmail: p.contactEmail,
        notes: p.notes, ownerAgentId: p.ownerAgentId, stage: 'PROSPECT', tagsJson: JSON.stringify(p.tags),
      },
    })
    await eventBus.publish({ event_type: 'client.created', source: 'eec.crm', subject: `client:${client.id}`, payload: { clientId: client.id, name: client.name, stage: client.stage }, sim })
    return { clientId: client.id }
  })

  registerCommandHandler('client.update_stage', async ({ payload, sim }) => {
    const p = payload as { clientId: string; stage: string; note?: string }
    if (!(CRM_STAGES as readonly string[]).includes(p.stage)) throw new Error(`INVALID_STAGE:${p.stage}`)
    const client = await db.client.findUnique({ where: { id: p.clientId } })
    if (!client) throw new Error('CLIENT_NOT_FOUND')
    await db.client.update({ where: { id: client.id }, data: { stage: p.stage } })
    await eventBus.publish({
      event_type: 'client.stage.changed', source: 'eec.crm', subject: `client:${client.id}`,
      payload: { clientId: client.id, name: client.name, from: client.stage, to: p.stage, note: p.note }, sim,
    })
    await memoryService().write({
      scope: 'ORGANIZATIONAL_MEMORY', kind: 'FACT',
      content: `Cliente ${client.name}: etapa CRM ${client.stage} → ${p.stage}${p.note ? ` (${p.note})` : ''}`,
      importance: 6, provenance: { clientId: client.id }, tags: ['crm', client.name],
    }).catch(() => undefined)
    return { clientId: client.id, stage: p.stage }
  })

  registerCommandHandler('opportunity.create', async ({ payload, sim }) => {
    const p = payload as { clientId: string; name: string; stage: string; value: number; currency: string; probability: number; ownerAgentId?: string; expectedCloseAt?: string; notes?: string }
    const opp = await db.opportunity.create({
      data: {
        clientId: p.clientId, name: p.name, stage: p.stage, value: p.value, currency: p.currency,
        probability: p.probability, ownerAgentId: p.ownerAgentId,
        expectedCloseAt: p.expectedCloseAt ? new Date(p.expectedCloseAt) : null, notes: p.notes,
      },
    })
    await eventBus.publish({ event_type: 'client.opportunity.created', source: 'eec.crm', subject: `client:${p.clientId}`, payload: { opportunityId: opp.id, name: opp.name, value: opp.value }, sim })
    return { opportunityId: opp.id }
  })

  registerCommandHandler('opportunity.update_stage', async ({ payload, sim }) => {
    const p = payload as { opportunityId: string; stage: string; note?: string }
    const opp = await db.opportunity.findUnique({ where: { id: p.opportunityId } })
    if (!opp) throw new Error('OPPORTUNITY_NOT_FOUND')
    await db.opportunity.update({ where: { id: opp.id }, data: { stage: p.stage } })
    if (p.stage === 'WON') {
      await db.client.update({ where: { id: opp.clientId }, data: { stage: 'CLIENT' } }).catch(() => undefined)
    }
    await eventBus.publish({
      event_type: 'client.opportunity.stage_changed', source: 'eec.crm', subject: `opportunity:${opp.id}`,
      payload: { opportunityId: opp.id, from: opp.stage, to: p.stage, note: p.note }, sim,
    })
    return { opportunityId: opp.id, stage: p.stage }
  })

  registerCommandHandler('interaction.log', async ({ payload, sim }) => {
    const p = payload as { clientId?: string; opportunityId?: string; agentId?: string; channel: string; summary: string }
    const inter = await db.interaction.create({
      data: { clientId: p.clientId, opportunityId: p.opportunityId, agentId: p.agentId, channel: p.channel, summary: p.summary },
    })
    await eventBus.publish({ event_type: 'client.interaction.logged', source: 'eec.crm', subject: `client:${p.clientId ?? 'unknown'}`, payload: { interactionId: inter.id, channel: p.channel, summary: p.summary }, sim })
    return { interactionId: inter.id }
  })

  // ---------------- CALENDAR / SCHEDULER ----------------
  registerCommandHandler('calendar.create', async ({ payload, sim }) => {
    const p = payload as {
      title: string; type: string; startAt: string; endAt?: string; timezone: string
      locationCode?: string; relatedType?: string; relatedId?: string
      commandType?: string; commandPayload?: Record<string, unknown>; recurrenceCron?: string; reminderMinutes?: number
    }
    const location = p.locationCode ? await db.location.findUnique({ where: { code: p.locationCode } }) : null
    const cal = await db.calendarEvent.create({
      data: {
        title: p.title, type: p.type, startAt: new Date(p.startAt), endAt: p.endAt ? new Date(p.endAt) : null,
        timezone: p.timezone, locationId: location?.id, relatedType: p.relatedType, relatedId: p.relatedId,
        reminderMinutes: p.reminderMinutes, recurrenceJson: p.recurrenceCron ? JSON.stringify({ cron: p.recurrenceCron }) : null,
      },
    })
    // DEADLINE y SCHEDULED_RUN generan Schedule asociado (scheduler responde al CUÁNDO, §22)
    if (p.commandType && (p.type === 'SCHEDULED_RUN' || p.type === 'DEADLINE')) {
      await db.schedule.create({
        data: {
          name: `cal:${cal.id}:${p.title}`, kind: 'ONE_TIME', expression: p.startAt,
          timezone: p.timezone, commandType: p.commandType,
          commandPayloadJson: JSON.stringify(p.commandPayload ?? {}),
          nextRunAt: new Date(p.startAt),
        },
      })
    }
    await eventBus.publish({ event_type: 'system.calendar.created', source: 'eec.calendar', subject: `calendar:${cal.id}`, payload: { calendarEventId: cal.id, title: p.title, type: p.type, startAt: p.startAt }, sim })
    return { calendarEventId: cal.id }
  })

  registerCommandHandler('schedule.create', async ({ payload, sim }) => {
    const p = payload as { name: string; kind: string; expression: string; timezone: string; commandType: string; commandPayload: Record<string, unknown>; enabled: boolean }
    const schedule = await db.schedule.create({
      data: {
        name: p.name, kind: p.kind, expression: p.expression, timezone: p.timezone,
        commandType: p.commandType, commandPayloadJson: JSON.stringify(p.commandPayload),
        enabled: p.enabled,
        nextRunAt: p.kind === 'ONE_TIME' ? new Date(p.expression) : null,
      },
    })
    await eventBus.publish({ event_type: 'system.schedule.created', source: 'eec.scheduler', subject: `schedule:${schedule.id}`, payload: { scheduleId: schedule.id, name: p.name, kind: p.kind, commandType: p.commandType }, sim })
    return { scheduleId: schedule.id }
  })

  registerCommandHandler('schedule.toggle', async ({ payload, sim }) => {
    const p = payload as { scheduleId: string; enabled: boolean }
    await db.schedule.update({ where: { id: p.scheduleId }, data: { enabled: p.enabled } })
    await eventBus.publish({ event_type: 'system.schedule.toggled', source: 'eec.scheduler', subject: `schedule:${p.scheduleId}`, payload: p, sim })
    return p
  })

  // ---------------- MEMORY / KNOWLEDGE ----------------
  registerCommandHandler('memory.write', async ({ payload, sim }) => {
    const p = payload as { agentId?: string; scope: string; kind: string; content: string; importance: number; classification: string; tags: string[]; provenance: Record<string, unknown>; ttlMinutes?: number }
    const res = await memoryService().write({
      agentId: p.agentId, scope: p.scope, kind: p.kind, content: p.content,
      importance: p.importance, provenance: { ...p.provenance, via: 'command', sim },
      classification: p.classification, tags: p.tags, ttlMinutes: p.ttlMinutes,
    })
    await eventBus.publish({ event_type: 'memory.written', source: 'eec.memory', subject: `memory:${res.id}`, payload: { memoryId: res.id, agentId: p.agentId, scope: p.scope, kind: p.kind }, sim })
    return { memoryId: res.id }
  })

  registerCommandHandler('knowledge.publish', async ({ payload, sim }) => {
    const p = payload as { title: string; sourceType: string; content: string; sourceRef?: string; classification: string; tags: string[] }
    const item = await db.knowledgeItem.create({
      data: { title: p.title, sourceType: p.sourceType, content: p.content, sourceRef: p.sourceRef, classification: p.classification, tagsJson: JSON.stringify(p.tags) },
    })
    await eventBus.publish({ event_type: 'knowledge.published', source: 'eec.knowledge', subject: `knowledge:${item.id}`, payload: { knowledgeId: item.id, title: p.title, classification: p.classification }, sim })
    return { knowledgeId: item.id }
  })

  // ---------------- TOOL INVOKE directo (humano o agente con permiso) ----------------
  registerCommandHandler('tool.invoke', async ({ payload, requesterId, requesterType, sim }) => {
    const p = payload as { toolCode: string; input: Record<string, unknown>; agentId?: string; taskId?: string; runId?: string }
    const res = await invokeTool({
      toolCode: p.toolCode, input: p.input, agentId: p.agentId ?? null, taskId: p.taskId ?? null,
      runId: p.runId ?? null, requesterType: requesterType as 'AGENT' | 'HUMAN' | 'SYSTEM', requesterId, sim,
    })
    if (!res.ok && res.status !== 'APPROVAL_REQUIRED') throw new Error(`tool_${res.status.toLowerCase()}:${res.error ?? ''}`)
    return { invocationId: res.invocationId, status: res.status, output: res.output, approvalId: res.approvalId }
  })

  // ---------------- NOTIFICATIONS / AUDIT / SYSTEM ----------------
  registerCommandHandler('notification.read', async ({ payload }) => {
    const { notificationId } = payload as { notificationId: string }
    await db.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } })
    return { notificationId }
  })

  registerCommandHandler('audit.correct', async ({ payload, requesterId }) => {
    const p = payload as { prevAuditId: string; action: string; entityType: string; entityId: string; why: string; output: Record<string, unknown>; result?: string }
    const id = await correctAudit(p.prevAuditId, {
      actorId: requesterId ?? 'operator', actorType: 'HUMAN',
      action: p.action, entityType: p.entityType, entityId: p.entityId,
      output: p.output, result: p.result ?? 'CORRECTED',
    }, p.why)
    return { auditId: id }
  })

  registerCommandHandler('system.simulation.toggle', async ({ payload, sim }) => {
    const p = payload as { enabled: boolean }
    setSimulationMode(p.enabled)
    await memoryService().write({
      scope: 'ORGANIZATIONAL_MEMORY', kind: 'FACT',
      content: JSON.stringify({ enabled: p.enabled }),
      importance: 10, provenance: { system: 'simulation-toggle' },
      tags: ['system:sim_mode'],
    })
    await eventBus.publish({ event_type: 'system.simulation.changed', source: 'eec.system', subject: 'system', payload: { enabled: p.enabled }, sim: true })
    await writeAudit({ actorId: 'operator', actorType: 'HUMAN', action: 'system.simulation.toggle', entityType: 'SYSTEM', entityId: 'simulation', input: p, result: p.enabled ? 'SIMULATION_ON' : 'SIMULATION_OFF', why: 'control humano del modo simulación' })
    return { enabled: p.enabled }
  })

  registerCommandHandler('system.chaos.runtime_crash', async ({ payload, sim }) => {
    const p = payload as { runtimeId: string; reason: string }
    const rt = await db.agentRuntime.findUnique({ where: { id: p.runtimeId }, include: { agent: true } })
    if (!rt) throw new Error('RUNTIME_NOT_FOUND')
    // fallo del runtime NO destruye la identidad del agente (§44)
    await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'CRASHED', health: 'CRASHED' } })
    await eventBus.publish({
      event_type: 'runtime.crashed', source: 'eec.chaos', subject: `runtime:${rt.id}`,
      payload: { runtimeId: rt.id, agentId: rt.agentId, reason: p.reason }, sim: true,
    })
    const agent = rt.agent
    if (['WORKING', 'IDLE', 'WAITING', 'BLOCKED', 'REVIEW'].includes(agent.state)) {
      await eventBus.publish({ event_type: 'agent.error', source: 'eec.chaos', subject: `agent:${agent.id}`, payload: { agentId: agent.id, reason: p.reason }, sim: true }).catch(() => undefined)
      const { setAgentState } = await import('../../engine/state')
      await setAgentState(agent.id, 'ERROR', p.reason, { sim: true, activity: 'Runtime caído — agente en error' }).catch(() => undefined)
    }
    const runs = await db.run.findMany({ where: { agentId: agent.id, status: 'RUNNING' } })
    for (const r of runs) {
      await db.run.update({ where: { id: r.id }, data: { status: 'FAILED', error: `runtime crash: ${p.reason}`, completedAt: new Date() } })
      await eventBus.publish({ event_type: 'run.failed', source: 'eec.chaos', subject: `run:${r.id}`, payload: { runId: r.id, reason: p.reason }, sim: true })
    }
    await db.session.updateMany({ where: { agentId: agent.id, status: 'ACTIVE' }, data: { status: 'INTERRUPTED', endedAt: new Date() } })
    await writeAudit({ actorId: 'operator', actorType: 'HUMAN', action: 'system.chaos.runtime_crash', entityType: 'RUNTIME', entityId: rt.id, result: 'CRASHED', why: p.reason })
    return { runtimeId: rt.id, status: 'CRASHED', agentState: 'ERROR', identityPreserved: true }
  })

  registerCommandHandler('system.deadletter.retry', async ({ payload }) => {
    const { limit } = payload as { limit: number }
    const { eventBus } = await import('../../events/bus')
    const n = await eventBus.retryDeadLetter(limit)
    return { retried: n }
  })
}
