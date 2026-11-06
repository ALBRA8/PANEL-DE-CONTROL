// ============================================================
// EEC — EVIDENCE GATE (P0-2 · doc 07 §3.2)
// "claim-or-refuse" genérico: una salida que reclama afirmaciones
// exigentes (claimTags) sin evidencia VERIFICADA (source + hash +
// verifiedAt) NO se publica ni se marca ejecutada. Fail-closed.
// El EEC es neutral al dominio: no sabe de leyes ni artículos —
// solo de evidencias verificadas por hash y políticas declaradas.
// ============================================================
import { createHash } from 'crypto'
import { db } from '../../../lib/db'
import type { EvidenceRef } from '../domain/contracts'

export interface EvidenceGateDecision {
  /** hay una política EVIDENCE/REQUIRE aplicable a esta salida */
  required: boolean
  /** código de la política que exige la evidencia */
  policy?: string
  /** la salida satisface el mínimo de evidencia verificada */
  ok: boolean
  /** motivos legibles del bloqueo (para UI y auditoría) */
  missing: string[]
  /** P2-3: resumen de provenance de la evidencia evaluada */
  provenance?: { verified: number; total: number; incomplete: number; malformed: number }
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try { return JSON.parse(json || '') as T } catch { return fallback }
}

// ---------- PROVENANCE ESTRICTO (P2-3 · doc 07 matriz #15) ----------
/** hash de contenido = 64 hex (SHA-256, ver attestEvidence). */
const HASH_RE = /^[a-f0-9]{64}$/
/** tolerancia de reloj para verifiedAt "no futuro" (60 s). */
const CLOCK_TOLERANCE_MS = 60_000

export type ProvenanceVerdict = 'VERIFIED' | 'INCOMPLETE' | 'MALFORMED'

export interface ProvenanceDiagnosis {
  status: ProvenanceVerdict
  reasons: string[]
}

/**
 * Diagnóstico detallado de una evidencia (P2-3): distingue evidencia
 * incompleta (faltan campos) de MALFORMADA (campos presentes pero
 * inválidos: hash que no es 64-hex, verifiedAt no parseable o futuro).
 */
export function provenanceStatus(e: unknown): ProvenanceDiagnosis {
  if (!e || typeof e !== 'object') return { status: 'MALFORMED', reasons: ['not_an_object'] }
  const r = e as Record<string, unknown>
  const reasons: string[] = []
  let malformed = false

  if (r.source === undefined || r.source === null) reasons.push('missing_source')
  else if (typeof r.source !== 'string' || r.source.length === 0) { reasons.push('source_invalid'); malformed = true }

  if (r.hash === undefined || r.hash === null) reasons.push('missing_hash')
  else if (typeof r.hash !== 'string' || !HASH_RE.test(r.hash)) { reasons.push('hash_format_invalid'); malformed = true }

  if (r.verifiedAt === undefined || r.verifiedAt === null) reasons.push('missing_verifiedAt')
  else if (typeof r.verifiedAt !== 'string' || Number.isNaN(new Date(r.verifiedAt).getTime())) { reasons.push('verifiedAt_unparseable'); malformed = true }
  else if (new Date(r.verifiedAt).getTime() > Date.now() + CLOCK_TOLERANCE_MS) { reasons.push('verifiedAt_in_future'); malformed = true }

  if (reasons.length === 0) return { status: 'VERIFIED', reasons: [] }
  return { status: malformed ? 'MALFORMED' : 'INCOMPLETE', reasons }
}

/**
 * Criterio VERIFICADO (estricto, P2-3): lo usa el Evidence Gate, el
 * quórum de handoffs y cualquier consumidor de evidencia. Una evidencia
 * malformada NO cuenta como verificada — la provenance decorativa no
 * pasa el gate.
 */
export function isVerifiedEvidence(e: unknown): boolean {
  return provenanceStatus(e).status === 'VERIFIED'
}

/**
 * Atestiguamiento canónico (P2-3): la forma CORRECTA de producir una
 * evidencia verificada — hash SHA-256 del contenido real + instante de
 * verificación. Nada debe fabricar hashes a mano.
 */
export function attestEvidence(input: { id: string; source: string; kind: string; content: string; verifiedAt?: string }): EvidenceRef {
  return {
    id: input.id,
    source: input.source,
    kind: input.kind,
    hash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
  }
}

export interface ProvenanceReport {
  verified: number
  incomplete: number
  malformed: number
  total: number
  items: Array<{ id: string; status: ProvenanceVerdict; reasons: string[] }>
}

/** Resumen de provenance de una lista de evidencias (para gate, UI y auditoría). */
export function provenanceReport(evidence: unknown[]): ProvenanceReport {
  const items = evidence.map(e => {
    const d = provenanceStatus(e)
    const id = e && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string'
      ? (e as Record<string, unknown>).id as string
      : '(sin id)'
    return { id, status: d.status, reasons: d.reasons }
  })
  return {
    verified: items.filter(i => i.status === 'VERIFIED').length,
    incomplete: items.filter(i => i.status === 'INCOMPLETE').length,
    malformed: items.filter(i => i.status === 'MALFORMED').length,
    total: items.length,
    items,
  }
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
  const prov = provenanceReport(evidence)
  return {
    required: true, policy: required.policy, ok: missing.length === 0, missing,
    provenance: { verified: prov.verified, total: evidence.length, incomplete: prov.incomplete, malformed: prov.malformed },
  }
}
