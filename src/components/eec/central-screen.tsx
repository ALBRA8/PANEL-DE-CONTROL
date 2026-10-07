'use client'

// ============================================================
// EEC — PANTALLA CENTRAL (spec §38)
// KPIs operacionales + agentes + runs en curso + flujo de eventos
// en vivo + trabajo bloqueado. SOLO estado real del snapshot.
// ============================================================

import { useMemo } from 'react'
import {
  Bot,
  Activity,
  Stamp,
  Users,
  ShieldAlert,
  Server,
  type LucideIcon,
} from 'lucide-react'

import { useEecStore } from '@/store/eec-store'
import {
  AGENT_STATE_STYLE,
  type EecEventItem,
  type EecRun,
  type EecRuntime,
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

// ---------- KPI ----------

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  icon: LucideIcon
  label: string
  value: number | string
  sub?: string
  tone?: 'neutral' | 'amber' | 'rose' | 'emerald'
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
    <Card className="gap-2 rounded-lg border-slate-800/80 bg-slate-900/60 p-4">
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
    </Card>
  )
}

// ---------- Paneles ----------

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
        {agents.map((a) => {
          const st = AGENT_STATE_STYLE[a.state]
          const rt: EecRuntime | undefined = a.runtimes[0]
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => selectAgent(a.id)}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                'hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50',
              )}
              aria-label={`Inspeccionar agente ${a.code}`}
            >
              <span
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full', st?.dot ?? 'bg-slate-600')}
                aria-hidden
              />
              <span className="w-14 shrink-0 font-mono text-xs text-slate-400">{a.code}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-200">
                  {a.name}
                  <span className="text-slate-500"> · {a.role}</span>
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {a.activity ?? (a.state === 'OFFLINE' ? 'sin conexión' : 'sin actividad reportada')}
                </span>
              </span>
              <Badge
                variant="outline"
                className={cn('shrink-0 border font-mono text-[10px]', st?.chip ?? 'border-slate-600/40 bg-slate-600/20 text-slate-400')}
              >
                {st?.label ?? a.state}
              </Badge>
              <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] text-slate-500 sm:flex">
                <span className={cn('h-1.5 w-1.5 rounded-full', runtimeDot(rt?.status))} aria-hidden />
                {rt ? rt.status : 'SIN RT'}
              </span>
            </button>
          )
        })}
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

function EventRow({ event }: { event: EecEventItem }) {
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
}

function EventsPanel() {
  const events = useEecStore((s) => s.events)
  const feed = useMemo(() => events.slice(0, 40), [events])

  return (
    <Card className="gap-3 rounded-lg border-slate-800/80 bg-slate-900/60">
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
          <Skeleton key={i} className="h-24 bg-slate-800" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-72 bg-slate-800" />
        ))}
      </div>
    </div>
  )
}

// ---------- Pantalla ----------

export default function CentralScreen() {
  const snapshot = useEecStore((s) => s.snapshot)

  const health = snapshot?.health
  const activeAgents = health
    ? (health.agentsByState.IDLE ?? 0) + (health.agentsByState.WORKING ?? 0)
    : 0

  if (!snapshot || !health) return <CentralSkeleton />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-100">Central de operaciones</h1>
        <span className="font-mono text-[10px] text-slate-600" suppressHydrationWarning>
          generado {new Date(snapshot.generatedAt).toLocaleTimeString('es-CO', { hour12: false })}
        </span>
      </div>

      {/* Fila de KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          icon={Bot}
          label="Agentes activos"
          value={activeAgents}
          sub={`de ${health.agentsTotal} totales`}
          tone="emerald"
        />
        <Kpi icon={Activity} label="Runs activos" value={health.runsActive} />
        <Kpi
          icon={Stamp}
          label="Aprobaciones pendientes"
          value={health.approvalsPending}
          tone={health.approvalsPending > 0 ? 'amber' : 'neutral'}
        />
        <Kpi icon={Users} label="Reuniones activas" value={health.meetingsActive} />
        <Kpi
          icon={ShieldAlert}
          label="Tareas bloqueadas"
          value={health.blockedTasks}
          tone={health.blockedTasks > 0 ? 'rose' : 'neutral'}
        />
        <Kpi icon={Server} label="Runtimes corriendo" value={health.runtimesRunning} />
      </div>

      {/* Paneles operacionales */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <AgentsPanel />
        <ActiveRunsPanel />
        <EventsPanel />
        <div className="lg:col-span-2 xl:col-span-3">
          <AttentionPanel />
        </div>
      </div>
    </div>
  )
}
