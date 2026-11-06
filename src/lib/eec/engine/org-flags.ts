// ============================================================
// EEC — ADMINISTRACIÓN POR ORGANIZACIÓN (P2-4 · doc 07 matriz #21/#22)
// La EEC es la sede administrativa del ecosistema: gestiona N
// organizaciones (filiales) con delegaciones distintas.
//
// Feature flags por org (#21): catálogo CERRADO (allowlist) con valor
// por defecto global; cada organización puede tener OVERRIDE propio,
// auditado vía comando (org.flag.set/unset → pipeline → writeAudit).
// Fail-closed: una clave fuera del catálogo se RECHAZA.
//
// Usage/coste por org (#22): metering ToolInvocation atribuido a
// organización vía Task.project → Project.organization. Las
// invocaciones sin tarea se reportan como CENTRAL (sin atribuir) —
// presupuesto visible por unidad, nunca oculto.
// ============================================================
import { db } from '../../../lib/db'

export type OrgFlagValueType = 'boolean' | 'number' | 'string'

export interface OrgFlagDef {
  key: string
  description: string
  defaultValue: boolean | number | string | null
  valueType: OrgFlagValueType
}

/** Catálogo cerrado de flags administrativos (extendibles SOLO aquí, con default y tipo). */
export const ORG_FLAG_DEFS: OrgFlagDef[] = [
  { key: 'handoffs.enabled', description: 'Traspasos HandoffEnvelope habilitados para la org', defaultValue: true, valueType: 'boolean' },
  { key: 'sla.escalation.enabled', description: 'Escalera de escalamiento SLA (deadline_near/overdue) activa', defaultValue: true, valueType: 'boolean' },
  { key: 'adversarial.review.enabled', description: 'Revisión adversarial pre-dispatch (órgano de control)', defaultValue: true, valueType: 'boolean' },
  { key: 'marketplace.enabled', description: 'Acceso al marketplace de agentes', defaultValue: false, valueType: 'boolean' },
  { key: 'white_label.enabled', description: 'Marca blanca (experiencia propia de la org)', defaultValue: false, valueType: 'boolean' },
  { key: 'budget.max_cost_per_invocation', description: 'Tope presupuestario por invocación de tool (null = sin tope)', defaultValue: null, valueType: 'number' },
  { key: 'agents.max_count', description: 'Tope de agentes registrables de la org (null = sin tope)', defaultValue: null, valueType: 'number' },
]

const FLAG_INDEX = new Map(ORG_FLAG_DEFS.map(f => [f.key, f]))

export function isValidOrgFlagKey(key: string): boolean {
  return FLAG_INDEX.has(key)
}

export function getOrgFlagDef(key: string): OrgFlagDef | undefined {
  return FLAG_INDEX.get(key)
}

/** Valida que el valor encaje con el tipo declarado del flag. Devuelve error o null. */
export function validateOrgFlagValue(key: string, value: unknown): string | null {
  const def = FLAG_INDEX.get(key)
  if (!def) return `unknown_flag:${key}`
  if (value === null || value === undefined) return null // null = "sin tope"/heredar
  switch (def.valueType) {
    case 'boolean':
      if (typeof value !== 'boolean') return `flag_type_mismatch:${key}:expected_boolean`
      break
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `flag_type_mismatch:${key}:expected_non_negative_number`
      break
    }
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > 200) return `flag_type_mismatch:${key}:expected_string_1_200`
      break
  }
  return null
}

export interface ResolvedOrgFlag {
  key: string
  value: boolean | number | string | null
  source: 'default' | 'override'
  reason?: string
  setBy?: string
  updatedAt?: string
}

