// Diagnóstico: reproducir el fallo de sealAuditRecord con error completo
import { db, initDbPragmas } from '../src/lib/db'
import { sealAuditRecord } from '../src/lib/eec/engine/audit-chain'

async function main(): Promise<void> {
  await initDbPragmas()
  const rec = await db.auditRecord.create({
    data: { actorId: 'diag', actorType: 'SYSTEM', action: 'diag.seal', entityType: 'X', entityId: 'y' },
  })
  console.log('creado:', rec.id)
  try {
    const r = await sealAuditRecord({
      id: rec.id, actorId: rec.actorId, actorType: rec.actorType, action: rec.action,
      entityType: rec.entityType, entityId: rec.entityId, why: rec.why,
      inputJson: rec.inputJson, outputJson: rec.outputJson, toolsJson: rec.toolsJson,
      permissionsJson: rec.permissionsJson, result: rec.result, cost: rec.cost,
      traceId: rec.traceId, correlationId: rec.correlationId, sim: rec.sim,
      prevAuditId: rec.prevAuditId, createdAt: rec.createdAt,
    })
    console.log('SELL OK:', r)
  } catch (e) {
    console.error('SELL ERROR:', (e as Error).message.slice(0, 1500))
  }
  await db.auditRecord.delete({ where: { id: rec.id } }).catch(() => undefined)
  await db.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
