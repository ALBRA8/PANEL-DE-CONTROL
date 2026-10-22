'use client'

// ============================================================
// EEC — PANTALLA CENTRAL v2 (spec §38)
// KPIs operacionales con sparklines de tendencia real + agentes +
// runs en curso + flujo de eventos en vivo + ritmo de eventos por
// namespace + trabajo bloqueado.
// Ley de oro: las tendencias NO se inventan. Se acumulan en memoria
// del componente a partir de los snapshots que llegan al store
// (observación honesta, etiquetada "desde la apertura de la vista").
// ============================================================

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Bot,
  Server,
  ShieldAlert,
  Stamp,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { useEecStore } from '@/store/eec-store'
import {
  AGENT_STATE_STYLE,
  type EecAgent,
  type EecApproval,
  type EecEventItem,
  type EecHealth,
  type EecRun,
  type EecRuntime,
  type EecSnapshot,
  type EecTask,
} from '@/lib/eec-client'
import { cn } from '@/lib/utils'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

// ---------- Helpers locales ----------

const RUN_STATUS_CHIP: Record<string, string> = {
  PENDING: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  RUNNING: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  WAITING_APPROVAL: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SUCCEEDED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
  TIMED_OUT: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
}

function runtimeDot(status: string | undefined): string {
  switch (status) {
    case 'RUNNING':
    case 'READY':
      return 'bg-emerald-400'
    case 'IDLE':
      return 'bg-teal-400'
    case 'ERROR':
    case 'CRASHED':
    case 'UNHEALTHY':
      return 'bg-rose-500'
    case 'RECOVERING':
    case 'STARTING':
    case 'STOPPING':
      return 'bg-amber-400'
    default:
      return 'bg-slate-600'
  }
}

/** Color del tipo de evento según su namespace (agent.task.workflow.run…). */
function eventNamespaceColor(eventType: string): string {
  const ns = eventType.split(/[._]/)[0] ?? eventType
  switch (ns) {
    case 'agent':
    case 'run':
      return 'text-emerald-300'
    case 'task':
    case 'client':
    case 'tool':
      return 'text-teal-300'
    case 'workflow':
      return 'text-violet-300'
    case 'runtime':
      return 'text-amber-300'
    case 'approval':
      return 'text-orange-300'
    case 'meeting':
      return 'text-fuchsia-300'
    case 'system':
      return 'text-slate-400'
    default:
      return 'text-slate-400'
  }
}

function shortClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', { hour12: false })
}

// ---------- Historial real en memoria (observación, no fabricación) ----------

/** Muestra derivada EXCLUSIVAMENTE de un snapshot real recibido del store. */
interface HistorySample {
  t: number
  activeAgents: number
  runsActive: number
  approvalsPending: number
  blockedTasks: number
  runtimesRunning: number
  meetingsActive: number
}

const HISTORY_MAX = 60

function sampleFrom(snapshot: EecSnapshot): HistorySample {
  const h = snapshot.health
  const ts = new Date(snapshot.generatedAt).getTime()
  return {
    t: Number.isFinite(ts) ? ts : Date.now(),
    activeAgents: (h.agentsByState.IDLE ?? 0) + (h.agentsByState.WORKING ?? 0),
    runsActive: h.runsActive,
    approvalsPending: h.approvalsPending,
    blockedTasks: h.blockedTasks,
    runtimesRunning: h.runtimesRunning,
    meetingsActive: h.meetingsActive,
  }
}

/**
 * Buffer circular (máx 60) que observa los snapshots que LLEGAN al store.
 * La primera muestra se siembra al montar (lo que ya llegó) y cada snapshot
 * NUEVO se agrega vía suscripción al store (dedupe por generatedAt). Si la
 * vista se cierra y reabre, el historial se reinicia — por eso las etiquetas
 * dicen "desde la apertura de la vista".
 */
