// ============================================================
// EEC V2 — P0-3: QUÓRUM HUMANO (minimumHumanSignoff · doc 07 §3.3)
// bun test tests/eec-v2/p0-quorum.test.ts
// La política exige N firmas HUMANAS DISTINTAS: sin quórum el comando
// no se reanuda; la firma duplicada se rechaza; al alcanzar el quórum
// se aprueba y reanuda. Todo queda auditado.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand } from '../../src/lib/eec/commands/pipeline'
import { setSimulationMode } from '../../src/lib/eec/commands'

const SFX = Date.now().toString(36)
let policyId = ''
let notificationId = ''
const approvalIds: string[] = []

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
  const pol = await db.policy.create({
    data: {
      code: `TST-QUORUM-${SFX}`, name: 'Quórum de prueba (P0-3)',
      type: 'APPROVAL', effect: 'REQUIRE_APPROVAL',
      actionJson: JSON.stringify(['notification.read']),
      conditionsJson: JSON.stringify({ minHumanSignoff: 2 }),
      priority: 5,
    },
  })
  policyId = pol.id
  const notif = await db.notification.create({ data: { type: 'TEST', title: `TST quórum ${SFX}`, sim: true } })
  notificationId = notif.id
})

afterAll(async () => {
  await db.approval.deleteMany({ where: { id: { in: approvalIds } } }).catch(() => undefined)
  if (notificationId) await db.notification.delete({ where: { id: notificationId } }).catch(() => undefined)
  if (policyId) await db.policy.delete({ where: { id: policyId } }).catch(() => undefined)
  await db.$disconnect()
})

/** Dispara notification.read como HUMAN → la política APPROVAL fuerza el gate con quórum 2. */
async function requestQuorumApproval(): Promise<{ commandId: string; approvalId: string }> {
  const res = await dispatchCommand({
    type: 'notification.read',
    payload: { notificationId },
    requesterId: 'operator',
    requesterType: 'HUMAN',
  })
  expect(res.ok).toBe(false)
  expect(res.error).toBe('approval_required')
  expect(res.approvalId).toBeTruthy()
  approvalIds.push(res.approvalId!)
  return { commandId: res.commandId, approvalId: res.approvalId! }
}

describe('P0-3 quórum humano', () => {
  test('el gate del pipeline exige el quórum declarado por la política', async () => {
    const { commandId, approvalId } = await requestQuorumApproval()
    const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } })
    expect(approval.minimumHumanSignoff).toBe(2)
    expect(approval.status).toBe('REQUESTED')
    expect(JSON.parse(approval.signaturesJson)).toHaveLength(0)
    const cmd = await db.commandRecord.findUniqueOrThrow({ where: { id: commandId } })
    expect(cmd.status).toBe('POLICY_CHECKED') // NO se despacha sin quórum
  })

  test('1ª firma → AWAITING_SIGNOFF · duplicada → rechazada · 2ª firma distinta → APPROVED y reanudación', async () => {
    const { approvalId } = await requestQuorumApproval()

    // 1ª firma (alice): sin quórum — la solicitud permanece REQUESTED
    const r1 = await dispatchCommand({ type: 'approval.approve', payload: { approvalId, note: 'visto bueno inicial' }, requesterId: 'alice', requesterType: 'HUMAN' })
    expect(r1.ok).toBe(true)
    expect(r1.result?.status).toBe('AWAITING_SIGNOFF')
    expect(r1.result?.signatures).toBe(1)
    expect(r1.result?.required).toBe(2)
    let approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } })
    expect(approval.status).toBe('REQUESTED')
    expect(JSON.parse(approval.signaturesJson)).toHaveLength(1)

    // firma duplicada de alice: rechazada (quórum = sujetos DISTINTOS)
    const r2 = await dispatchCommand({ type: 'approval.approve', payload: { approvalId }, requesterId: 'alice', requesterType: 'HUMAN' })
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('APPROVAL_ALREADY_SIGNED_BY:alice')
    approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } })
    expect(JSON.parse(approval.signaturesJson)).toHaveLength(1) // sin cambios

    // 2ª firma (bob): quórum alcanzado → APPROVED + reanudación del comando
    const r3 = await dispatchCommand({ type: 'approval.approve', payload: { approvalId, note: 'segunda firma' }, requesterId: 'bob', requesterType: 'HUMAN' })
    expect(r3.ok).toBe(true)
    expect(r3.result?.status).toBe('APPROVED')
    expect(r3.result?.resumed?.status).toBe('EXECUTED')
    approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } })
    expect(approval.status).toBe('APPROVED')
    expect(approval.decidedById).toBe('bob')
    const signatures = JSON.parse(approval.signaturesJson)
    expect(signatures).toHaveLength(2)
    expect(signatures.map((s: { by: string }) => s.by).sort()).toEqual(['alice', 'bob'])

    // el comando reanudado se ejecutó de verdad (notificación marcada leída)
    const resumedId = (r3.result?.resumed as { commandId?: string })?.commandId
    expect(resumedId).toBeTruthy()
    const resumed = await db.commandRecord.findUniqueOrThrow({ where: { id: resumedId! } })
    expect(resumed.status).toBe('EXECUTED')
    const notif = await db.notification.findUniqueOrThrow({ where: { id: notificationId } })
    expect(notif.readAt).not.toBeNull()
  })

  test('cada firma intermedia queda auditada y publicada en el bus', async () => {
    const events = await db.eventRecord.findMany({ where: { type: 'approval.signature.recorded' }, orderBy: { seq: 'desc' }, take: 10 })
    expect(events.length).toBeGreaterThanOrEqual(1)
    const audits = await db.auditRecord.findMany({ where: { action: 'approval.signature.recorded' }, orderBy: { createdAt: 'desc' }, take: 10 })
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0].result).toBe('AWAITING_SIGNOFF')
    // la auditoría de firmas forma parte de la cadena hash (P0-1)
    expect(audits[0].thisHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
