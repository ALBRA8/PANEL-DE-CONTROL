// ============================================================
// EEC — EVAL HARNESS CON RÚBRICAS (P2-1 · doc 07 matriz #13)
// Runner DETERMINÍSTICO de rúbricas esenciales/prohibidas/bonus
// (patrón del gemelo DESPACHO, generalizado al ecosistema):
//  - essential: TODAS deben cumplirse (patrón presente en la salida).
//  - forbidden: NINGUNA puede aparecer (regex sobre la salida).
//  - bonus: puntos adicionales por calidad declarada.
// Sin LLM en el lazo de verificación: puro regex + aritmética —
// mismo input → mismo veredicto, auditable y reproducible.
// Escala: PASS → base 70 + hasta 30 por bonus (bonusMax 0 → 100).
//         FAIL → 0 (esencial incumplida o prohibido presente).
// ============================================================

export interface RubricItem {
  id: string
  description: string
  /** regex (case-insensitive) evaluada sobre el texto de la salida */
  pattern: string
  /** solo bonus: puntos que aporta (total bonus se escala a 30) */
  points?: number
}

export interface Rubric {
  name: string
  description?: string
  essential: RubricItem[]
  forbidden: RubricItem[]
  bonus: RubricItem[]
}

export interface RubricCheckResult {
  id: string
  kind: 'essential' | 'forbidden' | 'bonus'
  description: string
  hit: boolean
  points?: number
}

export interface RubricResult {
  rubric: string
  verdict: 'PASS' | 'FAIL'
  score: number
  failedEssential: string[]
  hitForbidden: string[]
  bonusEarned: number
  bonusMax: number
  checks: RubricCheckResult[]
  evaluatedAt: string
}

const BASE_PASS_SCORE = 70
const BONUS_SCALE = 30

/** Valida la rúbrica ANTES de ejecutarla (fail-closed): regex compilables, ids únicos. Devuelve error o null. */
export function validateRubric(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'rubric_not_an_object'
  const rub = r as Record<string, unknown>
  if (typeof rub.name !== 'string' || rub.name.length < 2 || rub.name.length > 80) return 'rubric_name_invalid'
  for (const [field, withPoints] of [
    ['essential', false], ['forbidden', false], ['bonus', true],
  ] as const) {
    const arr = rub[field]
    if (!Array.isArray(arr)) return `rubric_${field}_not_array`
    const ids = new Set<string>()
    for (const it of arr as unknown[]) {
      if (!it || typeof it !== 'object') return `rubric_${field}_item_invalid`
      const item = it as Record<string, unknown>
      if (typeof item.id !== 'string' || item.id.length === 0) return `rubric_${field}_id_invalid`
      if (ids.has(item.id)) return `rubric_${field}_id_duplicated:${item.id}`
      ids.add(item.id)
      if (typeof item.description !== 'string' || item.description.length === 0) return `rubric_${field}_description_invalid:${item.id}`
      if (typeof item.pattern !== 'string' || item.pattern.length === 0) return `rubric_${field}_pattern_invalid:${item.id}`
      try { new RegExp(item.pattern, 'i') } catch { return `rubric_${field}_regex_invalid:${item.id}` }
      if (withPoints && item.points !== undefined && (typeof item.points !== 'number' || !(item.points > 0))) {
        return `rubric_${field}_points_invalid:${item.id}`
      }
    }
  }
  return null
}

function matches(text: string, pattern: string): boolean {
  return new RegExp(pattern, 'i').test(text)
}

/** Ejecuta la rúbrica sobre la salida. Lanza INVALID_RUBRIC si la rúbrica no valida (el handler valida antes). */
export function runRubric(rubric: Rubric, output: { text: string }): RubricResult {
  const err = validateRubric(rubric)
  if (err) throw new Error(`INVALID_RUBRIC:${err}`)
  const text = String(output?.text ?? '')

  const checks: RubricCheckResult[] = []
  const failedEssential: string[] = []
  const hitForbidden: string[] = []

  for (const it of rubric.essential) {
    const hit = matches(text, it.pattern)
    checks.push({ id: it.id, kind: 'essential', description: it.description, hit })
    if (!hit) failedEssential.push(it.id)
  }
  for (const it of rubric.forbidden) {
    const hit = matches(text, it.pattern)
    checks.push({ id: it.id, kind: 'forbidden', description: it.description, hit })
    if (hit) hitForbidden.push(it.id)
  }
  let bonusEarned = 0
  let bonusMax = 0
  for (const it of rubric.bonus) {
    const hit = matches(text, it.pattern)
    const points = it.points ?? 0
    bonusMax += points
    if (hit) bonusEarned += points
    checks.push({ id: it.id, kind: 'bonus', description: it.description, hit, points })
  }

  const pass = failedEssential.length === 0 && hitForbidden.length === 0
  const score = pass
    ? Math.round(bonusMax === 0 ? 100 : BASE_PASS_SCORE + BONUS_SCALE * (bonusEarned / bonusMax))
    : 0

  return {
    rubric: rubric.name,
    verdict: pass ? 'PASS' : 'FAIL',
    score,
    failedEssential,
    hitForbidden,
    bonusEarned,
    bonusMax,
    checks,
    evaluatedAt: new Date().toISOString(),
  }
}
