// ============================================================
// EEC — HANDLERS: handoff.* (P1-1 · doc 07 §3.4 / matriz #24)
// Acta de entrega-recepción (traspaso) entre agentes/unidades del
// ecosistema. EEC es neutral al dominio: un handoff es un sobre
// HandoffEnvelope con dossier de evidencias VERIFICADAS (P0-2),
// asuntos abiertos y garantías declaradas. Fail-closed: sin dossier
// verificado el traspaso NO se formaliza; la recepción exige ACK
// explícito del receptor (entrega no es recepción).
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { writeAudit } from '../../engine/audit'
import { isVerifiedEvidence } from '../../security/evidence'

export function registerHandoffHandlers(): void {
  // ---------------- handoff.create ----------------
  registerCommandHandler('handoff.create', async ({ payload, sim, traceId, requesterId, requesterType }) => {
    const p = payload as {
      fromAgentId: string; toAgentId: string; subject: string; summary?: string
      dossier: Array<{ id: string; source: string; kind: string; hash?: string; verifiedAt?: string }>
      openItems: string[]; completeness: 'FULL' | 'PARTIAL'
    }
    const [from, to] = await Promise.all([
      db.agent.findUnique({ where: { id: p.fromAgentId } }),
      db.agent.findUnique({ where: { id: p.toAgentId } }),
    ])
    if (!from) throw new Error('HANDOFF_FROM_AGENT_NOT_FOUND')
    if (!to) throw new Error('HANDOFF_TO_AGENT_NOT_FOUND')
    if (from.id === to.id) throw new Error('HANDOFF_SAME_AGENT')

    // FAIL-CLOSED: todo elemento del dossier debe ser evidencia verificada.
    // Un expediente con "evidencia fantasma" (sin hash o sin verifiedAt)
    // no transfiere responsabilidad — se rechaza el traspaso completo.
    const unverified = p.dossier
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !isVerifiedEvidence(e))
      .map(({ i }) => i)
    if (unverified.length > 0) {
      throw new Error(`HANDOFF_EVIDENCE_NOT_VERIFIED:items=${unverified.join(',')}`)
    }

    const handoff = await db.handoff.create({
      data: {
        code: `HDO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        fromAgentId: from.id, toAgentId: to.id,
        subject: p.subject, summary: p.summary ?? '',
        dossierJson: JSON.stringify(p.dossier),
        openItemsJson: JSON.stringify(p.openItems),
        guaranteesJson: JSON.stringify({ completeness: p.completeness, declaredAt: new Date().toISOString() }),
        status: 'CREATED', traceId: traceId ?? null, sim,
      },
    })
    await eventBus.publish({
      event_type: 'handoff.created', source: 'eec.handoffs', subject: `handoff:${handoff.id}`,
      payload: {
        handoffId: handoff.id, code: handoff.code, subject: p.subject,
        from: from.code, to: to.code, dossierSize: p.dossier.length,
        openItems: p.openItems.length, completeness: p.completeness,
      }, sim,
    })
    await writeAudit({
      actorId: requesterId ?? from.id, actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'AGENT',
      action: 'handoff.create', entityType: 'HANDOFF', entityId: handoff.id,
      input: { from: from.code, to: to.code, subject: p.subject, dossier: p.dossier.length, openItems: p.openItems.length },
      result: 'CREATED', sim,
    })
    return { handoffId: handoff.id, code: handoff.code, status: 'CREATED', dossierSize: p.dossier.length }
  })

  // ---------------- handoff.ack ----------------
  registerCommandHandler('handoff.ack', async ({ payload, sim, requesterId, requesterType }) => {
    const { handoffId, note } = payload as { handoffId: string; note?: string }
    const h = await db.handoff.findUnique({ where: { id: handoffId } })
    if (!h) throw new Error('HANDOFF_NOT_FOUND')
    if (h.status !== 'CREATED') throw new Error(`HANDOFF_INVALID_STATE:${h.status}`)
    // Solo el receptor puede acusar recibo; el operador humano actúa como
    // autoridad administrativa (misma regla de autoridad implícita del pipeline).
    if (requesterType === 'AGENT' && requesterId !== h.toAgentId) {
      throw new Error('HANDOFF_ACK_FORBIDDEN:not_receiver')
    }
    await db.handoff.update({
      where: { id: h.id },
      data: { status: 'ACKNOWLEDGED', ackedAt: new Date(), ackNote: note ?? null },
    })
    await eventBus.publish({
      event_type: 'handoff.acknowledged', source: 'eec.handoffs', subject: `handoff:${h.id}`,
      payload: { handoffId: h.id, code: h.code, subject: h.subject, ackBy: requesterId ?? h.toAgentId }, sim,
    })
    await writeAudit({
      actorId: requesterId ?? h.toAgentId, actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'AGENT',
      action: 'handoff.ack', entityType: 'HANDOFF', entityId: h.id, result: 'ACKNOWLEDGED', sim,
    })
    return { handoffId: h.id, status: 'ACKNOWLEDGED' }
  })

  // ---------------- handoff.reject ----------------
  registerCommandHandler('handoff.reject', async ({ payload, sim, requesterId, requesterType }) => {
    const { handoffId, reason } = payload as { handoffId: string; reason: string }
    const h = await db.handoff.findUnique({ where: { id: handoffId } })
    if (!h) throw new Error('HANDOFF_NOT_FOUND')
    if (h.status !== 'CREATED') throw new Error(`HANDOFF_INVALID_STATE:${h.status}`)
    if (requesterType === 'AGENT' && requesterId !== h.toAgentId) {
      throw new Error('HANDOFF_REJECT_FORBIDDEN:not_receiver')
    }
    await db.handoff.update({
      where: { id: h.id },
      data: { status: 'REJECTED', ackNote: reason },
    })
    await eventBus.publish({
      event_type: 'handoff.rejected', source: 'eec.handoffs', subject: `handoff:${h.id}`,
      payload: { handoffId: h.id, code: h.code, subject: h.subject, reason }, sim,
    })
    await writeAudit({
      actorId: requesterId ?? h.toAgentId, actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'AGENT',
      action: 'handoff.reject', entityType: 'HANDOFF', entityId: h.id, result: 'REJECTED', why: reason, sim,
    })
    return { handoffId: h.id, status: 'REJECTED' }
  })
}
