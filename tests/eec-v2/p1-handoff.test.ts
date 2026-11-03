// ============================================================
// EEC V2 — P1-1: HANDOFF ENVELOPE — traspaso con evidencia (doc 07 §3.4)
// bun test tests/eec-v2/p1-handoff.test.ts
// Acta de entrega-recepción estilo administrativo:
//  - traspaso con dossier verificado → CREATED + evento + auditoría (TNR)
//  - dossier con evidencia fantasma → fail-closed, no se formaliza (TPR)
//  - ACK del receptor → ACKNOWLEDGED; ACK de un tercero agente → prohibido
//  - rechazo del receptor con motivo → REJECTED, todo auditado
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand } from '../../src/lib/eec/commands/pipeline'
import { setSimulationMode } from '../../src/lib/eec/commands'
import { isVerifiedEvidence } from '../../src/lib/eec/security/evidence'

const SFX = Date.now().toString(36)
let fromAgentId = ''
let toAgentId = ''
let thirdAgentId = ''
const handoffIds: string[] = []

const EVID_OK = { id: 'ev-1', source: 'expediente:central', kind: 'record', hash: 'a'.repeat(64), verifiedAt: new Date().toISOString() }
const EVID_FANTASMA = { id: 'ev-2', source: 'inventado', kind: 'record' }

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
  const from = await db.agent.create({ data: { code: `HDO-F-${SFX}`, name: 'Agente origen', role: 'GESTOR_DESPACHO' } })
  const to = await db.agent.create({ data: { code: `HDO-T-${SFX}`, name: 'Agente receptor', role: 'GESTOR_DESPACHO' } })
  const third = await db.agent.create({ data: { code: `HDO-X-${SFX}`, name: 'Agente tercero', role: 'OBSERVADOR' } })
  fromAgentId = from.id; toAgentId = to.id; thirdAgentId = third.id
  // el receptor (y solo él, entre agentes) puede acusar recibo / rechazar
  await db.permission.create({
    data: { agentId: toAgentId, capability: 'command.handoff.ack', resource: 'handoff', action: 'ack', effect: 'ALLOW' },
  })
  await db.permission.create({
    data: { agentId: toAgentId, capability: 'command.handoff.reject', resource: 'handoff', action: 'reject', effect: 'ALLOW' },
  })
  await db.permission.create({
    data: { agentId: thirdAgentId, capability: 'command.handoff.ack', resource: 'handoff', action: 'ack', effect: 'ALLOW' },
  })
})

afterAll(async () => {
  await db.handoff.deleteMany({ where: { id: { in: handoffIds } } }).catch(() => undefined)
  await db.permission.deleteMany({ where: { agentId: { in: [toAgentId, thirdAgentId] } } }).catch(() => undefined)
  await db.agent.deleteMany({ where: { id: { in: [fromAgentId, toAgentId, thirdAgentId] } } }).catch(() => undefined)
  await db.$disconnect()
})

async function createHandoff(dossier: unknown[]) {
  const res = await dispatchCommand({
    type: 'handoff.create',
    payload: {
      fromAgentId, toAgentId,
      subject: `Traspaso de expediente ${SFX}`,
      summary: 'Entrega-recepción de carpeta con antecedentes verificados.',
      dossier, openItems: ['audiencia pendiente de confirmar'],
      completeness: 'PARTIAL',
    },
    requesterId: 'operator',
    requesterType: 'HUMAN',
  })
  if (res.ok && res.result?.handoffId) handoffIds.push(String(res.result.handoffId))
  return res
}

