// ============================================================
// EEC — OBSERVATORIO CONSOLIDADO (línea principal V2 · spec §27)
// Un snapshot único de la sala de situación: doctor (P2-2), cadena
// hash de auditoría (P0-1), contadores adversariales (P1-3),
// veredictos del eval harness (P2-1), escalera SLA (P1-2),
// dead-letters del bus, eventos por tipo (24 h) y uso/coste por
// organización (P2-4). SOLO LECTURA: declara el estado observado,
// nunca repara ni simula. Toda la aggregates salen de la BD viva.
// ============================================================
import { db } from '../../../lib/db'
import { runDoctor, type DoctorReport } from './doctor'
import { verifyAuditChain, type ChainVerifyResult } from './audit-chain'
import { isSimulationMode } from '../commands/pipeline'
import { getOrgUsage, resolveOrgFlags, type OrgUsageRow, type ResolvedOrgFlag } from './org-flags'

export interface AdversarialCounters {
  blocked24h: number
  review24h: number
}

export interface EvalCounters {
  pass24h: number
  fail24h: number
}

/** Escalera SLA observada sobre tareas con plazo abierto. */
export interface SlaBuckets {
  overdue: number
  critical: number
  warning: number
  onTrack: number
}

export interface EventCount {
  type: string
  count: number
}

export interface OrgSnapshot {
  id: string
  code: string
  name: string
  flags: Record<string, ResolvedOrgFlag>
}

export interface ObservatorySnapshot {
  generatedAt: string
  simMode: boolean
  durationMs: number
  doctor: DoctorReport
  chain: ChainVerifyResult
  adversarial: AdversarialCounters
  evals: EvalCounters
  approvalsPending: number
  sla: SlaBuckets
  deadLetters: number
  eventsByType: EventCount[]
  orgs: OrgSnapshot[]
  usage: { rows: OrgUsageRow[]; totals: OrgUsageRow }
}

const SLA_WARNING_MIN = 24 * 60
const SLA_CRITICAL_MIN = 60

/**
 * Construye el snapshot consolidado del observatorio. Cada bloque se
 * lee de la BD viva; ningún valor es decorativo ni cacheado. Si un
 * bloque falla, el doctor ya lo declara — aquí no se traga nada.
 */
export async function buildObservatorySnapshot(): Promise<ObservatorySnapshot> {
  const t0 = Date.now()
  const since24h = new Date(Date.now() - 24 * 3600_000)

  const [doctor, chain, advMetrics, evalEvents, approvalsPending, slaTasks, deadLetters, grouped, orgs, usage] =
    await Promise.all([
      runDoctor(),
      verifyAuditChain(),
      db.metric.findMany({
        where: { name: { in: ['eec.adversarial.blocked', 'eec.adversarial.review'] }, ts: { gte: since24h } },
        select: { name: true, value: true },
      }),
      db.eventRecord.findMany({
        where: { type: 'eval.completed', createdAt: { gte: since24h } },
        select: { payloadJson: true },
      }),
      db.approval.count({ where: { status: 'REQUESTED' } }),
      db.task.findMany({
        where: { dueAt: { not: null }, status: { notIn: ['DONE', 'CANCELLED', 'FAILED'] } },
        select: { dueAt: true },
      }),
      db.eventRecord.count({ where: { status: 'DEAD_LETTER' } }),
      db.eventRecord.groupBy({
        by: ['type'],
        where: { createdAt: { gte: since24h } },
        _count: { type: true },
        orderBy: { _count: { type: 'desc' } },
        take: 8,
      }),
      db.organization.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
      getOrgUsage(),
    ])

  const adversarial: AdversarialCounters = { blocked24h: 0, review24h: 0 }
  for (const m of advMetrics) {
    if (m.name === 'eec.adversarial.blocked') adversarial.blocked24h += m.value
    if (m.name === 'eec.adversarial.review') adversarial.review24h += m.value
  }

  const evals: EvalCounters = { pass24h: 0, fail24h: 0 }
  for (const ev of evalEvents) {
    try {
      const payload = JSON.parse(ev.payloadJson) as { verdict?: string }
      if (payload.verdict === 'PASS') evals.pass24h += 1
      if (payload.verdict === 'FAIL') evals.fail24h += 1
    } catch { /* evento malformado no se cuenta como veredicto */ }
  }

  const now = Date.now()
  const sla: SlaBuckets = { overdue: 0, critical: 0, warning: 0, onTrack: 0 }
  for (const t of slaTasks) {
    const minutesLeft = Math.round((new Date(t.dueAt as Date).getTime() - now) / 60_000)
    if (minutesLeft < 0) sla.overdue += 1
    else if (minutesLeft < SLA_CRITICAL_MIN) sla.critical += 1
    else if (minutesLeft < SLA_WARNING_MIN) sla.warning += 1
    else sla.onTrack += 1
  }

  const orgSnapshots: OrgSnapshot[] = []
  for (const o of orgs) {
    orgSnapshots.push({ id: o.id, code: o.code, name: o.name, flags: await resolveOrgFlags(o.id) })
  }

  return {
    generatedAt: new Date().toISOString(),
    simMode: isSimulationMode(),
    durationMs: Date.now() - t0,
    doctor,
    chain,
    adversarial,
    evals,
    approvalsPending,
    sla,
    deadLetters,
    eventsByType: grouped.map(g => ({ type: g.type, count: g._count.type })),
    orgs: orgSnapshots,
    usage,
  }
}