/** Resuelve el catálogo completo para una org: default global + overrides persistidos. */
export async function resolveOrgFlags(orgId: string): Promise<Record<string, ResolvedOrgFlag>> {
  const overrides = await db.orgFlag.findMany({ where: { orgId } })
  const byKey = new Map(overrides.map(o => [o.key, o]))
  const out: Record<string, ResolvedOrgFlag> = {}
  for (const def of ORG_FLAG_DEFS) {
    const o = byKey.get(def.key)
    out[def.key] = o
      ? {
          key: def.key,
          value: JSON.parse(o.valueJson) as boolean | number | string | null,
          source: 'override',
          reason: o.reason ?? undefined,
          setBy: o.setBy,
          updatedAt: o.updatedAt.toISOString(),
        }
      : { key: def.key, value: def.defaultValue, source: 'default' }
  }
  return out
}

export const UNATTRIBUTED_ORG = 'CENTRAL'

export interface OrgUsageRow {
  orgId: string | null
  orgCode: string
  orgName: string
  invocations: number
  succeeded: number
  failed: number
  costTotal: number
  costByTool: Record<string, number>
}

/**
 * Usage/coste por organización (#22): atribución ToolInvocation → Task →
 * Project → Organization. Sin tarea/proyecto → CENTRAL (presupuesto de la
 * sede, visible, nunca oculto). Incluye coste incurrido aunque la
 * invocación haya fallado (coste real consumido).
 */
export async function getOrgUsage(): Promise<{ rows: OrgUsageRow[]; totals: OrgUsageRow }> {
  const [invs, tasks, projects, orgs] = await Promise.all([
    db.toolInvocation.findMany({ select: { taskId: true, toolCode: true, status: true, cost: true } }),
    db.task.findMany({ select: { id: true, projectId: true } }),
    db.project.findMany({ select: { id: true, organizationId: true } }),
    db.organization.findMany({ select: { id: true, code: true, name: true } }),
  ])
  const taskToProject = new Map(tasks.map(t => [t.id, t.projectId]))
  const projectToOrg = new Map(projects.map(p => [p.id, p.organizationId]))
  const orgById = new Map(orgs.map(o => [o.id, o]))

  const blank = (orgId: string | null): OrgUsageRow => {
    const o = orgId ? orgById.get(orgId) : undefined
    return {
      orgId,
      orgCode: o?.code ?? UNATTRIBUTED_ORG,
      orgName: o?.name ?? 'Sede central (sin atribuir)',
      invocations: 0, succeeded: 0, failed: 0, costTotal: 0, costByTool: {},
    }
  }
  const rows = new Map<string, OrgUsageRow>(orgs.map(o => [o.id, blank(o.id)]))
  rows.set(UNATTRIBUTED_ORG, blank(null))

  for (const inv of invs) {
    const projectId = inv.taskId ? taskToProject.get(inv.taskId) : undefined
    const orgId = (projectId ? projectToOrg.get(projectId) : undefined) ?? null
    const key = orgId ?? UNATTRIBUTED_ORG
    const row = rows.get(key) ?? blank(orgId)
    rows.set(key, row)
    row.invocations += 1
    if (inv.status === 'SUCCEEDED') row.succeeded += 1
    if (['FAILED', 'TIMEOUT', 'CHECKS_FAILED'].includes(inv.status)) row.failed += 1
    const cost = inv.cost ?? 0
    if (cost !== 0) {
      row.costTotal += cost
      row.costByTool[inv.toolCode] = (row.costByTool[inv.toolCode] ?? 0) + cost
    }
  }

  const list = [...rows.values()].map(r => ({
    ...r,
    costTotal: Math.round(r.costTotal * 1e6) / 1e6,
  }))
  list.sort((a, b) => b.invocations - a.invocations)
  const totals = list.reduce(
    (acc, r) => ({
      orgId: null, orgCode: 'TOTAL', orgName: 'Total ecosistema',
      invocations: acc.invocations + r.invocations,
      succeeded: acc.succeeded + r.succeeded,
      failed: acc.failed + r.failed,
      costTotal: Math.round((acc.costTotal + r.costTotal) * 1e6) / 1e6,
      costByTool: {},
    }),
    blank(null),
  )
  return { rows: list, totals }
}