function useSnapshotHistory(snapshot: EecSnapshot | null): HistorySample[] {
  const [history, setHistory] = useState<HistorySample[]>(() =>
    snapshot ? [sampleFrom(snapshot)] : [],
  )
  const lastGeneratedRef = useRef<string | null>(snapshot?.generatedAt ?? null)

  useEffect(() => {
    // Suscripción al sistema externo (store zustand): setState SOLO dentro del
    // callback de suscripción, una muestra por snapshot nuevo que llega.
    const unsubscribe = useEecStore.subscribe((state, prevState) => {
      const snap = state.snapshot
      if (!snap || snap === prevState.snapshot) return
      if (lastGeneratedRef.current === snap.generatedAt) return
      lastGeneratedRef.current = snap.generatedAt
      const sample = sampleFrom(snap)
      setHistory((prev) => {
        const next = [...prev, sample]
        return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next
      })
    })
    return unsubscribe
  }, [])

  return history
}

// ---------- Sparkline (área mini, sin ejes, tendencia real) ----------

function Sparkline({
  data,
  color,
  seriesLabel,
}: {
  data: Array<{ t: number; v: number }>
  color: string
  seriesLabel: string
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-8 items-center justify-center rounded bg-slate-800/40 text-[9px] uppercase tracking-wider text-slate-600">
        acumulando…
      </div>
    )
  }
  return (
    <div
      className="h-8 w-full"
      role="img"
      aria-label={`Tendencia de ${seriesLabel} sobre ${data.length} muestras reales`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 3, right: 2, bottom: 0, left: 2 }}>
          <XAxis dataKey="t" hide />
          <YAxis hide domain={[0, 'dataMax + 1']} />
          <Tooltip
            cursor={{ stroke: 'rgba(148,163,184,0.4)', strokeWidth: 1 }}
            contentStyle={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 6,
              fontSize: 11,
              padding: '4px 8px',
            }}
            labelFormatter={(label) =>
              new Date(Number(label)).toLocaleTimeString('es-CO', { hour12: false })
            }
            formatter={(value) => [String(value), seriesLabel]}
          />
          <Area
            type="monotone"
            dataKey="v"
            name={seriesLabel}
            stroke={color}
            fill={color}
            fillOpacity={0.18}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------- Desgloses reales para KPIs (title / aria-describedby) ----------

const AGENT_STATE_ORDER: readonly string[] = [
  'WORKING', 'IDLE', 'WAITING', 'IN_MEETING', 'REVIEW', 'PAUSED',
  'RECOVERY', 'BLOCKED', 'ERROR', 'SUSPENDED', 'OFFLINE',
]

function agentsDetail(byState: Record<string, number>): string {
  const entries: Array<[string, number]> = []
  for (const st of AGENT_STATE_ORDER) {
    const n = byState[st] ?? 0
    if (n > 0) entries.push([st, n])
  }
  for (const [st, n] of Object.entries(byState)) {
    if (n > 0 && !AGENT_STATE_ORDER.includes(st)) entries.push([st, n])
  }
  return entries.length
    ? `Desglose real: ${entries.map(([st, n]) => `${n} ${st}`).join(' · ')}`
    : 'Desglose real: sin agentes por estado'
}

function runsDetail(runs: EecRun[]): string {
  let running = 0
  let waiting = 0
  for (const r of runs) {
    if (r.status === 'RUNNING') running += 1
    else if (r.status === 'WAITING_APPROVAL') waiting += 1
  }
  return `Desglose real: ${running} RUNNING · ${waiting} WAITING_APPROVAL`
}

const RISK_ORDER: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

function approvalsDetail(list: EecApproval[]): string {
  const pending = list.filter((a) => a.status === 'REQUESTED')
  if (pending.length === 0) return 'Desglose real: nada pendiente de decisión humana'
  const byRisk = new Map<string, number>()
  for (const a of pending) byRisk.set(a.risk, (byRisk.get(a.risk) ?? 0) + 1)
  const parts: string[] = []
  for (const r of RISK_ORDER) {
    const n = byRisk.get(r) ?? 0
    if (n > 0) parts.push(`${n} ${r}`)
  }
  for (const [r, n] of byRisk) {
    if (!RISK_ORDER.includes(r) && n > 0) parts.push(`${n} ${r}`)
  }
  return `Desglose real: ${parts.join(' · ')} (REQUESTED)`
}

const MEETING_ORDER: readonly string[] = ['IN_PROGRESS', 'INVITED', 'SCHEDULED']

function meetingsDetail(list: EecSnapshot['meetings']): string {
  const parts: string[] = []
  for (const st of MEETING_ORDER) {
    const n = list.filter((m) => m.status === st).length
    if (n > 0) parts.push(`${n} ${st}`)
  }
  return parts.length ? `Desglose real: ${parts.join(' · ')}` : 'Desglose real: sin reuniones activas'
}

