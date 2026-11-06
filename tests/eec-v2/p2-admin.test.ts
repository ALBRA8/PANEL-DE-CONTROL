// ============================================================
// EEC V2 — P2-4: PAQUETE ADMINISTRATIVO (doc 07 matriz #21/#22)
// bun test tests/eec-v2/p2-admin.test.ts
// Alta de organizaciones (filiales) con feature flags propios
// (catálogo cerrado, override auditable, fail-closed ante flag
// desconocido o valor de tipo incorrecto), aislamiento entre orgs y
// usage/coste atribuido vía Task → Project → Organization.
// Todo comando queda sellado en la cadena hash de auditoría (P0-1).
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand, setSimulationMode } from '../../src/lib/eec/commands'
import { ORG_FLAG_DEFS, resolveOrgFlags, getOrgUsage, UNATTRIBUTED_ORG } from '../../src/lib/eec/engine/org-flags'

const SFX = Date.now().toString(36)
const CODE_A = `TST-ORA-${SFX}`
const CODE_B = `TST-ORB-${SFX}`
const PROJ_CODE = `TST-PROJ-${SFX}`
const TASK_CODE = `TST-TASK-${SFX}`

let orgAId = ''
let orgBId = ''
let projectId = ''
let taskId = ''

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
})

afterAll(async () => {
  // limpieza en orden inverso de dependencias (fail-soft: el test ya dio veredicto)
  if (taskId) await db.toolInvocation.deleteMany({ where: { taskId } }).catch(() => undefined)
  if (taskId) await db.task.delete({ where: { id: taskId } }).catch(() => undefined)
  if (projectId) await db.project.delete({ where: { id: projectId } }).catch(() => undefined)
  if (orgAId) await db.orgFlag.deleteMany({ where: { orgId: orgAId } }).catch(() => undefined)
  if (orgBId) await db.orgFlag.deleteMany({ where: { orgId: orgBId } }).catch(() => undefined)
  if (orgAId) await db.organization.delete({ where: { id: orgAId } }).catch(() => undefined)
  if (orgBId) await db.organization.delete({ where: { id: orgBId } }).catch(() => undefined)
  await db.$disconnect()
})

