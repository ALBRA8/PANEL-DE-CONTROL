#!/usr/bin/env python3
"""P0-1 (doc 07 §3.1): parchea archivos TRACKED del repo sobre la rama
feature/v2-adaptacion-verticales. Los archivos NUEVOS (audit-chain.ts,
route.ts, test) se escriben aparte. Falla ruidosamente si un marcador
no existe — nunca edita a ciegas."""
from pathlib import Path
import re
import sys

def must(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

# ---------- 1) prisma/schema.prisma: campos de cadena en AuditRecord ----------
schema = Path("prisma/schema.prisma")
t = schema.read_text(encoding="utf-8")
old_block = """  // cadena inmutable: correcciones = nuevo registro apuntando al previo
  prevAuditId    String?
  createdAt      DateTime @default(now())

  @@index([entityType, entityId])
  @@index([createdAt])
}"""
new_block = """  // cadena inmutable: correcciones = nuevo registro apuntando al previo
  prevAuditId    String?
  // P0-1 (doc 07 §3.1): cadena hash SHA-256 tamper-evident (sello en writeAudit)
  prevHash       String?
  thisHash       String?
  chainSeq       Int?
  createdAt      DateTime @default(now())

  @@index([entityType, entityId])
  @@index([createdAt])
  @@index([chainSeq])
}"""
must(t.count(old_block) == 1, "bloque AuditRecord no único en schema.prisma")
schema.write_text(t.replace(old_block, new_block, 1), encoding="utf-8")
print("schema.prisma OK")

# ---------- 2) src/lib/eec/engine/audit.ts: sello en writeAudit ----------
audit = Path("src/lib/eec/engine/audit.ts")
new_audit = '''// ============================================================
// EEC — AUDIT (spec §28 + doc 07 §3.1 P0-1)
// Toda operación significativa es reconstruible: WHO/WHAT/WHEN/WHY/
// INPUT/OUTPUT/TOOLS/PERMISSIONS/RESULT/COST.
// Los registros NO se mutan: las correcciones crean registros nuevos
// encadenados vía prevAuditId.
// P0-1: cada registro se SELLA al crearlo con la cadena hash SHA-256
// (audit-chain.ts). Único punto de creación de auditoría del sistema.
// ============================================================
import { db } from '../../../lib/db'
import { currentTrace, sanitize } from './observability'
import { sealAuditRecord } from './audit-chain'

export interface AuditInput {
  actorId: string
  actorType: 'AGENT' | 'HUMAN' | 'SYSTEM' | 'COMMAND_PIPELINE'
  action: string
  entityType: string
  entityId: string
  why?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  tools?: string[]
  permissions?: Array<Record<string, unknown>>
  result?: string
  cost?: number
  sim?: boolean
  /** P0-1: encadenamiento referencial de correcciones (se sella junto al resto). */
  prevAuditId?: string
}

export async function writeAudit(a: AuditInput): Promise<string> {
  const t = currentTrace()
  const rec = await db.auditRecord.create({
    data: {
      actorId: a.actorId,
      actorType: a.actorType,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      why: a.why ?? null,
      inputJson: JSON.stringify(sanitize(a.input ?? {})),
      outputJson: JSON.stringify(sanitize(a.output ?? {})),
      toolsJson: JSON.stringify(a.tools ?? []),
      permissionsJson: JSON.stringify(a.permissions ?? []),
      result: a.result ?? null,
      cost: a.cost ?? null,
      traceId: t?.traceId ?? null,
      correlationId: t?.correlationId ?? null,
      sim: a.sim ?? t?.sim ?? false,
      prevAuditId: a.prevAuditId ?? null,
    },
  })
  // P0-1: sello de cadena. Si falla, el registro SOBREVIVE sin sello
  // (chainSeq null) y la verificación declara el hueco: nunca se pierde
  // una entrada de auditoría por fallo del sello.
  try {
    await sealAuditRecord({
      id: rec.id,
      actorId: rec.actorId,
      actorType: rec.actorType,
      action: rec.action,
      entityType: rec.entityType,
      entityId: rec.entityId,
      why: rec.why,
      inputJson: rec.inputJson,
      outputJson: rec.outputJson,
      toolsJson: rec.toolsJson,
      permissionsJson: rec.permissionsJson,
      result: rec.result,
      cost: rec.cost,
      traceId: rec.traceId,
      correlationId: rec.correlationId,
      sim: rec.sim,
      prevAuditId: rec.prevAuditId,
      createdAt: rec.createdAt,
    })
  } catch (err) {
    console.error('[audit-chain] fallo al sellar registro', rec.id, err)
  }
  return rec.id
}

/** Corrección inmutable: crea un NUEVO registro encadenado (creación+sello atómicos). */
export async function correctAudit(prevAuditId: string, correction: AuditInput, why: string): Promise<string> {
  return writeAudit({ ...correction, why: `correction:${why}`, prevAuditId })
}

/** Reconstrucción completa de una entidad a partir de su cola de auditoría + eventos. */
export async function reconstructEntity(entityType: string, entityId: string): Promise<{
  auditTrail: Array<Record<string, unknown>>
  eventTrail: Array<Record<string, unknown>>
}> {
  const auditTrail = await db.auditRecord.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
  })
  const eventTrail = await db.eventRecord.findMany({
    where: {
      OR: [
        { subject: `${entityType}:${entityId}` },
        { payloadJson: { contains: entityId } },
      ],
    },
    orderBy: { seq: 'asc' },
    take: 500,
  })
  return {
    auditTrail: auditTrail as unknown as Array<Record<string, unknown>>,
    eventTrail: eventTrail.map(e => ({
      seq: e.seq, id: e.id, type: e.type, subject: e.subject,
      createdAt: e.createdAt, payload: JSON.parse(e.payloadJson || '{}'),
      correlationId: e.correlationId, causationId: e.causationId, sim: e.sim,
    })),
  }
}
'''
audit.write_text(new_audit, encoding="utf-8")
print("engine/audit.ts OK (reescrito con sello P0-1)")

# ---------- 3) vista eventos-auditoría: badge de cadena ----------
view = Path("src/components/eec/events-audit-view.tsx")
v = view.read_text(encoding="utf-8")
trigger_old = '<TabsTrigger value="audit" className="text-xs sm:text-sm">Auditoría</TabsTrigger>'
must(v.count(trigger_old) == 1, "TabsTrigger de auditoría no único en la vista")
v = v.replace(trigger_old, '<TabsTrigger value="audit" className="text-xs sm:text-sm">Auditoría <AuditChainBadge /></TabsTrigger>', 1)

badge_component = '''
// ---------- P0-1 (doc 07 §3.1): badge del estado de la cadena de auditoría ----------
// Declarado vs observado: verde = cadena verificada; rojo = cadena ROTA.
function AuditChainBadge() {
  const [chain, setChain] = useState<{ ok: boolean; verified: number } | null>(null)
  useEffect(() => {
    fetch('/api/eec/audit/chain')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setChain({ ok: !!d.ok, verified: d.verified ?? 0 }) })
      .catch(() => undefined)
  }, [])
  if (!chain) return null
  return (
    <span
      className={`ml-1 inline-block h-2 w-2 rounded-full align-middle ${chain.ok ? 'bg-emerald-500' : 'bg-red-500'}`}
      title={chain.ok
        ? `Cadena de auditoría verificada (${chain.verified} registros sellados)`
        : 'Cadena de auditoría ROTA — ver /api/eec/audit/chain'}
    />
  )
}

'''
m = re.search(r'^export (?:default )?function ', v, re.M)
must(m is not None, "no se encontró export function en events-audit-view.tsx")
v = v[: m.start()] + badge_component + v[m.start():]
view.write_text(v, encoding="utf-8")
print("events-audit-view.tsx OK (badge insertado)")
print("PATCH P0-1 COMPLETO")