function blockedDetail(list: EecTask[]): string {
  let blocked = 0
  let failed = 0
  for (const t of list) {
    if (t.status === 'BLOCKED') blocked += 1
    else if (t.status === 'FAILED') failed += 1
  }
  return `Desglose real: ${blocked} BLOCKED · ${failed} FAILED`
}

const RUNTIME_ORDER: readonly string[] = [
  'RUNNING', 'IDLE', 'STARTING', 'RECOVERING', 'STOPPING', 'ERROR', 'CRASHED', 'UNHEALTHY',
]

function runtimesDetail(agents: EecAgent[]): string {
  const byStatus = new Map<string, number>()
  for (const a of agents) {
    for (const rt of a.runtimes) byStatus.set(rt.status, (byStatus.get(rt.status) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const st of RUNTIME_ORDER) {
    const n = byStatus.get(st) ?? 0
    if (n > 0) parts.push(`${n} ${st}`)
  }
  for (const [st, n] of byStatus) {
    if (!RUNTIME_ORDER.includes(st) && n > 0) parts.push(`${n} ${st}`)
  }
  return parts.length ? `Desglose real: ${parts.join(' · ')}` : 'Desglose real: sin runtimes registrados'
}

// ---------- Ritmo de eventos (reales del store, agrupados por minuto) ----------

const PACE_WINDOW_MS = 10 * 60 * 1000

/** Paleta del proyecto por namespace — sin azul/índigo. */
const PACE_OTHER_COLOR = '#64748b'
const NS_CHART_COLOR: Record<string, string> = {
  agent: '#34d399', // emerald-400
  run: '#6ee7b7', // emerald-300
  task: '#2dd4bf', // teal-400
  client: '#5eead4', // teal-300
  tool: '#99f6e4', // teal-200
  workflow: '#a78bfa', // violet-400
  memory: '#c4b5fd', // violet-300
  knowledge: '#c4b5fd', // violet-300
  runtime: '#fbbf24', // amber-400
  approval: '#fb923c', // orange-400
  meeting: '#e879f9', // fuchsia-400
  system: '#94a3b8', // slate-400
}

const NS_PACE_ORDER: readonly string[] = [
  'agent', 'run', 'task', 'workflow', 'runtime', 'approval', 'meeting', 'system',
  'client', 'tool', 'memory', 'knowledge', 'otros',
]

interface PaceRow {
  label: string
  [ns: string]: string | number
}

interface PaceData {
  rows: PaceRow[]
  series: string[]
  count: number
  windowLabel: string
}

function nsKey(eventType: string): string {
  return eventType.split('.')[0] ?? 'otros'
}

const minuteFloor = (ms: number): number => Math.floor(ms / 60000) * 60000

const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false })

/** Agrupa los eventos reales del store por minuto (ventana 10 min) para el gráfico apilado. */
function buildPaceData(events: EecEventItem[]): PaceData {
  const now = Date.now()
  const windowStart = now - PACE_WINDOW_MS

  const inWindow = events.filter((e) => {
    const ts = new Date(e.timestamp).getTime()
    return Number.isFinite(ts) && ts >= windowStart
  })

  if (inWindow.length === 0) {
    return { rows: [], series: [], count: 0, windowLabel: 'últimos 10 min' }
  }

  const oldestInWindow = Math.min(...inWindow.map((e) => new Date(e.timestamp).getTime()))
  const firstBucket = minuteFloor(Math.max(windowStart, oldestInWindow))
  const lastBucket = minuteFloor(now)

  const counts = new Map<number, Map<string, number>>()
  for (let b = firstBucket; b <= lastBucket; b += 60000) counts.set(b, new Map())
  for (const e of inWindow) {
    const bucket = counts.get(minuteFloor(new Date(e.timestamp).getTime()))
    if (!bucket) continue
    const ns = nsKey(e.event_type)
    bucket.set(ns, (bucket.get(ns) ?? 0) + 1)
  }

  const totals = new Map<string, number>()
  for (const bucket of counts.values()) {
    for (const [ns, n] of bucket) totals.set(ns, (totals.get(ns) ?? 0) + n)
  }

  const known = [...NS_PACE_ORDER].filter((ns) => ns !== 'otros' && (totals.get(ns) ?? 0) > 0)
  const unknownTotal = [...totals.entries()]
    .filter(([ns]) => !NS_PACE_ORDER.includes(ns))
    .reduce((acc, [, n]) => acc + n, 0)
  const series = unknownTotal > 0 ? [...known, 'otros'] : known

  const rows: PaceRow[] = []
  for (let b = firstBucket; b <= lastBucket; b += 60000) {
    const bucket = counts.get(b) ?? new Map<string, number>()
    const row: PaceRow = { label: hhmm(b) }
    for (const ns of series) {
      if (ns === 'otros') {
        let sum = 0
        for (const [k, n] of bucket) if (!NS_PACE_ORDER.includes(k)) sum += n
        row[ns] = sum
      } else {
        row[ns] = bucket.get(ns) ?? 0
      }
    }
    rows.push(row)
  }

  // Etiqueta honesta: si el buffer local empezó dentro de la ventana, se declara.
  const oldestBuffer = events.length
    ? Math.min(...events.map((e) => new Date(e.timestamp).getTime()).filter(Number.isFinite))
    : null
  const bufferCoversWindow = oldestBuffer != null && Number.isFinite(oldestBuffer) && oldestBuffer <= windowStart
  const windowLabel = bufferCoversWindow
    ? 'últimos 10 min'
    : `desde ${hhmm(firstBucket)} (inicio del buffer local)`

  return { rows, series, count: inWindow.length, windowLabel }
}

