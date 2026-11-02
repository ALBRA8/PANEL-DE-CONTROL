// ============================================================
// EEC — AUDIT CHAIN (P0-1 · doc 07 §3.1)
// Cadena hash SHA-256 tamper-evident sobre AuditRecord.
//   thisHash = SHA-256(canonicalJson(contenido_sellable + prevHash))
// El sello se aplica en writeAudit (único punto de creación de
// auditoría del sistema). La verificación es incremental por rangos
// de chainSeq y NUNCA re-escribe el pasado: una cadena rota se
// documenta (brokenAt) — honestidad observable, no reparación silenciosa.
// ============================================================
import { createHash } from 'crypto'
import { db } from '../../../lib/db'

/** Campos sellables del registro (todo lo inmutable excepto thisHash). */
export interface SealableAuditFields {
  id: string
  actorId: string
  actorType: string
  action: string
  entityType: string
  entityId: string
  why: string | null
  inputJson: string | null
  outputJson: string | null
  toolsJson: string | null
  permissionsJson: string | null
  result: string | null
  cost: number | null
  traceId: string | null
  correlationId: string | null
  sim: boolean
  prevAuditId: string | null
  createdAt: Date | string
  prevHash?: string | null
}

/** JSON canónico: claves ordenadas recursivamente; arrays conservan orden. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/** Payload sellable canónico (prevHash '' representa el génesis). */
function sealPayload(f: SealableAuditFields, prevHash: string | null): Record<string, unknown> {
  return {
    id: f.id, actorId: f.actorId, actorType: f.actorType, action: f.action,
    entityType: f.entityType, entityId: f.entityId, why: f.why,
    inputJson: f.inputJson, outputJson: f.outputJson, toolsJson: f.toolsJson,
    permissionsJson: f.permissionsJson, result: f.result, cost: f.cost,
    traceId: f.traceId, correlationId: f.correlationId, sim: f.sim,
    prevAuditId: f.prevAuditId, createdAt: new Date(f.createdAt).toISOString(),
    prevHash: prevHash ?? '',
  }
}

/** SHA-256 hex del payload sellable (re-exportable para verificación externa). */
export function hashSealPayload(f: SealableAuditFields, prevHash: string | null): string {
  return createHash('sha256').update(canonicalJson(sealPayload(f, prevHash))).digest('hex')
}

// --- mutex: SQLite es single-writer; serializamos el sello por proceso ---
let sealQueue: Promise<unknown> = Promise.resolve()

/** Sella un registro recién creado al final de la cadena global. */
export async function sealAuditRecord(f: SealableAuditFields): Promise<{ chainSeq: number; thisHash: string }> {
  const run = async (): Promise<{ chainSeq: number; thisHash: string }> => {
    const last = await db.auditRecord.findFirst({
      where: { chainSeq: { not: null } },
      orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true, thisHash: true },
    })
    const prevHash = last?.thisHash ?? null
    const chainSeq = (last?.chainSeq ?? 0) + 1
    const thisHash = hashSealPayload(f, prevHash)
    await db.auditRecord.update({ where: { id: f.id }, data: { prevHash, thisHash, chainSeq } })
    return { chainSeq, thisHash }
  }
  const p = sealQueue.then(run, run) // corre aunque el sello anterior haya fallado
  sealQueue = p.catch(() => undefined)
  return p
}

export interface ChainVerifyResult {
  ok: boolean
  verified: number
  checked: number
  /** discontinuidades: hash alterado, hueco de secuencia o ancla ausente */
  brokenAt: Array<{ chainSeq: number; id: string; reason: string }>
  /** registros históricos previos al sello (pre-P0) — no forman parte de la cadena */
  unsealedLegacy: number
}

/**
 * Verifica la cadena (incremental: fromSeq..toSeq; por defecto toda).
 * El ancla en fromSeq-1 fija el prevHash esperado del primer registro.
 */
export async function verifyAuditChain(fromSeq = 1, toSeq?: number): Promise<ChainVerifyResult> {
  const unsealedLegacy = await db.auditRecord.count({ where: { thisHash: null } })
  const anchorSeq = Math.max(1, fromSeq) - 1
  let expectedPrevHash: string | null = null
  if (anchorSeq >= 1) {
    const anchor = await db.auditRecord.findFirst({ where: { chainSeq: anchorSeq }, select: { thisHash: true } })
    if (!anchor?.thisHash) {
      return { ok: false, verified: 0, checked: 0, brokenAt: [{ chainSeq: anchorSeq, id: '', reason: 'anchor_missing' }], unsealedLegacy }
    }
    expectedPrevHash = anchor.thisHash
  }
  const rows = await db.auditRecord.findMany({
    where: {
      chainSeq: { not: null, gte: fromSeq, ...(toSeq !== undefined ? { lte: toSeq } : {}) },
    },
    orderBy: { chainSeq: 'asc' },
  })
  const brokenAt: ChainVerifyResult['brokenAt'] = []
  let verified = 0
  let expected = fromSeq
  for (const r of rows) {
    const seq = r.chainSeq as number
    if (seq !== expected) {
      brokenAt.push({ chainSeq: seq, id: r.id, reason: `gap: esperaba chainSeq=${expected}` })
      expected = seq
    }
    if (r.prevHash !== expectedPrevHash) {
      brokenAt.push({ chainSeq: seq, id: r.id, reason: 'prevHash_mismatch' })
    }
    const recomputed = hashSealPayload(r as SealableAuditFields, r.prevHash)
    if (recomputed !== r.thisHash) {
      brokenAt.push({ chainSeq: seq, id: r.id, reason: 'hash_mismatch' })
    } else if (!brokenAt.some(b => b.chainSeq === seq)) {
      verified += 1
    }
    expectedPrevHash = r.thisHash
    expected = seq + 1
  }
  return { ok: brokenAt.length === 0, verified, checked: rows.length, brokenAt, unsealedLegacy }
}
