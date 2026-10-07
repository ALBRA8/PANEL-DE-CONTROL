// ============================================================
// EEC — AUDIT (spec §28)
// Toda operación significativa es reconstruible: WHO/WHAT/WHEN/WHY/
// INPUT/OUTPUT/TOOLS/PERMISSIONS/RESULT/COST.
// Los registros NO se mutan: las correcciones crean registros nuevos
// encadenados vía prevAuditId.
// ============================================================
import { db } from '../../../lib/db'
import { currentTrace, sanitize } from './observability'

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
    },
  })
  return rec.id
}

/** Corrección inmutable: crea un NUEVO registro encadenado al anterior. */
export async function correctAudit(prevAuditId: string, correction: AuditInput, why: string): Promise<string> {
  return writeAudit({ ...correction, why: `correction:${why}` })
    .then(async id => {
      await db.auditRecord.update({ where: { id }, data: { prevAuditId } })
      return id
    })
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