function paceColor(ns: string): string {
  return NS_CHART_COLOR[ns] ?? PACE_OTHER_COLOR
}

function EventPacePanel() {
  const events = useEecStore((s) => s.events)
  const pace = useMemo(() => buildPaceData(events), [events])

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <BarChart3 className="h-4 w-4 text-violet-300" aria-hidden />
          Ritmo de eventos
        </CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Eventos reales del buffer del store, agrupados por minuto · ventana: {pace.windowLabel} ·{' '}
          {pace.count} eventos
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {pace.rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-slate-800 px-4 text-center text-xs text-slate-500">
            Sin eventos reales en los últimos 10 min — el ritmo aparecerá en cuanto el bus emita.
          </div>
        ) : (
          <div className="h-44 w-full" role="img" aria-label={`Ritmo de eventos: ${pace.count} eventos en ${pace.rows.length} minutos`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pace.rows} margin={{ top: 6, right: 6, bottom: 0, left: -14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.14)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={{ stroke: '#334155' }}
                  tickLine={false}
                  minTickGap={26}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                  width={38}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  labelStyle={{ color: '#e2e8f0', marginBottom: 4 }}
                  itemStyle={{ padding: 0 }}
                />
                {pace.series.map((ns) => (
                  <Bar key={ns} dataKey={ns} stackId="ritmo" fill={paceColor(ns)} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {pace.series.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Series del ritmo de eventos">
            {pace.series.map((ns) => (
              <span key={ns} className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
                <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: paceColor(ns) }} aria-hidden />
                {ns}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- KPI ----------

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
  detail,
  descId,
  spark,
  sparkNote,
}: {
  icon: LucideIcon
  label: string
  value: number | string
  sub?: string
  tone?: 'neutral' | 'amber' | 'rose' | 'emerald'
  detail?: string
  descId?: string
  spark?: { data: Array<{ t: number; v: number }>; color: string; seriesLabel: string }
  sparkNote?: string
}) {
  const valueTone =
    tone === 'rose'
      ? 'text-rose-300'
      : tone === 'amber'
        ? 'text-amber-300'
        : tone === 'emerald'
          ? 'text-emerald-300'
          : 'text-slate-100'
  const iconTone =
    tone === 'rose'
      ? 'text-rose-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'emerald'
          ? 'text-emerald-400'
          : 'text-slate-500'

  return (
    <Card
      className="gap-2 rounded-lg border-slate-800/80 bg-slate-900/60 p-4"
      title={detail ?? label}
      aria-describedby={descId}
    >
      {detail && descId && (
        <span id={descId} className="sr-only">
          {detail}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
          <p className={cn('mt-1 font-mono text-2xl font-semibold leading-none', valueTone)}>
            {value}
          </p>
          {sub && <p className="mt-1.5 truncate text-[11px] text-slate-500">{sub}</p>}
        </div>
        <Icon className={cn('h-5 w-5 shrink-0', iconTone)} aria-hidden />
      </div>
      {spark && (
        <div className="mt-1 space-y-0.5">
          <Sparkline data={spark.data} color={spark.color} seriesLabel={spark.seriesLabel} />
          {sparkNote && (
            <p className="truncate text-[10px] text-slate-600" title={sparkNote}>
              {sparkNote}
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// ---------- Paneles ----------

const AgentRow = memo(function AgentRow({
  agent,
  onSelect,
}: {
  agent: EecAgent
  onSelect: (id: string) => void
}) {
  const st = AGENT_STATE_STYLE[agent.state]
  const rt: EecRuntime | undefined = agent.runtimes[0]
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
        'hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50',
      )}
      aria-label={`Inspeccionar agente ${agent.code}`}
    >
      <span
        className={cn('h-2.5 w-2.5 shrink-0 rounded-full', st?.dot ?? 'bg-slate-600')}
        aria-hidden
      />
      <span className="w-14 shrink-0 font-mono text-xs text-slate-400">{agent.code}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-slate-200">
          {agent.name}
          <span className="text-slate-500"> · {agent.role}</span>
        </span>
        <span className="block truncate text-xs text-slate-500">
          {agent.activity ?? (agent.state === 'OFFLINE' ? 'sin conexión' : 'sin actividad reportada')}
        </span>
      </span>
      <Badge
        variant="outline"
        className={cn(
          'shrink-0 border font-mono text-[10px]',
          st?.chip ?? 'border-slate-600/40 bg-slate-600/20 text-slate-400',
        )}
      >
        {st?.label ?? agent.state}
      </Badge>
      <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] text-slate-500 sm:flex">
        <span className={cn('h-1.5 w-1.5 rounded-full', runtimeDot(rt?.status))} aria-hidden />
        {rt ? rt.status : 'SIN RT'}
      </span>
    </button>
  )
})

function AgentsPanel() {
  const snapshot = useEecStore((s) => s.snapshot)
  const selectAgent = useEecStore((s) => s.selectAgent)
  const agents = snapshot?.agents ?? []

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60">
      <CardHeader className="pb-0">
        <CardTitle className="text-sm font-semibold text-slate-200">Agentes</CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Estado operacional en vivo. Clic para inspeccionar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {agents.length === 0 && (
          <p className="px-2 py-4 text-xs text-slate-500">Sin agentes registrados.</p>
        )}
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} onSelect={selectAgent} />
        ))}
      </CardContent>
    </Card>
  )
}

function RunRow({ run }: { run: EecRun }) {
  return (
    <div className="rounded-md border border-slate-800/60 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-teal-300">{run.task?.code ?? '—'}</span>
        {run.workflow && (
          <span className="font-mono text-[10px] text-violet-300">{run.workflow.code}</span>
        )}
        {run.agent && (
          <span className="font-mono text-[10px] text-slate-500">{run.agent.code}</span>
        )}
        <Badge
          variant="outline"
          className={cn(
            'ml-auto shrink-0 border font-mono text-[10px]',
            RUN_STATUS_CHIP[run.status] ?? 'border-slate-500/30 bg-slate-500/15 text-slate-300',
          )}
        >
          {run.status}
        </Badge>
      </div>
      <Progress
        value={run.progress}
        className="mt-2 h-1.5 bg-slate-800 [&>div]:bg-emerald-400"
        aria-label={`Progreso del run ${run.progress}%`}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-mono text-slate-500">{run.currentNode ?? 'nodo —'}</span>
        <span className="shrink-0 font-mono text-slate-500">{run.progress}%</span>
      </div>
      {run.error && (
        <p className="mt-1 truncate text-[11px] text-rose-400" title={run.error}>
          {run.error}
        </p>
      )}
    </div>
  )
}

function ActiveRunsPanel() {
  const snapshot = useEecStore((s) => s.snapshot)
  const activeRuns = useMemo(
    () =>
      (snapshot?.runs ?? [])
        .filter((r) => r.status === 'RUNNING' || r.status === 'WAITING_APPROVAL')
        .slice(0, 12),
    [snapshot],
  )

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60">
      <CardHeader className="pb-0">
        <CardTitle className="text-sm font-semibold text-slate-200">Runs en curso</CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Progreso real reportado por el motor.
        </CardDescription>
      </CardHeader>
      <CardContent className="eec-scroll max-h-96 space-y-2 overflow-y-auto">
        {activeRuns.length === 0 && (
          <p className="px-1 py-4 text-xs text-slate-500">Sin runs activos en este momento.</p>
        )}
        {activeRuns.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </CardContent>
    </Card>
  )
}

const EventRow = memo(function EventRow({ event }: { event: EecEventItem }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-[11px]">
      <span className="shrink-0 font-mono text-slate-600">{shortClock(event.timestamp)}</span>
      <span className={cn('shrink-0 font-mono', eventNamespaceColor(event.event_type))}>
        {event.event_type}
      </span>
      {event.sim && (
        <Badge
          variant="outline"
          className="shrink-0 border-slate-600/40 bg-slate-600/20 px-1 py-0 font-mono text-[9px] text-slate-400"
        >
          SIM
        </Badge>
      )}
      <span className="min-w-0 flex-1 truncate text-slate-400" title={event.subject}>
        {event.subject}
      </span>
    </div>
  )
})

function EventsPanel() {
  const events = useEecStore((s) => s.events)
  const feed = useMemo(() => events.slice(0, 40), [events])

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60 lg:col-span-2 xl:col-span-1">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden />
          Flujo de eventos en vivo
        </CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Últimos 40 eventos del bus (realtime + respaldo).
        </CardDescription>
      </CardHeader>
      <CardContent className="eec-scroll max-h-96 overflow-y-auto">
        {feed.length === 0 ? (
          <p className="px-1 py-4 text-xs text-slate-500">
            Sin eventos recibidos todavía. Esperando actividad real del motor…
          </p>
        ) : (
          <div className="divide-y divide-slate-800/40">
            {feed.map((e) => (
              <EventRow key={e.seq} event={e} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AttentionPanel() {
  const snapshot = useEecStore((s) => s.snapshot)

  const blockedTasks = useMemo(
    () =>
      (snapshot?.tasks ?? [])
        .filter((t: EecTask) => t.status === 'BLOCKED' || t.status === 'FAILED')
        .slice(0, 8),
    [snapshot],
  )
  const failedRuns = useMemo(
    () =>
      (snapshot?.runs ?? [])
        .filter((r) => r.status === 'FAILED')
        .slice(0, 5),
    [snapshot],
  )

  const empty = blockedTasks.length === 0 && failedRuns.length === 0

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60">
      <CardHeader className="pb-0">
        <CardTitle className="text-sm font-semibold text-slate-200">
          Trabajo bloqueado / atención
        </CardTitle>
        <CardDescription className="text-xs text-slate-500">
          Tareas BLOCKED o FAILED y runs fallados recientes.
        </CardDescription>
      </CardHeader>
      <CardContent className="eec-scroll max-h-96 space-y-2 overflow-y-auto">
        {empty && (
          <p className="px-1 py-4 text-xs text-emerald-300/80">
            Sin trabajo bloqueado. La operación está limpia.
          </p>
        )}
        {blockedTasks.map((t) => (
          <div
            key={t.id}
            className="rounded-md border border-slate-800/60 bg-slate-950/40 p-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-400">{t.code}</span>
              <Badge
                variant="outline"
                className={cn(
                  'border font-mono text-[10px]',
                  t.status === 'FAILED'
                    ? 'border-rose-600/40 bg-rose-600/15 text-rose-300'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-300',
                )}
              >
                {t.status}
              </Badge>
              {t.assignee && (
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                  {t.assignee.code}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-slate-300" title={t.title}>
              {t.title}
            </p>
          </div>
        ))}
        {failedRuns.map((run) => (
          <div
            key={run.id}
            className="rounded-md border border-rose-900/40 bg-rose-950/20 p-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-rose-300">{run.task?.code ?? '—'}</span>
              <span className="font-mono text-[10px] text-slate-500">run FAILED</span>
              {run.agent && (
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                  {run.agent.code}
                </span>
              )}
            </div>
            {run.error && (
              <p className="mt-1 truncate text-[11px] text-rose-400/90" title={run.error}>
                {run.error}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function CentralSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-7 w-64 bg-slate-800" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 bg-slate-800" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-72 bg-slate-800" />
        ))}
      </div>
    </div>
  )
}

// ---------- Pantalla ----------

export default function CentralScreen() {
  const snapshot = useEecStore((s) => s.snapshot)
  const history = useSnapshotHistory(snapshot)

  const health = snapshot?.health
  const activeAgents = health
    ? (health.agentsByState.IDLE ?? 0) + (health.agentsByState.WORKING ?? 0)
    : 0

  // Series de tendencia derivadas del historial real observado.
  const sparks = useMemo(
    () => ({
      agents: history.map((s) => ({ t: s.t, v: s.activeAgents })),
      runs: history.map((s) => ({ t: s.t, v: s.runsActive })),
      approvals: history.map((s) => ({ t: s.t, v: s.approvalsPending })),
      blocked: history.map((s) => ({ t: s.t, v: s.blockedTasks })),
    }),
    [history],
  )

  // Etiqueta honesta: la ventana es la que lleve la vista abierta (buffer en memoria).
  const sparkNote = useMemo(() => {
    if (history.length < 2) return 'acumulando muestras reales…'
    const spanMin = Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60000))
    return `tendencia real · ~${spanMin} min (desde la apertura de la vista)`
  }, [history])

  // Desgloses reales para los atributos de accesibilidad de cada KPI.
  const details = useMemo(() => {
    if (!snapshot || !health) return null
    return {
      agents: agentsDetail(health.agentsByState),
      runs: runsDetail(snapshot.runs),
      approvals: approvalsDetail(snapshot.approvals),
      meetings: meetingsDetail(snapshot.meetings),
      blocked: blockedDetail(snapshot.tasks),
      runtimes: runtimesDetail(snapshot.agents),
    }
  }, [snapshot, health])

  if (!snapshot || !health || !details) return <CentralSkeleton />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-100">Central de operaciones</h1>
        <span className="font-mono text-[10px] text-slate-600" suppressHydrationWarning>
          generado {new Date(snapshot.generatedAt).toLocaleTimeString('es-CO', { hour12: false })}
        </span>
      </div>

      {/* Fila de KPIs con tendencias reales */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          icon={Bot}
          label="Agentes activos"
          value={activeAgents}
          sub={`de ${health.agentsTotal} totales`}
          tone="emerald"
          detail={details.agents}
          descId="kpi-desc-agentes"
          spark={{ data: sparks.agents, color: '#2dd4bf', seriesLabel: 'agentes activos' }}
          sparkNote={sparkNote}
        />
        <Kpi
          icon={Activity}
          label="Runs activos"
          value={health.runsActive}
          detail={details.runs}
          descId="kpi-desc-runs"
          spark={{ data: sparks.runs, color: '#34d399', seriesLabel: 'runs activos' }}
          sparkNote={sparkNote}
        />
        <Kpi
          icon={Stamp}
          label="Aprobaciones pendientes"
          value={health.approvalsPending}
          tone={health.approvalsPending > 0 ? 'amber' : 'neutral'}
          detail={details.approvals}
          descId="kpi-desc-aprobaciones"
          spark={{ data: sparks.approvals, color: '#fbbf24', seriesLabel: 'aprobaciones pendientes' }}
          sparkNote={sparkNote}
        />
        <Kpi
          icon={Users}
          label="Reuniones activas"
          value={health.meetingsActive}
          detail={details.meetings}
          descId="kpi-desc-reuniones"
        />
        <Kpi
          icon={ShieldAlert}
          label="Tareas bloqueadas"
          value={health.blockedTasks}
          tone={health.blockedTasks > 0 ? 'rose' : 'neutral'}
          detail={details.blocked}
          descId="kpi-desc-bloqueadas"
          spark={{ data: sparks.blocked, color: '#f43f5e', seriesLabel: 'tareas bloqueadas' }}
          sparkNote={sparkNote}
        />
        <Kpi
          icon={Server}
          label="Runtimes corriendo"
          value={health.runtimesRunning}
          detail={details.runtimes}
          descId="kpi-desc-runtimes"
        />
      </div>

      {/* Paneles operacionales */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <AgentsPanel />
        <ActiveRunsPanel />
        <EventsPanel />
        <div className="lg:col-span-2 xl:col-span-2">
          <EventPacePanel />
        </div>
        <div className="lg:col-span-2 xl:col-span-1">
          <AttentionPanel />
        </div>
      </div>
    </div>
  )
}
