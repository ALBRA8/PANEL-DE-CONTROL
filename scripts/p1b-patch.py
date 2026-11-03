#!/usr/bin/env python3
"""P1-2 (doc 07 #17): motor SLA — parchea workers.ts (TRACKED) sobre la rama
feature/v2-adaptacion-verticales. Añade: SLAMonitor (escalera de plazos con
dedup persistente) + puente de reglas EVENT_TRIGGERED (on(evento) → comando
con plantillas {{event.*}}). Falla ruidosamente si un ancla no es única."""
from pathlib import Path
import sys

def must(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

def patch(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    t = p.read_text(encoding="utf-8")
    must(t.count(old) == 1, f"{path}: ancla no única ({label}): {t.count(old)}")
    p.write_text(t.replace(old, new, 1), encoding="utf-8")
    print(f"{path} OK ({label})", flush=True)

W = "src/lib/eec/engine/workers.ts"

# ---------- 1) banner ----------
patch(W,
      "// - ApprovalExpiry: expiración de aprobaciones (§24).",
      """// - ApprovalExpiry: expiración de aprobaciones (§24).
// - SLAMonitor (P1-2 · doc 07 #17): escalera de plazos WARNING→CRITICAL→OVERDUE.
// - Reglas EVENT_TRIGGERED (P1-2): on(evento) → comando con plantillas {{event.*}}.""",
      "banner SLA")

# ---------- 2) import del envelope ----------
patch(W,
      "import type { AgentInterface, NotificationInterface } from '../domain/contracts'",
      "import type { AgentInterface, NotificationInterface } from '../domain/contracts'\nimport type { EventEnvelope } from '../domain/types'",
      "import envelope")

# ---------- 3) SLA monitor + puente de reglas (antes de ApprovalExpiry) ----------
SLA_BLOCK = """// ---------------- SLA MONITOR (P1-2 · doc 07 #17: plazos) ----------------
// Escalera administrativa de plazos: WARNING (< 24 h) → CRITICAL (< 1 h) →
// OVERDUE (vencido). Cada nivel se emite UNA sola vez por tarea (dedup
// persistente consultando el propio bus: honestidad sin tormentas de eventos;
// sobrevive reinicios del proceso, a diferencia de un Set en memoria).
const SLA_LADDER = [
  { level: 'OVERDUE', maxMinutesLeft: 0, type: 'task.overdue' },
  { level: 'CRITICAL', maxMinutesLeft: 60, type: 'task.deadline_near' },
  { level: 'WARNING', maxMinutesLeft: 24 * 60, type: 'task.deadline_near' },
] as const

export async function slaMonitorTick(): Promise<void> {
  const sim = isSimulationMode()
  const now = Date.now()
  const tasks = await db.task.findMany({
    where: { dueAt: { not: null }, status: { notIn: ['DONE', 'CANCELLED', 'FAILED'] } },
    take: 50, orderBy: { dueAt: 'asc' },
  })
  for (const t of tasks) {
    const minutesLeft = Math.round(((t.dueAt as Date).getTime() - now) / 60_000)
    const hit = SLA_LADDER.find(l => minutesLeft < l.maxMinutesLeft) // primer match = nivel más grave
    if (!hit) continue
    const already = await db.eventRecord.findFirst({
      where: { type: hit.type, subject: `task:${t.id}`, payloadJson: { contains: `"level":"${hit.level}"` } },
      select: { seq: true },
    })
    if (already) continue
    await eventBus.publish({
      event_type: hit.type, source: 'eec.sla', subject: `task:${t.id}`,
      payload: {
        taskId: t.id, code: t.code, title: t.title,
        dueAt: (t.dueAt as Date).toISOString(), minutesLeft,
        level: hit.level, assigneeAgentId: t.assigneeAgentId,
      }, sim,
    })
  }
  // plazos de aprobaciones pendientes: quórum por expirar → urge decidir
  const pending = await db.approval.findMany({ where: { status: 'REQUESTED', expiresAt: { not: null } }, take: 50 })
  for (const a of pending) {
    const minutesLeft = Math.round(((a.expiresAt as Date).getTime() - now) / 60_000)
    if (minutesLeft > 120 || minutesLeft < 0) continue
    const already = await db.eventRecord.findFirst({
      where: { type: 'approval.deadline_near', subject: `approval:${a.id}` },
      select: { seq: true },
    })
    if (already) continue
    await eventBus.publish({
      event_type: 'approval.deadline_near', source: 'eec.sla', subject: `approval:${a.id}`,
      payload: { approvalId: a.id, title: a.title, minutesLeft }, sim,
    })
  }
}

// ---------------- TRIGGERS POR EVENTO (P1-2 · doc 07 #17: on(evento) → comando) ----------------
// Los Schedule EVENT_TRIGGERED escuchan el bus: expression = patrón de evento
// ('task.deadline_near', 'task.*', ...). El payload del comando admite plantillas
// {{event.payload.x}} resueltas con el envelope disparador. Regla administrativa
// típica: on(task.deadline_near) → crear tarea de escalamiento auditable.
// Idempotente por event_id; los eventos del propio puente no re-disparan reglas.
function eventPatternMatches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
  return false
}

function resolveEventTemplate(v: unknown, env: Record<string, unknown>): unknown {
  // la ruta capturada excluye el prefijo 'event.' — se resuelve desde env.event
  const root = (env as Record<string, unknown>).event as Record<string, unknown> | undefined
  const dig = (path: string, base: unknown): unknown =>
    path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], base)
  if (typeof v === 'string') {
    const full = v.match(/^\\{\\{event\\.([\\w.]+)\\}\\}$/)
    if (full) return dig(full[1], root)
    return v.replace(/\\{\\{event\\.([\\w.]+)\\}\\}/g, (_, path: string) => {
      const val = dig(path, root)
      return val === undefined || val === null ? '' : String(val)
    })
  }
  if (Array.isArray(v)) return v.map(x => resolveEventTemplate(x, env))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveEventTemplate(x, env)]))
  }
  return v
}

async function eventTriggeredRulesTick(event: EventEnvelope): Promise<void> {
  if (event.source === 'eec.scheduler-bridge') return // sin bucles: reglas no disparan reglas
  let rules: Array<{ id: string; name: string; expression: string; commandType: string; commandPayloadJson: string }>
  try {
    rules = await db.schedule.findMany({ where: { enabled: true, kind: 'EVENT_TRIGGERED' } })
  } catch { return }
  for (const s of rules) {
    if (!eventPatternMatches(s.expression.trim(), event.event_type)) continue
    let base: Record<string, unknown> = {}
    try { base = JSON.parse(s.commandPayloadJson || '{}') as Record<string, unknown> } catch { base = {} }
    const payload = resolveEventTemplate(base, { event })
    await withTrace(newTrace({ sim: event.sim ?? false, correlationId: event.correlation_id ?? undefined }), async () => {
      await eventBus.publish({
        event_type: 'system.schedule.fired', source: 'eec.scheduler-bridge', subject: `schedule:${s.id}`,
        payload: { scheduleId: s.id, name: s.name, commandType: s.commandType, trigger: event.event_type },
        causation_id: event.event_id,
      })
      await dispatchCommand({
        type: s.commandType,
        payload: (payload ?? {}) as Record<string, unknown>,
        requesterType: 'SYSTEM', requesterId: 'eec:scheduler-bridge',
        idempotencyKey: `sched-ev:${s.id}:${event.event_id}`,
      })
    })
    await db.schedule.update({ where: { id: s.id }, data: { lastRunAt: new Date() } }).catch(() => undefined)
  }
}

function subscribeEventTriggeredRules(): void {
  const g = globalForWorkers as unknown as { __eecSchedBridge?: boolean }
  if (g.__eecSchedBridge) return
  g.__eecSchedBridge = true
  eventBus.subscribe('*', eventTriggeredRulesTick)
}

// ---------------- APPROVAL EXPIRY (§24) ----------------"""
patch(W, "// ---------------- APPROVAL EXPIRY (§24) ----------------", SLA_BLOCK, "bloque SLA + puente")

# ---------- 4) arrancar el worker ----------
patch(W,
      "  every(30_000, 'approval-expiry', approvalExpiryTick)",
      "  every(30_000, 'approval-expiry', approvalExpiryTick)\n  every(30_000, 'sla-monitor', slaMonitorTick)",
      "worker sla-monitor")

# ---------- 5) suscribir el puente de reglas ----------
patch(W,
      "  subscribeNotificationRouter()\n  globalForWorkers.__eecWorkers = handles",
      "  subscribeNotificationRouter()\n  subscribeEventTriggeredRules()\n  globalForWorkers.__eecWorkers = handles",
      "suscribir puente reglas")

# ---------- 6) tick determinista para tests ----------
patch(W,
      "  await approvalExpiryTick()\n}",
      "  await approvalExpiryTick()\n  await slaMonitorTick()\n}",
      "runTicksOnce sla")

# ---------- 7) reglas de notificación ----------
patch(W,
      "    'handoff.rejected': { severity: 'WARNING', title: p => `Traspaso rechazado: ${String(p.subject ?? p.handoffId)}` },",
      """    'handoff.rejected': { severity: 'WARNING', title: p => `Traspaso rechazado: ${String(p.subject ?? p.handoffId)}` },
    'task.deadline_near': { severity: 'WARNING', title: p => `Plazo cerca: ${String(p.title ?? p.taskId)} (${String(p.minutesLeft)} min)` },
    'task.overdue': { severity: 'ERROR', title: p => `PLAZO VENCIDO: ${String(p.title ?? p.taskId)}` },
    'approval.deadline_near': { severity: 'WARNING', title: p => `Aprobación por expirar: ${String(p.title ?? p.approvalId)}` },""",
      "reglas SLA notificaciones")

# ---------- verificación final ----------
t = Path(W).read_text(encoding="utf-8")
for marker, n in [("slaMonitorTick", 3), ("subscribeEventTriggeredRules", 2), ("resolveEventTemplate", 3), ("SLA_LADDER", 2)]:
    must(t.count(marker) >= n, f"{marker}: apariciones {t.count(marker)} < {n}")
print("P1-2 patch: TODO OK", flush=True)
