// ============================================================
// EEC V2 — P0-1: CADENA HASH DE AUDITORÍA (doc 07 §3.1)
// bun test tests/eec-v2/p0-chain.test.ts
// Sello en writeAudit, verificación incremental, detección de
// manipulación (tamper) y correcciones encadenadas inmutables.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { writeAudit, correctAudit } from '../../src/lib/eec/engine/audit'
import { verifyAuditChain, canonicalJson, hashSealPayload } from '../../src/lib/eec/engine/audit-chain'

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
})

afterAll(async () => {
  await db.$disconnect()
})

describe('P0-1 cadena hash de auditoría', () => {
  test('canonicalJson es estable ante orden de claves y conserva orden de arrays', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
    expect(canonicalJson({ x: [3, 1, 2] })).toBe('{"x":[3,1,2]}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('hola')).toBe('"hola"')
  })

  test('los registros se sellan encadenados y el rango verifica OK', async () => {
    const anchor = await db.auditRecord.findFirst({
      where: { chainSeq: { not: null } }, orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true, thisHash: true },
    })
    const fromSeq = (anchor?.chainSeq ?? 0) + 1
    const ids: string[] = []
    for (let i = 1; i <= 3; i++) {
      ids.push(await writeAudit({
        actorId: 'TST-chain', actorType: 'SYSTEM', action: `test.chain.${i}`,
        entityType: 'TEST', entityId: 'chain', input: { n: i },
        output: { step: i },
      }))
    }
    const recs = await db.auditRecord.findMany({ where: { id: { in: ids } }, orderBy: { chainSeq: 'asc' } })
    expect(recs.length).toBe(3)
    expect(recs[0].chainSeq).toBe(fromSeq)
    expect(recs[0].prevHash).toBe(anchor?.thisHash ?? null)
    expect(recs[1].prevHash).toBe(recs[0].thisHash)
    expect(recs[2].prevHash).toBe(recs[1].thisHash)
    for (const r of recs) {
      expect(r.thisHash).toMatch(/^[0-9a-f]{64}$/)
      // el hash es recalculable desde el contenido público (verificabilidad externa)
      expect(hashSealPayload(r as never, r.prevHash)).toBe(r.thisHash)
    }
    const v1 = await verifyAuditChain(fromSeq)
    expect(v1.ok).toBe(true)
    expect(v1.verified).toBe(3)
    expect(v1.brokenAt).toHaveLength(0)
  })

  test('la manipulación de un registro rompe la cadena y la verificación lo declara', async () => {
    const anchor = await db.auditRecord.findFirst({
      where: { chainSeq: { not: null } }, orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true },
    })
    const fromSeq = (anchor?.chainSeq ?? 0) + 1
    const idA = await writeAudit({ actorId: 'TST-tamper', actorType: 'SYSTEM', action: 'test.tamper.a', entityType: 'TEST', entityId: 'tamper', output: { original: true } })
    const idB = await writeAudit({ actorId: 'TST-tamper', actorType: 'SYSTEM', action: 'test.tamper.b', entityType: 'TEST', entityId: 'tamper', output: { original: true } })
    const idC = await writeAudit({ actorId: 'TST-tamper', actorType: 'SYSTEM', action: 'test.tamper.c', entityType: 'TEST', entityId: 'tamper', output: { original: true } })
    const victim = await db.auditRecord.findUniqueOrThrow({ where: { id: idB } })
    const original = victim.outputJson

    // TAMPER 1 — edición silenciosa del contenido: detectada por hash_mismatch.
    // (el thisHash almacenado no cambia, así que C sigue enlazado al valor sellado)
    await db.auditRecord.update({ where: { id: idB }, data: { outputJson: '{"hacked":true}' } })
    const v2 = await verifyAuditChain(fromSeq)
    expect(v2.ok).toBe(false)
    expect(v2.brokenAt.some(b => b.id === idB && b.reason === 'hash_mismatch')).toBe(true)
    expect(v2.brokenAt.some(b => b.id === idA)).toBe(false) // el registro anterior sigue íntegro
    // RESTAURACIÓN exacta (no re-escritura creativa): la cadena vuelve a verificar
    await db.auditRecord.update({ where: { id: idB }, data: { outputJson: original } })
    expect((await verifyAuditChain(fromSeq)).ok).toBe(true)

    // TAMPER 2 — re-sellado malicioso (el atacante recalcula el hash de B):
    // el eslabón siguiente C ya NO coincide con el nuevo thisHash de B
    await db.auditRecord.update({
      where: { id: idB },
      data: { outputJson: '{"hacked":true}', thisHash: 'f'.repeat(64) },
    })
    const v3 = await verifyAuditChain(fromSeq)
    expect(v3.ok).toBe(false)
    expect(v3.brokenAt.some(b => b.id === idB && b.reason === 'hash_mismatch')).toBe(true)
    expect(v3.brokenAt.some(b => b.id === idC && b.reason === 'prevHash_mismatch')).toBe(true)
    // RESTAURACIÓN completa del eslabón B al valor sellado original
    await db.auditRecord.update({
      where: { id: idB },
      data: { outputJson: original, thisHash: victim.thisHash },
    })
    expect((await verifyAuditChain(fromSeq)).ok).toBe(true)
  })

  test('correctAudit crea registro NUEVO encadenado sin mutar el previo', async () => {
    const anchor = await db.auditRecord.findFirst({
      where: { chainSeq: { not: null } }, orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true },
    })
    const fromSeq = (anchor?.chainSeq ?? 0) + 1
    const prevId = await writeAudit({ actorId: 'TST-corr', actorType: 'SYSTEM', action: 'test.corr.original', entityType: 'TEST', entityId: 'corr', output: { valor: 'mal' } })
    const prevBefore = await db.auditRecord.findUniqueOrThrow({ where: { id: prevId } })
    const corrId = await correctAudit(prevId, {
      actorId: 'TST-corr', actorType: 'SYSTEM', action: 'test.corr.corregido',
      entityType: 'TEST', entityId: 'corr', output: { valor: 'bien' },
    }, 'corrección de dato erróneo')
    const corr = await db.auditRecord.findUniqueOrThrow({ where: { id: corrId } })
    expect(corr.prevAuditId).toBe(prevId)
    expect(corr.why).toBe('correction:corrección de dato erróneo')
    const prevAfter = await db.auditRecord.findUniqueOrThrow({ where: { id: prevId } })
    expect(prevAfter.outputJson).toBe(prevBefore.outputJson) // el previo NO se muta
    const v = await verifyAuditChain(fromSeq)
    expect(v.ok).toBe(true)
  })

  test('verificación por rango intermedio usa el ancla previa', async () => {
    const recs = await db.auditRecord.findMany({
      where: { chainSeq: { not: null } }, orderBy: { chainSeq: 'asc' },
      select: { chainSeq: true, id: true },
    })
    expect(recs.length).toBeGreaterThanOrEqual(2)
    const mid = recs[Math.floor(recs.length / 2)]
    const v = await verifyAuditChain(mid.chainSeq as number)
    expect(v.ok).toBe(true)
    expect(v.checked).toBeGreaterThanOrEqual(1)
  })
})
