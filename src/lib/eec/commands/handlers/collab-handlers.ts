// ============================================================
// EEC — HANDLERS: meeting.* (§34) + approval.* (§24) + intervention
// El movimiento de agentes hacia reuniones se DERIVA del estado real
// de reunión/ubicación (agent.location.changed) — nunca animación fake (§40).
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler, dispatchCommand } from '../pipeline'
import { setAgentState, setAgentLocation } from '../../engine/state'
import { writeAudit } from '../../engine/audit'
import { memoryService } from '../../engine/memory'

export function registerCollabHandlers(): void {
  // ---------------- meeting.create ----------------
  registerCommandHandler('meeting.create', async ({ payload, sim }) => {
    const p = payload as {
      title: string; objective?: string; agenda: string[]; locationCode?: string
      organizerAgentId?: string; scheduledStartAt: string; durationMinutes: number
      participantAgentIds: string[]
    }
    const location = p.locationCode
      ? await db.location.findUnique({ where: { code: p.locationCode } })
      : await db.location.findFirst({ where: { type: 'BOARDROOM' } })
    const start = new Date(p.scheduledStartAt)
    const end = new Date(start.getTime() + p.durationMinutes * 60_000)
    const meeting = await db.meeting.create({
      data: {
        code: `MTG-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        title: p.title, objective: p.objective,
        agendaJson: JSON.stringify(p.agenda),
        status: 'SCHEDULED', organizerAgentId: p.organizerAgentId,
        locationId: location?.id, scheduledStartAt: start, scheduledEndAt: end,
      },
    })
    if (p.organizerAgentId) {
      await db.meetingParticipant.create({
        data: { meetingId: meeting.id, agentId: p.organizerAgentId, role: 'ORGANIZER', response: 'ACCEPTED' },
      })
    }
    const cal = await db.calendarEvent.create({
      data: {
        title: p.title, type: 'MEETING', startAt: start, endAt: end,
        locationId: location?.id, relatedType: 'MEETING', relatedId: meeting.id, status: 'SCHEDULED',
      },
    })
    await db.meeting.update({ where: { id: meeting.id }, data: { calendarEventId: cal.id } })
    await eventBus.publish({
      event_type: 'meeting.created', source: 'eec.meetings', subject: `meeting:${meeting.id}`,
      payload: { meetingId: meeting.id, code: meeting.code, title: p.title, startAt: start.toISOString(), locationId: location?.id },
      sim,
    })
    // invitaciones
    if (p.participantAgentIds.length > 0) {
      await dispatchCommand({ type: 'meeting.invite', payload: { meetingId: meeting.id, agentIds: p.participantAgentIds }, requesterType: 'SYSTEM', requesterId: 'eec:meetings' })
    }
    return { meetingId: meeting.id, code: meeting.code, calendarEventId: cal.id }
  })

  // ---------------- meeting.invite → transición de ubicación (movimiento derivado) ----------------
  registerCommandHandler('meeting.invite', async ({ payload, sim }) => {
    const p = payload as { meetingId: string; agentIds: string[] }
    const meeting = await db.meeting.findUnique({ where: { id: p.meetingId }, include: { location: true } })
    if (!meeting) throw new Error('MEETING_NOT_FOUND')
    const room = meeting.location
    const moved: Array<{ agentId: string; code: string; from: string | null; to: string | null }> = []
    for (const agentId of p.agentIds) {
      const already = await db.meetingParticipant.findFirst({ where: { meetingId: meeting.id, agentId } })
      if (already) continue
      const agent = await db.agent.findUnique({ where: { id: agentId } })
      if (!agent) continue
      await db.meetingParticipant.create({
        data: { meetingId: meeting.id, agentId, role: 'PARTICIPANT', response: 'ACCEPTED' },
      })
      // MOVIMIENTO DERIVADO: el evento de ubicación es la fuente de la animación (§40)
      if (room && meeting.status !== 'COMPLETED') {
        const loc = await setAgentLocation(agentId, room.id, `meeting.invited:${meeting.code}`, sim)
        moved.push({ agentId, code: agent.code, from: loc.from, to: loc.to })
      }
      await eventBus.publish({
        event_type: 'meeting.invited', source: 'eec.meetings', subject: `meeting:${meeting.id}`,
        payload: { meetingId: meeting.id, agentId, agentCode: agent.code, room: room?.code }, sim,
      })
    }
    if (meeting.status === 'SCHEDULED') {
      await db.meeting.update({ where: { id: meeting.id }, data: { status: 'INVITED' } })
    }
    await db.calendarEvent.updateMany({ where: { relatedId: meeting.id, type: 'MEETING' }, data: { status: 'CONFIRMED' } })
    return { meetingId: meeting.id, moved }
  })

  // ---------------- meeting.start → IN_MEETING ----------------
  registerCommandHandler('meeting.start', async ({ payload, sim }) => {
    const { meetingId } = payload as { meetingId: string }
    const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { participants: true, location: true } })
    if (!meeting) throw new Error('MEETING_NOT_FOUND')

    const conversation = await db.conversation.create({
      data: { title: `Reunión: ${meeting.title}`, channel: 'MEETING', meetingId: meeting.id, status: 'OPEN' },
    })

    const stateChanges: Array<{ agentId: string; from: string; to: string }> = []
    for (const part of meeting.participants) {
      if (!part.agentId) continue
      await db.meetingParticipant.update({ where: { id: part.id }, data: { joinedAt: new Date(), response: 'ACCEPTED' } })
      const agent = await db.agent.findUnique({ where: { id: part.agentId } })
      if (agent && ['IDLE', 'WORKING'].includes(agent.state)) {
        const res = await setAgentState(agent.id, 'IN_MEETING', `meeting.start:${meeting.code}`, { sim, activity: `En reunión: ${meeting.title}` })
        stateChanges.push({ agentId: agent.id, from: res.from, to: res.to })
      }
    }
    await db.meeting.update({
      where: { id: meeting.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date(), conversationId: conversation.id },
    })
    await db.calendarEvent.updateMany({ where: { relatedId: meeting.id, type: 'MEETING' }, data: { status: 'CONFIRMED' } })
    await eventBus.publish({
      event_type: 'meeting.started', source: 'eec.meetings', subject: `meeting:${meeting.id}`,
      payload: { meetingId: meeting.id, code: meeting.code, conversationId: conversation.id, stateChanges }, sim,
    })
    await writeAudit({ actorId: 'eec:meetings', actorType: 'SYSTEM', action: 'meeting.start', entityType: 'MEETING', entityId: meeting.id, result: 'IN_PROGRESS' })
    return { meetingId: meeting.id, conversationId: conversation.id }
  })

  // ---------------- meeting.end → decisiones, action items → tareas ----------------
  registerCommandHandler('meeting.end', async ({ payload, sim }) => {
    const p = payload as {
      meetingId: string; decisions: string[]; result?: string
      actionItems: Array<{ title: string; assigneeAgentId?: string; priority: string }>
    }
    const meeting = await db.meeting.findUnique({ where: { id: p.meetingId }, include: { participants: true, location: true } })
    if (!meeting) throw new Error('MEETING_NOT_FOUND')

    const generatedTasks: Array<{ taskId: string; code: string }> = []
    for (const item of p.actionItems) {
      const res = await dispatchCommand({
        type: 'task.create',
        requesterType: 'SYSTEM', requesterId: `meeting:${meeting.code}`,
        payload: { title: item.title, priority: item.priority, kind: 'followup', tags: [`meeting:${meeting.code}`], assigneeAgentId: item.assigneeAgentId },
      })
      if (res.ok && res.result?.taskId) generatedTasks.push({ taskId: String(res.result.taskId), code: String(res.result.code ?? '') })
    }

    await db.meeting.update({
      where: { id: meeting.id },
      data: {
        status: 'COMPLETED', endedAt: new Date(), result: p.result,
        decisionsJson: JSON.stringify(p.decisions),
        actionItemsJson: JSON.stringify(p.actionItems.map(a => ({ ...a, taskId: generatedTasks.find(g => g.code)?.taskId }))),
      },
    })
    await db.calendarEvent.updateMany({ where: { relatedId: meeting.id, type: 'MEETING' }, data: { status: 'COMPLETED' } })
    if (meeting.conversationId) {
      await db.conversation.update({ where: { id: meeting.conversationId }, data: { status: 'CLOSED', endedAt: new Date() } })
    }

    // participantes vuelven a IDLE y a su oficina (movimiento derivado)
    for (const part of meeting.participants) {
      if (!part.agentId) continue
      await db.meetingParticipant.update({ where: { id: part.id }, data: { leftAt: new Date() } })
      const agent = await db.agent.findUnique({ where: { id: part.agentId } })
      if (!agent) continue
      if (agent.state === 'IN_MEETING') {
        await setAgentState(agent.id, 'IDLE', `meeting.end:${meeting.code}`, { sim, activity: 'Disponible' }).catch(() => undefined)
      }
      if (agent.officeId) {
        await setAgentLocation(agent.id, agent.officeId, `meeting.end: vuelta a oficina ${agent.code}`, sim)
      }
      await memoryService().write({
        agentId: agent.id, scope: 'WORKING_CONTEXT', kind: 'EPISODE',
        content: `Participé en la reunión "${meeting.title}". Decisiones: ${p.decisions.join(' | ') || '—'}`,
        importance: 6, provenance: { meetingId: meeting.id }, tags: ['meeting', meeting.code],
      }).catch(() => undefined)
    }

    await eventBus.publish({
      event_type: 'meeting.ended', source: 'eec.meetings', subject: `meeting:${meeting.id}`,
      payload: { meetingId: meeting.id, code: meeting.code, decisions: p.decisions, generatedTasks, result: p.result }, sim,
    })
    return { meetingId: meeting.id, generatedTasks }
  })

  // ---------------- approval.request / approve / reject / cancel ----------------
  registerCommandHandler('approval.request', async ({ payload, requesterId, sim }) => {
    const p = payload as {
      requestType: string; title: string; description?: string; subjectType?: string
      subjectId?: string; risk: string; payload: Record<string, unknown>
      ttlMinutes: number; requestedById?: string; resumeCommandId?: string
    }
    const approval = await db.approval.create({
      data: {
        requestType: p.requestType, subjectType: p.subjectType, subjectId: p.subjectId,
        title: p.title, description: p.description, risk: p.risk,
        payloadJson: JSON.stringify({ ...p.payload, resumeCommandId: p.resumeCommandId }),
        requestedById: p.requestedById ?? requesterId,
        expiresAt: new Date(Date.now() + p.ttlMinutes * 60_000),
      },
    })
    await eventBus.publish({
      event_type: 'approval.requested', source: 'eec.approvals', subject: `approval:${approval.id}`,
      payload: { approvalId: approval.id, requestType: p.requestType, title: p.title, risk: p.risk, subjectType: p.subjectType, subjectId: p.subjectId }, sim,
    })
    await writeAudit({ actorId: p.requestedById ?? requesterId ?? 'system', actorType: 'SYSTEM', action: 'approval.request', entityType: 'APPROVAL', entityId: approval.id, input: p, result: 'REQUESTED' })
    return { approvalId: approval.id }
  })

  registerCommandHandler('approval.approve', async ({ payload, requesterId, sim }) => {
    const p = payload as { approvalId: string; note?: string }
    const approval = await db.approval.findUnique({ where: { id: p.approvalId } })
    if (!approval) throw new Error('APPROVAL_NOT_FOUND')
    if (approval.status !== 'REQUESTED') throw new Error(`APPROVAL_NOT_PENDING:${approval.status}`)
    await db.approval.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', decidedById: requesterId ?? 'operator', decidedAt: new Date(), decisionNote: p.note },
    })
    await eventBus.publish({
      event_type: 'approval.approved', source: 'eec.approvals', subject: `approval:${approval.id}`,
      payload: { approvalId: approval.id, subjectType: approval.subjectType, subjectId: approval.subjectId, decidedBy: requesterId }, sim,
    })
    await writeAudit({ actorId: requesterId ?? 'operator', actorType: 'HUMAN', action: 'approval.approve', entityType: 'APPROVAL', entityId: approval.id, result: 'APPROVED', why: p.note })

    // ---- reanudar lo que estaba esperando (comando pausado / tool / nodo workflow) ----
    let resumed: Record<string, unknown> = {}
    const payloadData = JSON.parse(approval.payloadJson || '{}')
    if (approval.subjectType === 'COMMAND' && approval.subjectId) {
      const { resumeApprovedCommand } = await import('../pipeline')
      const res = await resumeApprovedCommand(approval.subjectId, approval.id)
      resumed = { commandId: res.commandId, status: res.status }
    } else if (approval.subjectType === 'TOOL_INVOCATION' && approval.subjectId) {
      const inv = await db.toolInvocation.findUnique({ where: { id: approval.subjectId } })
      if (inv) {
        const { invokeTool } = await import('../../engine/gateway')
        const res = await invokeTool({
          toolCode: inv.toolCode, input: JSON.parse(inv.inputJson || '{}'),
          agentId: inv.agentId, runId: inv.runId, taskId: inv.taskId,
          requesterType: 'AGENT', approvedById: requesterId, sim,
        })
        resumed = { invocationId: inv.id, status: res.status }
      }
    } else if (approval.subjectType === 'WORKFLOW_RUN' && approval.subjectId) {
      const { advanceWorkflowRun } = await import('./workflow-handlers')
      // marcar nodo DONE y avanzar
      const run = await db.run.findUnique({ where: { id: approval.subjectId } })
      if (run) {
        const ctx = JSON.parse(run.contextJson || '{}')
        const nodeId = payloadData.nodeId ?? approval.requestType
        if (ctx.wfNodes?.[nodeId]) ctx.wfNodes[nodeId].status = 'DONE'
        await db.run.update({ where: { id: run.id }, data: { contextJson: JSON.stringify(ctx) } })
        const outcome = await advanceWorkflowRun(run.id, sim)
        resumed = { runId: run.id, outcome }
      }
    }
    return { approvalId: approval.id, status: 'APPROVED', resumed }
  })

  registerCommandHandler('approval.reject', async ({ payload, requesterId, sim }) => {
    const p = payload as { approvalId: string; note?: string }
    const approval = await db.approval.findUnique({ where: { id: p.approvalId } })
    if (!approval) throw new Error('APPROVAL_NOT_FOUND')
    if (approval.status !== 'REQUESTED') throw new Error(`APPROVAL_NOT_PENDING:${approval.status}`)
    await db.approval.update({
      where: { id: approval.id },
      data: { status: 'REJECTED', decidedById: requesterId ?? 'operator', decidedAt: new Date(), decisionNote: p.note },
    })
    await eventBus.publish({
      event_type: 'approval.rejected', source: 'eec.approvals', subject: `approval:${approval.id}`,
      payload: { approvalId: approval.id, subjectType: approval.subjectType, subjectId: approval.subjectId }, sim,
    })
    await writeAudit({ actorId: requesterId ?? 'operator', actorType: 'HUMAN', action: 'approval.reject', entityType: 'APPROVAL', entityId: approval.id, result: 'REJECTED', why: p.note })

    if (approval.subjectType === 'COMMAND' && approval.subjectId) {
      await db.commandRecord.update({
        where: { id: approval.subjectId },
        data: { status: 'REJECTED', rejectionReason: `approval_rejected:${p.note ?? ''}` },
      }).catch(() => undefined)
      await eventBus.publish({
        event_type: 'system.command.rejected', source: 'eec.approvals', subject: `command:${approval.subjectId}`,
        payload: { commandId: approval.subjectId, reason: 'approval_rejected' }, sim,
      })
    }
    if (approval.subjectType === 'TOOL_INVOCATION' && approval.subjectId) {
      await db.toolInvocation.update({
        where: { id: approval.subjectId }, data: { status: 'DENIED', completedAt: new Date(), error: 'approval_rejected' },
      }).catch(() => undefined)
    }
    return { approvalId: approval.id, status: 'REJECTED' }
  })

  registerCommandHandler('approval.cancel', async ({ payload, requesterId, sim }) => {
    const p = payload as { approvalId: string; note?: string }
    const approval = await db.approval.findUnique({ where: { id: p.approvalId } })
    if (!approval) throw new Error('APPROVAL_NOT_FOUND')
    await db.approval.update({
      where: { id: approval.id },
      data: { status: 'CANCELLED', decidedById: requesterId ?? 'operator', decidedAt: new Date(), decisionNote: p.note },
    })
    await eventBus.publish({ event_type: 'approval.cancelled', source: 'eec.approvals', subject: `approval:${approval.id}`, payload: { approvalId: approval.id }, sim })
    return { approvalId: approval.id, status: 'CANCELLED' }
  })

  // ---------------- intervention.request (§24 REDIRECT/INSPECT) ----------------
  registerCommandHandler('intervention.request', async ({ payload, requesterId, sim }) => {
    const p = payload as { agentId?: string; taskId?: string; reason: string; urgency: string }
    const approval = await db.approval.create({
      data: {
        requestType: 'HUMAN_INTERVENTION',
        subjectType: p.agentId ? 'AGENT' : 'TASK',
        subjectId: p.agentId ?? p.taskId,
        title: `Intervención humana requerida (${p.urgency})`,
        description: p.reason, risk: p.urgency,
        payloadJson: JSON.stringify(p),
        requestedById: requesterId ?? 'system',
        expiresAt: new Date(Date.now() + 4 * 3600 * 1000),
      },
    })
    if (p.agentId) {
      const agent = await db.agent.findUnique({ where: { id: p.agentId } })
      if (agent && agent.state === 'WORKING') {
        await setAgentState(agent.id, 'BLOCKED', 'intervention.request', { sim, activity: `Bloqueado: ${p.reason.slice(0, 60)}` }).catch(() => undefined)
      }
    }
    await eventBus.publish({
      event_type: 'approval.requested', source: 'eec.approvals', subject: `approval:${approval.id}`,
      payload: { approvalId: approval.id, requestType: 'HUMAN_INTERVENTION', urgency: p.urgency, reason: p.reason, agentId: p.agentId }, sim,
    })
    return { approvalId: approval.id }
  })
}
