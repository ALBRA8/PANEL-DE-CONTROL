// ============================================================
// EEC V2 — P2-2: DOCTOR DEL SISTEMA (doc 07 matriz #26)
// bun test tests/eec-v2/p2-doctor.test.ts
// Verificaciones REALES contra el estado vivo: quick_check, cadena
// hash, pragmas, aprobaciones, dead-letters, frontera INSTALADOR,
// políticas de evidencia y administración por organización.
// El doctor solo lee: NUNCA repara.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { setSimulationMode } from '../../src/lib/eec/commands'
import { runDoctor } from '../../src/lib/eec/engine/doctor'

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('P2-2 doctor del sistema', () => {
  test('ejecuta las 10 verificaciones reales con estado y coste temporal', async () => {
    const report = await runDoctor()
    expect(report.checks).toHaveLength(10)
    const ids = report.checks.map(c => c.id)
    expect(new Set(ids).size).toBe(10) // ids únicos
    for (const c of report.checks) {
      expect(['OK', 'WARN', 'FAIL']).toContain(c.status)
      expect(c.detail.length).toBeGreaterThan(0)
      expect(c.ms).toBeGreaterThanOrEqual(0)
    }
    expect(['OK', 'WARN', 'FAIL']).toContain(report.overall)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('la BD está íntegra: quick_check ok y cadena hash sin rupturas', async () => {
    const report = await runDoctor()
    const quick = report.checks.find(c => c.id === 'db-quick-check')!
    expect(quick.status).toBe('OK')
    const chain = report.checks.find(c => c.id === 'audit-chain')!
    expect(chain.status).not.toBe('FAIL') // la cadena puede tener legacy sin sello (WARN), pero NO rota
    expect(chain.detail).not.toContain('ROTA')
  })

  test('el veredicto global es el peor estado de los checks (OK<WARN<FAIL)', async () => {
    const report = await runDoctor()
    const rank = { OK: 0, WARN: 1, FAIL: 2 } as const
    const worst = report.checks.reduce((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc), 'OK' as const)
    expect(report.overall).toBe(worst)
  })

  test('el doctor es solo lectura: no crea auditoría ni eventos', async () => {
    const auditsBefore = await db.auditRecord.count()
    const eventsBefore = await db.eventRecord.count()
    await runDoctor()
    await runDoctor()
    expect(await db.auditRecord.count()).toBe(auditsBefore)
    expect(await db.eventRecord.count()).toBe(eventsBefore)
  })
})