describe('P1-1 HandoffEnvelope', () => {
  test('isVerifiedEvidence: criterio compartido con el Evidence Gate (source+hash+verifiedAt)', () => {
    expect(isVerifiedEvidence(EVID_OK)).toBe(true)
    expect(isVerifiedEvidence(EVID_FANTASMA)).toBe(false)
    expect(isVerifiedEvidence(null)).toBe(false)
    expect(isVerifiedEvidence({ source: 'x', hash: 'y' })).toBe(false) // sin verifiedAt
  })

  test('traspaso con dossier verificado → CREATED, evento y auditoría (TNR)', async () => {
    const res = await createHandoff([EVID_OK])
    expect(res.ok).toBe(true)
    expect(res.status).toBe('EXECUTED')
    const h = await db.handoff.findUniqueOrThrow({ where: { id: String(res.result!.handoffId) } })
    expect(h.status).toBe('CREATED')
    expect(h.fromAgentId).toBe(fromAgentId)
    expect(h.toAgentId).toBe(toAgentId)
    expect(JSON.parse(h.dossierJson)).toHaveLength(1)
    expect(JSON.parse(h.guaranteesJson).completeness).toBe('PARTIAL')
    const ev = await db.eventRecord.findFirst({ where: { type: 'handoff.created', subject: `handoff:${h.id}` } })
    expect(ev).not.toBeNull()
    const audit = await db.auditRecord.findFirst({ where: { entityType: 'HANDOFF', entityId: h.id, action: 'handoff.create' } })
    expect(audit).not.toBeNull()
    expect(audit!.thisHash).toMatch(/^[0-9a-f]{64}$/) // sellado por la cadena P0-1
  })

  test('dossier con evidencia fantasma → fail-closed: el traspaso NO se formaliza (TPR)', async () => {
    const before = await db.handoff.count()
    const res = await createHandoff([EVID_OK, EVID_FANTASMA])
    expect(res.ok).toBe(false)
    expect(res.status).toBe('FAILED')
    expect(res.error).toContain('HANDOFF_EVIDENCE_NOT_VERIFIED:items=1')
    expect(await db.handoff.count()).toBe(before) // ni un registro: el expediente no viaja
  })

  test('ACK del receptor agente → ACKNOWLEDGED con evento y auditoría', async () => {
    const res = await createHandoff([EVID_OK])
    expect(res.ok).toBe(true)
    const handoffId = String(res.result!.handoffId)
    const ack = await dispatchCommand({
      type: 'handoff.ack', payload: { handoffId, note: 'Recibido y revisado' },
      requesterId: toAgentId, requesterType: 'AGENT',
    })
    expect(ack.ok).toBe(true)
    const h = await db.handoff.findUniqueOrThrow({ where: { id: handoffId } })
    expect(h.status).toBe('ACKNOWLEDGED')
    expect(h.ackedAt).not.toBeNull()
    const ev = await db.eventRecord.findFirst({ where: { type: 'handoff.acknowledged', subject: `handoff:${handoffId}` } })
    expect(ev).not.toBeNull()
  })

  test('ACK por un tercero agente → prohibido (entrega no es recepción)', async () => {
    const res = await createHandoff([EVID_OK])
    expect(res.ok).toBe(true)
    const handoffId = String(res.result!.handoffId)
    const ack = await dispatchCommand({
      type: 'handoff.ack', payload: { handoffId },
      requesterId: thirdAgentId, requesterType: 'AGENT',
    })
    expect(ack.ok).toBe(false)
    expect(ack.error).toContain('HANDOFF_ACK_FORBIDDEN')
    const h = await db.handoff.findUniqueOrThrow({ where: { id: handoffId } })
    expect(h.status).toBe('CREATED') // sigue pendiente del receptor real
  })

  test('rechazo del receptor con motivo → REJECTED y auditado', async () => {
    const res = await createHandoff([EVID_OK])
    expect(res.ok).toBe(true)
    const handoffId = String(res.result!.handoffId)
    const rej = await dispatchCommand({
      type: 'handoff.reject', payload: { handoffId, reason: 'Falta el anexo del acta previa' },
      requesterId: toAgentId, requesterType: 'AGENT',
    })
    expect(rej.ok).toBe(true)
    const h = await db.handoff.findUniqueOrThrow({ where: { id: handoffId } })
    expect(h.status).toBe('REJECTED')
    expect(h.ackNote).toContain('anexo')
    const audit = await db.auditRecord.findFirst({ where: { entityType: 'HANDOFF', entityId: handoffId, action: 'handoff.reject' } })
    expect(audit).not.toBeNull()
  })

  test('handoff.create exige agentes existentes y distintos (validación de dominio)', async () => {
    const res = await dispatchCommand({
      type: 'handoff.create',
      payload: { fromAgentId: 'no-existe', toAgentId: 'tampoco', subject: 'Traspaso inválido', dossier: [EVID_OK] },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('HANDOFF_FROM_AGENT_NOT_FOUND')
  })
})
