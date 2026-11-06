#!/usr/bin/env python3
# ============================================================
# P2-3 provenance — parche a security/evidence.ts:
#  - isVerifiedEvidence pasa a criterio ESTRICTO (hash 64-hex,
#    verifiedAt parseable y no futuro, source presente)
#  - attestEvidence / provenanceStatus / provenanceReport nuevos
#  - EvidenceGateDecision expone resumen de provenance
# Anclas exactas, fail-loud, autoverificación final.
# ============================================================
import pathlib

ROOT = pathlib.Path('/home/z/my-project')
REL = 'src/lib/eec/security/evidence.ts'
p = ROOT / REL
txt = p.read_text(encoding='utf-8')
changed = []

def replace_once(old, new, label):
    global txt
    n = txt.count(old)
    assert n == 1, f'[{label}] ancla aparece {n} veces (esperado 1)'
    assert new not in txt, f'[{label}] resultado ya aplicado'
    txt = txt.replace(old, new)
    changed.append(label)

# ---------- 1. imports ----------
replace_once(
    "import { db } from '../../../lib/db'\n",
    "import { createHash } from 'crypto'\n"
    "import { db } from '../../../lib/db'\n"
    "import type { EvidenceRef } from '../domain/contracts'\n",
    'imports crypto + EvidenceRef')

# ---------- 2. isVerifiedEvidence estricto + utilidades ----------
OLD_ISVERIFIED = """export function isVerifiedEvidence(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.source === 'string' && r.source.length > 0 &&
    typeof r.hash === 'string' && r.hash.length > 0 &&
    typeof r.verifiedAt === 'string' && r.verifiedAt.length > 0
  )
}"""

NEW_PROVENANCE = """// ---------- PROVENANCE ESTRICTO (P2-3 · doc 07 matriz #15) ----------
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
}"""

replace_once(OLD_ISVERIFIED, NEW_PROVENANCE, 'isVerifiedEvidence → estricto + utilidades provenance')

# ---------- 3. interfaz de decisión ----------
replace_once(
    """  /** motivos legibles del bloqueo (para UI y auditoría) */
  missing: string[]
}""",
    """  /** motivos legibles del bloqueo (para UI y auditoría) */
  missing: string[]
  /** P2-3: resumen de provenance de la evidencia evaluada */
  provenance?: { verified: number; total: number; incomplete: number; malformed: number }
}""",
    'EvidenceGateDecision.provenance')

# ---------- 4. return con provenance ----------
replace_once(
    '  return { required: true, policy: required.policy, ok: missing.length === 0, missing }',
    """  const prov = provenanceReport(evidence)
  return {
    required: true, policy: required.policy, ok: missing.length === 0, missing,
    provenance: { verified: prov.verified, total: evidence.length, incomplete: prov.incomplete, malformed: prov.malformed },
  }""",
    'return con provenance')

p.write_text(txt, encoding='utf-8')

# ---------- autoverificación ----------
final = p.read_text(encoding='utf-8')
for nd in ['HASH_RE', 'attestEvidence', 'provenanceStatus', 'provenanceReport',
           "status: malformed ? 'MALFORMED' : 'INCOMPLETE'", 'verifiedAt_in_future',
           'provenance?: { verified: number']:
    assert nd in final, f'postcheck: falta {nd!r}'
assert 'typeof r.hash === \'string\' && r.hash.length > 0' not in final, 'criterio viejo débil sigue presente'

print('OK parche P2-3 aplicado:')
for c in changed:
    print(f'  - {c}')
