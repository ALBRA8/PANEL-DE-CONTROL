// ============================================================
// EEC V2 — P2-3: PROVENANCE DE EVIDENCIA (doc 07 matriz #15)
// bun test tests/eec-v2/p2-provenance.test.ts
// Campos hash/source/verifiedAt con DIENTES: hash SHA-256 (64 hex),
// verifiedAt parseable y no futuro; atestiguamiento canónico
// (attestEvidence) y diagnóstico detallado (provenanceStatus).
// El Evidence Gate (P0-2) pasa a usar el criterio estricto.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { setSimulationMode } from '../../src/lib/eec/commands'
import {
  isVerifiedEvidence,
  attestEvidence,
  provenanceStatus,
  provenanceReport,
  evaluateEvidenceGate,
} from '../../src/lib/eec/security/evidence'

const SFX = Date.now().toString(36)
let policyId = ''

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
  const pol = await db.policy.create({
    data: {
      code: `TST-PROV-${SFX}`, name: 'Evidencia exigente de prueba (P2-3)',
      type: 'EVIDENCE', effect: 'REQUIRE',
      actionJson: JSON.stringify(['provenance.probe']),
      conditionsJson: JSON.stringify({ minVerified: 1 }),
      priority: 5,
    },
  })
  policyId = pol.id
})

afterAll(async () => {
  if (policyId) await db.policy.delete({ where: { id: policyId } }).catch(() => undefined)
  await db.$disconnect()
})

describe('P2-3 attestEvidence (atestiguamiento canónico)', () => {
  test('produce hash SHA-256 64-hex + verifiedAt ISO, y el criterio estricto lo acepta', () => {
    const ev = attestEvidence({ id: 'ev-1', source: 'expediente:test', kind: 'record', content: 'contenido evidenciado' })
    expect(ev.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(new Date(ev.verifiedAt!).getTime()).not.toBeNaN()
    expect(isVerifiedEvidence(ev)).toBe(true)
    // determinismo del hash: mismo contenido → mismo hash
    const ev2 = attestEvidence({ id: 'ev-2', source: 'otra', kind: 'record', content: 'contenido evidenciado' })
    expect(ev2.hash).toBe(ev.hash)
  })

  test('contenido distinto → hash distinto (provenance real, no decorativo)', () => {
    const a = attestEvidence({ id: 'a', source: 's', kind: 'k', content: 'texto A' })
    const b = attestEvidence({ id: 'b', source: 's', kind: 'k', content: 'texto B' })
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('P2-3 criterio estricto de provenance', () => {
  const GOOD = { id: 'g', source: 's', kind: 'k', hash: 'a'.repeat(64), verifiedAt: new Date().toISOString() }

  test('hash malformado (no 64-hex) → MALFORMED y rechazado', () => {
    for (const hash of ['abc123', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)]) {
      const s = provenanceStatus({ ...GOOD, hash })
      expect(s.status).toBe('MALFORMED')
      expect(s.reasons).toContain('hash_format_invalid')
      expect(isVerifiedEvidence({ ...GOOD, hash })).toBe(false)
    }
  })

  test('verifiedAt en el futuro o no parseable → MALFORMED', () => {
    const future = provenanceStatus({ ...GOOD, verifiedAt: new Date(Date.now() + 2 * 3600_000).toISOString() })
    expect(future.status).toBe('MALFORMED')
    expect(future.reasons).toContain('verifiedAt_in_future')
    const junk = provenanceStatus({ ...GOOD, verifiedAt: 'ayer' })
    expect(junk.status).toBe('MALFORMED')
    expect(junk.reasons).toContain('verifiedAt_unparseable')
  })

  test('campos ausentes → INCOMPLETE con motivo específico', () => {
    expect(provenanceStatus({ id: 'x' }).status).toBe('INCOMPLETE')
    expect(provenanceStatus({ id: 'x' }).reasons).toEqual(expect.arrayContaining(['missing_source', 'missing_hash', 'missing_verifiedAt']))
    expect(provenanceStatus({ ...GOOD, hash: undefined }).reasons).toContain('missing_hash')
    expect(provenanceStatus(null).status).toBe('MALFORMED')
    expect(isVerifiedEvidence(GOOD)).toBe(true)
  })

  test('provenanceReport resume una lista mixta', () => {
    const rep = provenanceReport([
      GOOD,
      { id: 'ghost' },                      // incomplete
      { ...GOOD, hash: 'bad' },             // malformed
      'texto suelto',                       // malformed (no objeto)
    ])
    expect(rep.verified).toBe(1)
    expect(rep.incomplete).toBe(1)
    expect(rep.malformed).toBe(2)
  })
})

describe('P2-3 integración con el Evidence Gate (P0-2)', () => {
  test('evidencia atestiguada → el gate la cuenta; evidencia malformada → bloquea con resumen', async () => {
    const ok = await evaluateEvidenceGate('provenance.probe', {
      evidence: [attestEvidence({ id: 'e1', source: 's', kind: 'k', content: 'doc' })],
    })
    expect(ok.required).toBe(true)
    expect(ok.ok).toBe(true)
    expect(ok.provenance?.verified).toBe(1)
    expect(ok.provenance?.total).toBe(1)

    const bad = await evaluateEvidenceGate('provenance.probe', {
      evidence: [{ id: 'ghost', source: 's', hash: 'corto', verifiedAt: 'nunca' }],
    })
    expect(bad.required).toBe(true)
    expect(bad.ok).toBe(false)
    expect(bad.missing).toContain('verified_evidence:0/1')
    expect(bad.missing).toContain('evidence_sin_verificar_presente')
    expect(bad.provenance?.malformed).toBe(1)
  })
})
