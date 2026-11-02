// ============================================================
// EEC V2 — P0-2: EVIDENCE GATE fail-closed (doc 07 §3.2)
// bun test tests/eec-v2/p0-evidence.test.ts
// Anti-alucinación estilo "phantom citation test" del gemelo:
//  - salida exigente sin evidencia → BLOCKED_MISSING_EVIDENCE (TPR)
//  - evidencia fantasma (sin hash/verifiedAt) → bloqueada (TPR)
//  - evidencia verificada → pasa (TNR)
//  - sin claimTags reclamados → el gate no aplica
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { z } from 'zod'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand, registerCommandHandler } from '../../src/lib/eec/commands/pipeline'
import { setSimulationMode } from '../../src/lib/eec/commands'
import { COMMAND_SCHEMAS } from '../../src/lib/eec/commands/registry'
import { evaluateEvidenceGate } from '../../src/lib/eec/security/evidence'

const SFX = Date.now().toString(36)
const CMD_CLAIM = `test.evidence.claim.${SFX}`
let policyId = ''

const EVIDENCIA_OK = [{
  id: 'ev-1', source: 'registro:oficial', kind: 'record',
  hash: 'a'.repeat(64), verifiedAt: new Date().toISOString(),
}]

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
  // comando de prueba: la salida declara claimTags según el modo
  COMMAND_SCHEMAS[CMD_CLAIM] = z.object({
    mode: z.enum(['sin_evidencia', 'con_evidencia', 'tag_no_reclamado', 'evidencia_fantasma']),
  })
  registerCommandHandler(CMD_CLAIM, async ({ payload }) => {
    const m = (payload as { mode: string }).mode
    if (m === 'con_evidencia') return { claimTags: ['legal-assertion'], evidence: EVIDENCIA_OK }
    if (m === 'evidencia_fantasma') return { claimTags: ['legal-assertion'], evidence: [{ id: 'ev-phantom', source: 'inventado', kind: 'record' }] }
    if (m === 'tag_no_reclamado') return { claimTags: ['otro-tag'] }
    return { claimTags: ['legal-assertion'] }
  })
  const pol = await db.policy.create({
    data: {
      code: `TST-EVID-${SFX}`, name: 'Evidence Gate de prueba (P0-2)',
      type: 'EVIDENCE', effect: 'REQUIRE',
      actionJson: JSON.stringify([CMD_CLAIM]),
      conditionsJson: JSON.stringify({ claimTags: ['legal-assertion'], minVerified: 1 }),
      priority: 5,
    },
  })
  policyId = pol.id
})

afterAll(async () => {
  delete COMMAND_SCHEMAS[CMD_CLAIM]
  if (policyId) await db.policy.delete({ where: { id: policyId } }).catch(() => undefined)
  await db.$disconnect()
})

async function dispatch(mode: string) {
  return dispatchCommand({
    type: CMD_CLAIM,
    payload: { mode },
    requesterId: 'operator',
    requesterType: 'HUMAN',
  })
}

describe('P0-2 Evidence Gate', () => {
  test('salida exigente SIN evidencia → BLOCKED_MISSING_EVIDENCE, no se publica ni ejecuta', async () => {
    const res = await dispatch('sin_evidencia')
    expect(res.ok).toBe(false)
    expect(res.status).toBe('BLOCKED_MISSING_EVIDENCE')
    expect(res.error).toBe('missing_verified_evidence')
    const cmd = await db.commandRecord.findUniqueOrThrow({ where: { id: res.commandId } })
    expect(cmd.status).toBe('BLOCKED_MISSING_EVIDENCE')
    expect(cmd.rejectionReason).toContain(`evidence_gate:TST-EVID-${SFX}`)
    // evento de bloqueo publicado; evento de ejecución NO publicado
    const blocked = await db.eventRecord.findMany({ where: { type: 'evidence.missing' }, orderBy: { seq: 'desc' }, take: 5 })
    expect(blocked.length).toBeGreaterThanOrEqual(1)
    const executed = await db.eventRecord.count({
      where: { type: 'system.command.executed', payloadJson: { contains: res.commandId } },
    })
    expect(executed).toBe(0)
    // el bloqueo queda AUDITADO y sellado por la cadena hash (P0-1 + P0-2 integrados)
    const audits = await db.auditRecord.findMany({ where: { action: 'command.evidence.blocked' }, orderBy: { createdAt: 'desc' }, take: 1 })
    expect(audits.length).toBe(1)
    expect(audits[0].thisHash).toMatch(/^[0-9a-f]{64}$/)
    expect(audits[0].result).toBe('BLOCKED_MISSING_EVIDENCE')
  })

  test('evidencia fantasma (sin hash/verifiedAt) → bloqueada: TPR anti-alucinación', async () => {
    const res = await dispatch('evidencia_fantasma')
    expect(res.ok).toBe(false)
    expect(res.status).toBe('BLOCKED_MISSING_EVIDENCE')
    expect(JSON.stringify(res.result)).toContain('ev-phantom') // la salida se conserva como evidencia del intento
    const cmd = await db.commandRecord.findUniqueOrThrow({ where: { id: res.commandId } })
    expect(cmd.rejectionReason).toContain('verified_evidence:0/1')
    expect(cmd.rejectionReason).toContain('evidence_sin_verificar_presente')
  })

  test('evidencia verificada → EXECUTED (TNR): el trabajo legítimo no se bloquea', async () => {
    const res = await dispatch('con_evidencia')
    expect(res.ok).toBe(true)
    expect(res.status).toBe('EXECUTED')
    const cmd = await db.commandRecord.findUniqueOrThrow({ where: { id: res.commandId } })
    expect(cmd.status).toBe('EXECUTED')
  })

  test('sin claimTags reclamados el gate no aplica (neutralidad de dominio)', async () => {
    const res = await dispatch('tag_no_reclamado')
    expect(res.ok).toBe(true)
    expect(res.status).toBe('EXECUTED')
  })

  test('evaluateEvidenceGate unitario: tipos sin política no requieren evidencia', async () => {
    const d1 = await evaluateEvidenceGate('comando.sin.politica', { claimTags: ['legal-assertion'] })
    expect(d1.required).toBe(false)
    expect(d1.ok).toBe(true)
    const d2 = await evaluateEvidenceGate('comando.sin.politica', {})
    expect(d2.required).toBe(false)
  })
})
