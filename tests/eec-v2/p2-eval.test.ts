// ============================================================
// EEC V2 — P2-1: EVAL HARNESS CON RÚBRICAS (doc 07 matriz #13)
// bun test tests/eec-v2/p2-eval.test.ts
// Runner determinístico (essential/forbidden/bonus, regex puro, sin
// LLM en el lazo de verificación): mismo input → mismo veredicto.
// eval.run queda auditado y sellado en la cadena hash (PASS y FAIL).
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand, setSimulationMode } from '../../src/lib/eec/commands'
import { runRubric, validateRubric, type Rubric } from '../../src/lib/eec/eval/rubrics'

const SFX = Date.now().toString(36)

const RUBRIC: Rubric = {
  name: `TST-RUB-${SFX}`,
  description: 'Rúbrica de prueba P2-1',
  essential: [
    { id: 'ess-resumen', description: 'contiene sección de resumen', pattern: 'resumen' },
    { id: 'ess-cierre', description: 'declara cierre del informe', pattern: 'cierre' },
  ],
  forbidden: [
    { id: 'for-placeholder', description: 'sin placeholders pendientes', pattern: 'TODO|por completar' },
  ],
  bonus: [
    { id: 'bon-fecha', description: 'incluye fecha del acto', pattern: /\d{4}-\d{2}-\d{2}/.source, points: 2 },
    { id: 'bon-firma', description: 'incluye firma responsable', pattern: 'firma', points: 1 },
  ],
}

const GOOD_OUTPUT = 'RESUMEN de la actuación con fecha 2026-11-06. CIERRE conforme. Firma: Secretaría.'
const BARE_OUTPUT = 'RESUMEN breve. CIERRE conforme.' // sin bonus
const BAD_OUTPUT = 'El informe quedó por completar, faltan secciones.' // esencial falla + prohibido

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('P2-1 runner de rúbricas (determinístico)', () => {
  test('validateRubric: rúbrica válida pasa; regex inválida, ids duplicados y puntos malos se rechazan', () => {
    expect(validateRubric(RUBRIC)).toBeNull()
    expect(validateRubric(null)).toBe('rubric_not_an_object')
    expect(validateRubric({ ...RUBRIC, name: '' })).toBe('rubric_name_invalid')
    expect(validateRubric({ ...RUBRIC, essential: [{ id: 'x', description: 'd', pattern: '([' }] })).toContain('regex_invalid')
    expect(validateRubric({ ...RUBRIC, essential: [
      { id: 'x', description: 'a', pattern: 'a' }, { id: 'x', description: 'b', pattern: 'b' },
    ] })).toBe('rubric_essential_id_duplicated:x')
    expect(validateRubric({ ...RUBRIC, bonus: [{ id: 'b', description: 'd', pattern: 'x', points: -1 }] })).toBe('rubric_bonus_points_invalid:b')
  })

  test('salida completa → PASS con bonus completo (70 + 30 = 100) y determinismo', () => {
    const a = runRubric(RUBRIC, { text: GOOD_OUTPUT })
    const b = runRubric(RUBRIC, { text: GOOD_OUTPUT })
    expect(a.verdict).toBe('PASS')
    expect(a.score).toBe(100)
    expect(a.bonusEarned).toBe(3)
    expect(a.bonusMax).toBe(3)
    expect(a.score).toBe(b.score) // determinista
    expect(a.checks.filter(c => c.kind === 'essential').every(c => c.hit)).toBe(true)
  })

  test('salida mínima → PASS con bonus parcial (70 + 30 * 0/3 = 70)', () => {
    const r = runRubric(RUBRIC, { text: BARE_OUTPUT })
    expect(r.verdict).toBe('PASS')
    expect(r.score).toBe(70)
    expect(r.bonusEarned).toBe(0)
  })

  test('esencial incumplida Y prohibido presente → FAIL con score 0 y trazas de motivo', () => {
    const r = runRubric(RUBRIC, { text: BAD_OUTPUT })
    expect(r.verdict).toBe('FAIL')
    expect(r.score).toBe(0)
    expect(r.failedEssential).toContain('ess-resumen')
    expect(r.hitForbidden).toContain('for-placeholder')
  })

  test('rúbrica sin bonus → PASS = 100 directo', () => {
    const r = runRubric({ ...RUBRIC, bonus: [] }, { text: BARE_OUTPUT })
    expect(r.verdict).toBe('PASS')
    expect(r.score).toBe(100)
  })
})

describe('P2-1 comando eval.run (auditado y sellado)', () => {
  test('PASS queda auditado con sello de cadena hash', async () => {
    const res = await dispatchCommand({
      type: 'eval.run',
      payload: { label: `piloto-${SFX}`, rubric: RUBRIC, output: { text: GOOD_OUTPUT } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(res.ok).toBe(true)
    expect(res.result?.verdict).toBe('PASS')
    expect(res.result?.score).toBe(100)

    const audit = await db.auditRecord.findFirst({
      where: { action: 'eval.run', entityType: 'EVAL', entityId: `piloto-${SFX}` },
    })
    expect(audit).not.toBeNull()
    expect(audit!.result).toBe('PASS')
    expect(audit!.chainSeq).not.toBeNull()
    expect(audit!.thisHash).toBeTruthy()
  })

  test('FAIL también queda auditado (la escritura pública registra el veredicto malo)', async () => {
    const res = await dispatchCommand({
      type: 'eval.run',
      payload: { label: `piloto-fail-${SFX}`, rubric: RUBRIC, output: { text: BAD_OUTPUT } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(res.ok).toBe(true) // el comando SE EJECUTA: el veredicto es FAIL, no error del sistema
    expect(res.result?.verdict).toBe('FAIL')
    const audit = await db.auditRecord.findFirst({
      where: { action: 'eval.run', entityType: 'EVAL', entityId: `piloto-fail-${SFX}` },
    })
    expect(audit!.result).toBe('FAIL')
    expect(audit!.chainSeq).not.toBeNull()
  })

  test('rúbrica inválida → rechazada fail-closed en DOS capas (zod del pipeline y handler)', async () => {
    // capa 1: schema zod del registry rechaza id vacío antes de despachar
    const zod = await dispatchCommand({
      type: 'eval.run',
      payload: { label: `piloto-bad-${SFX}`, rubric: { ...RUBRIC, essential: [{ id: '', description: 'x', pattern: 'y' }] }, output: { text: 'x' } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(zod.ok).toBe(false)
    expect(zod.error).toContain('validation_failed')

    // capa 2: el handler valida semántica que zod no cubre (regex compilable)
    const sem = await dispatchCommand({
      type: 'eval.run',
      payload: { label: `piloto-bad-${SFX}`, rubric: { ...RUBRIC, essential: [{ id: 'x', description: 'regex rota', pattern: '(' }] }, output: { text: 'x' } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(sem.ok).toBe(false)
    expect(sem.error).toContain('EVAL_RUBRIC_INVALID')
  })
})