describe('P2-4 paquete administrativo — feature flags por org (#21)', () => {
  test('catálogo cerrado: 7 flags con default y tipo declarados', () => {
    expect(ORG_FLAG_DEFS.length).toBe(7)
    for (const def of ORG_FLAG_DEFS) {
      expect(def.key.length).toBeGreaterThan(0)
      expect(['boolean', 'number', 'string']).toContain(def.valueType)
    }
    expect(ORG_FLAG_DEFS.find(f => f.key === 'marketplace.enabled')?.defaultValue).toBe(false)
  })

  test('org.create: alta de filial con flags iniciales, auditada y SELLADA en la cadena hash', async () => {
    const res = await dispatchCommand({
      type: 'org.create',
      payload: {
        code: CODE_A, name: 'Filial de prueba A', mission: 'Unit de prueba P2-4',
        flags: { 'marketplace.enabled': true, 'agents.max_count': 5 },
      },
      requesterId: 'operator',
      requesterType: 'HUMAN',
    })
    expect(res.ok).toBe(true)
    orgAId = String(res.result?.orgId)

    const org = await db.organization.findUniqueOrThrow({ where: { code: CODE_A } })
    expect(org.name).toBe('Filial de prueba A')
    const flags = await db.orgFlag.findMany({ where: { orgId: orgAId } })
    expect(flags).toHaveLength(2)

    // el acto administrativo queda en la escritura pública (cadena hash P0-1)
    const audits = await db.auditRecord.findMany({
      where: { action: 'org.create', entityId: orgAId },
    })
    expect(audits).toHaveLength(1)
    expect(audits[0].chainSeq).not.toBeNull()
    expect(audits[0].thisHash).toBeTruthy()
  })

  test('org.create es fail-closed: flag desconocido o tipo incorrecto se RECHAZA', async () => {
    const bad1 = await dispatchCommand({
      type: 'org.create',
      payload: { code: `TST-ORX-${SFX}`, name: 'Filial inválida', flags: { 'flag.inexistente': true } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(bad1.ok).toBe(false)
    expect(bad1.error).toContain('unknown_flag')

    const bad2 = await dispatchCommand({
      type: 'org.create',
      payload: { code: `TST-ORX-${SFX}`, name: 'Filial inválida', flags: { 'marketplace.enabled': 'sí' } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(bad2.ok).toBe(false)
    expect(bad2.error).toContain('flag_type_mismatch')

    const dup = await dispatchCommand({
      type: 'org.create',
      payload: { code: CODE_A, name: 'Duplicada' },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(dup.ok).toBe(false)
    expect(dup.error).toContain('ORG_CODE_TAKEN')
  })

  test('override por org: resolveOrgFlags lo refleja; unset vuelve al default global', async () => {
    const def = await resolveOrgFlags(orgAId)
    expect(def['marketplace.enabled'].source).toBe('override')
    expect(def['marketplace.enabled'].value).toBe(true)
    expect(def['white_label.enabled'].source).toBe('default')
    expect(def['white_label.enabled'].value).toBe(false)

    const set2 = await dispatchCommand({
      type: 'org.flag.set',
      payload: { orgId: orgAId, key: 'budget.max_cost_per_invocation', value: 2.5, reason: 'tope de presupuesto delegado' },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(set2.ok).toBe(true)
    const afterSet = await resolveOrgFlags(orgAId)
    expect(afterSet['budget.max_cost_per_invocation']).toMatchObject({ source: 'override', value: 2.5 })

    const unset = await dispatchCommand({
      type: 'org.flag.unset',
      payload: { orgId: orgAId, key: 'budget.max_cost_per_invocation', reason: 'revocación de delegación' },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(unset.ok).toBe(true)
    const afterUnset = await resolveOrgFlags(orgAId)
    expect(afterUnset['budget.max_cost_per_invocation'].source).toBe('default')
    expect(afterUnset['budget.max_cost_per_invocation'].value).toBeNull()
  })

  test('aislamiento tenancy: el override de A no afecta a B (delegación por unidad)', async () => {
    const res = await dispatchCommand({
      type: 'org.create',
      payload: { code: CODE_B, name: 'Filial de prueba B', flags: { 'marketplace.enabled': false } },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(res.ok).toBe(true)
    orgBId = String(res.result?.orgId)

    const [a, b] = await Promise.all([resolveOrgFlags(orgAId), resolveOrgFlags(orgBId)])
    expect(a['marketplace.enabled'].value).toBe(true) // override de A
    expect(b['marketplace.enabled'].value).toBe(false) // override explícito de B
    expect(a['sla.escalation.enabled'].value).toBe(b['sla.escalation.enabled'].value) // defaults compartidos
  })

  test('org.flag.set rechaza org inexistente y flag fuera de catálogo', async () => {
    const badOrg = await dispatchCommand({
      type: 'org.flag.set',
      payload: { orgCode: 'NO-EXISTE', key: 'marketplace.enabled', value: true },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(badOrg.ok).toBe(false)
    expect(badOrg.error).toContain('ORG_NOT_FOUND')

    const badFlag = await dispatchCommand({
      type: 'org.flag.set',
      payload: { orgId: orgAId, key: 'no.existe', value: true },
      requesterId: 'operator', requesterType: 'HUMAN',
    })
    expect(badFlag.ok).toBe(false)
    expect(badFlag.error).toContain('unknown_flag')
  })
})

describe('P2-4 — usage/coste por organización (#22)', () => {
  test('atribución ToolInvocation → Task → Project → Organization + CENTRAL para lo no atribuido', async () => {
    const before = await getOrgUsage()
    const beforeA = before.rows.find(r => r.orgId === orgAId)

    const proj = await db.project.create({
      data: { code: PROJ_CODE, name: 'Proyecto de la filial A', organizationId: orgAId },
    })
    projectId = proj.id
    const task = await db.task.create({
      data: { code: TASK_CODE, title: 'Tarea atribuida a A', projectId: proj.id, status: 'IN_PROGRESS' },
    })
    taskId = task.id

    await db.toolInvocation.create({ data: { toolId: 'x', toolCode: 'demo.tool', taskId: task.id, status: 'SUCCEEDED', cost: 1.5, sim: true } })
    await db.toolInvocation.create({ data: { toolId: 'x', toolCode: 'demo.tool', taskId: task.id, status: 'FAILED', cost: 0.5, sim: true } })
    await db.toolInvocation.create({ data: { toolId: 'x', toolCode: 'central.tool', status: 'SUCCEEDED', cost: 3, sim: true } })

    const after = await getOrgUsage()
    const rowA = after.rows.find(r => r.orgId === orgAId)
    expect(rowA).toBeDefined()
    expect(rowA!.invocations).toBe((beforeA?.invocations ?? 0) + 2)
    expect(rowA!.succeeded).toBe((beforeA?.succeeded ?? 0) + 1)
    expect(rowA!.failed).toBe((beforeA?.failed ?? 0) + 1)
    expect(rowA!.costTotal).toBeCloseTo((beforeA?.costTotal ?? 0) + 2.0, 6)
    expect(rowA!.costByTool['demo.tool']).toBeCloseTo(2.0, 6)

    const central = after.rows.find(r => r.orgCode === UNATTRIBUTED_ORG)
    expect(central).toBeDefined()
    expect(central!.invocations).toBe((before.rows.find(r => r.orgCode === UNATTRIBUTED_ORG)?.invocations ?? 0) + 1)
    expect(central!.costTotal).toBeCloseTo((before.rows.find(r => r.orgCode === UNATTRIBUTED_ORG)?.costTotal ?? 0) + 3.0, 6)

    // totales cuadran con la suma de filas
    const sumInv = after.rows.reduce((acc, r) => acc + r.invocations, 0)
    expect(after.totals.invocations).toBe(sumInv)
  })

  test('el coste es visible por org en la lectura consolidada (contrato del panel Sistema)', async () => {
    const [orgs, usage] = await Promise.all([
      db.organization.findMany({ where: { id: { in: [orgAId, orgBId] } } }),
      getOrgUsage(),
    ])
    expect(orgs).toHaveLength(2)
    for (const o of orgs) {
      expect(usage.rows.find(r => r.orgId === o.id)).toBeDefined()
    }
    expect(usage.totals.orgCode).toBe('TOTAL')
    expect(usage.totals.costTotal).toBeGreaterThan(0)
  })
})
