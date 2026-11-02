// ============================================================
// EEC — EVIDENCE GATE (P0-2 · doc 07 §3.2)
// "claim-or-refuse" genérico: una salida que reclama afirmaciones
// exigentes (claimTags) sin evidencia VERIFICADA (source + hash +
// verifiedAt) NO se publica ni se marca ejecutada. Fail-closed.
// El EEC es neutral al dominio: no sabe de leyes ni artículos —
// solo de evidencias verificadas por hash y políticas declaradas.
// ============================================================
import { db } from '../../../lib/db'

export interface EvidenceGateDecision {
  /** hay una política EVIDENCE/REQUIRE aplicable a esta salida */
  required: boolean
  /** código de la política que exige la evidencia */
  policy?: string
  /** la salida satisface el mínimo de evidencia verificada */
  ok: boolean
  /** motivos legibles del bloqueo (para UI y auditoría) */
  missing: string[]
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try { return JSON.parse(json || '') as T } catch { return fallback }
}

function isVerifiedEvidence(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.source === 'string' && r.source.length > 0 &&
    typeof r.hash === 'string' && r.hash.length > 0 &&
    typeof r.verifiedAt === 'string' && r.verifiedAt.length > 0
  )
}

/**
 * Evalúa el gate de evidencia para la salida de un comando.
 * - Política EVIDENCE/REQUIRE con actionJson que incluye el tipo de comando.
 * - conditionsJson.claimTags: si se declara, SOLO gatea salidas que reclamen
 *   al menos uno de esos tags (el vertical marca sus afirmaciones exigentes).
 * - conditionsJson.minVerified: mínimo de evidencias verificadas (default 1).
 */
export async function evaluateEvidenceGate(
  commandType: string,
  result: Record<string, unknown> | null | undefined,
): Promise<EvidenceGateDecision> {
  const policies = await db.policy.findMany({
    where: { enabled: true, type: 'EVIDENCE', effect: 'REQUIRE' },
    orderBy: { priority: 'asc' },
  })
  const claimTags = Array.isArray(result?.claimTags)
    ? (result?.claimTags as unknown[]).filter((t): t is string => typeof t === 'string')
    : []

  let required: { policy: string; minVerified: number } | null = null
  for (const p of policies) {
    const actions = safeParse<string[]>(p.actionJson, [])
    const appliesType = actions.length === 0 || actions.includes(commandType) || actions.includes('*')
    if (!appliesType) continue
    const cond = safeParse<Record<string, unknown>>(p.conditionsJson, {})
    const tagFilter = Array.isArray(cond.claimTags)
      ? (cond.claimTags as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    if (tagFilter.length > 0 && !tagFilter.some(t => claimTags.includes(t))) continue
    const minVerified = typeof cond.minVerified === 'number' && cond.minVerified >= 1
      ? Math.floor(cond.minVerified)
      : 1
    required = { policy: p.code, minVerified }
    break
  }

  if (!required) return { required: false, ok: true, missing: [] }

  const evidence = Array.isArray(result?.evidence) ? (result?.evidence as unknown[]) : []
  const verified = evidence.filter(isVerifiedEvidence)
  const missing: string[] = []
  if (verified.length < required.minVerified) {
    missing.push(`verified_evidence:${verified.length}/${required.minVerified}`)
    if (evidence.length > verified.length) missing.push('evidence_sin_verificar_presente')
  }
  return { required: true, policy: required.policy, ok: missing.length === 0, missing }
}
