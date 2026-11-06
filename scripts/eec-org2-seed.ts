// ============================================================
// EEC — SEED: ALTA DE LA SEGUNDA ORGANIZACIÓN (P2-4 · matriz #21/#22)
// bun scripts/eec-org2-seed.ts
// Alta administrativa de la filial del ecosistema con delegaciones
// (flags) propias, por el pipeline de comandos → auditable y sellado
// en la cadena hash. Idempotente: si ya existe, solo reporta estado.
// ============================================================
import { db, initDbPragmas } from '../src/lib/db'
import { dispatchCommand } from '../src/lib/eec/commands'
import { resolveOrgFlags, getOrgUsage } from '../src/lib/eec/engine/org-flags'

const CODE = 'FILIAL-02'
const NAME = 'Filial Andina S.A.'

async function main(): Promise<void> {
  await initDbPragmas()
  const existing = await db.organization.findUnique({ where: { code: CODE } })

  if (!existing) {
    const res = await dispatchCommand({
      type: 'org.create',
      payload: {
        code: CODE,
        name: NAME,
        mission: 'Segunda organización del ecosistema (alta P2-4 · doc 07 matriz #21/#22)',
        flags: {
          'marketplace.enabled': true,      // delegación propia: acceso a marketplace
          'white_label.enabled': true,      // experiencia de marca propia
          'agents.max_count': 10,           // tope de flota propio
        },
      },
      requesterId: 'sede-central',
      requesterType: 'HUMAN',
    })
    if (!res.ok) throw new Error(`org.create falló: ${res.error}`)
    console.log(`✓ organización creada: ${CODE} (${res.result?.orgId})`)
  } else {
    console.log(`• organización ya existente: ${CODE} (${existing.id}) — no se recrea`)
  }

  // delegación presupuestaria propia (idempotente: upsert)
  const budget = await dispatchCommand({
    type: 'org.flag.set',
    payload: { orgCode: CODE, key: 'budget.max_cost_per_invocation', value: 2.5, reason: 'tope presupuestario delegado a la filial' },
    requesterId: 'sede-central',
    requesterType: 'HUMAN',
  })
  if (!budget.ok) throw new Error(`org.flag.set falló: ${budget.error}`)
  console.log('✓ flag budget.max_cost_per_invocation = 2.5')

  const org = await db.organization.findUniqueOrThrow({ where: { code: CODE } })
  const flags = await resolveOrgFlags(org.id)
  console.log(`\nFlags resueltos de ${CODE}:`)
  for (const f of Object.values(flags)) {
    const mark = f.source === 'override' ? '[override]' : '[default] '
    console.log(`  ${mark} ${f.key} = ${String(f.value)}`)
  }
  const usage = await getOrgUsage()
  console.log('\nUsage/coste por organización (#22):')
  for (const r of usage.rows) {
    console.log(`  ${r.orgCode.padEnd(12)} inv=${String(r.invocations).padStart(4)} ok=${String(r.succeeded).padStart(4)} fallo=${String(r.failed).padStart(3)} coste=${r.costTotal}`)
  }
  const audits = await db.auditRecord.count({ where: { entityType: 'ORGANIZATION', entityId: org.id } })
  const sealed = await db.auditRecord.count({ where: { entityType: 'ORGANIZATION', entityId: org.id, chainSeq: { not: null } } })
  console.log(`\nAuditoría de la org: ${audits} registros (${sealed} sellados en la cadena hash)`)
  await db.$disconnect()
}

main().catch(e => { console.error('FALLO seed org2:', e); process.exit(1) })
