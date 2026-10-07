'use client'

// ============================================================
// EEC — VISTA AGENTES / INSPECTOR (spec §7, §39)
// Grid de tarjetas de agente + Sheet lateral con detalle real:
// runtimes, permisos, sesiones, runs, memoria, conversaciones, tools.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { useEecStore } from '@/store/eec-store'
import { AGENT_STATE_STYLE, timeAgo, type EecAgent } from '@/lib/eec-client'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ---------- Tipos del detalle (/api/eec/agents?id=) ----------

interface DetailRuntime {
  id: string
  provider: string
  status: string
  health: string
  restarts: number
  lastHeartbeatAt: string | null
}

interface DetailAgent {
  id: string
  code: string
  name: string
  role: string
  description: string | null
  version: string
  provider: string
  state: string
  activity: string | null
  healthStatus: string
  lastHeartbeatAt: string | null
  capabilitiesJson: string
  department?: { code: string; name: string } | null
  office?: { code: string; name: string } | null
  location?: { code: string; name: string } | null
  runtimes: DetailRuntime[]
  sessions: Array<{
    id: string
    status: string
    purpose: string | null
    startedAt: string | null
    endedAt: string | null
  }>
  runs: Array<{
    id: string
    status: string
    progress: number
    error: string | null
    startedAt: string | null
    completedAt: string | null
    task?: { code: string; title: string } | null
  }>
  memories: Array<{
    id: string
    scope: string
    kind: string
    content: string
    classification: string
    createdAt: string
  }>
}

interface DetailPermission {
  id: string
  capability: string
  resource: string
  action: string
  effect: string
}

interface DetailConversation {
  id: string
  title: string | null
  channel: string
  status: string
  messages: Array<{
    id: string
    senderType: string
    senderName: string | null
    content: string
    createdAt: string
  }>
}

interface DetailToolInvocation {
  id: string
  toolCode: string
  status: string
  latencyMs: number | null
  sim: boolean
  createdAt: string
}

interface AgentDetail {
  agent: DetailAgent
  permissions: DetailPermission[]
  conversations: DetailConversation[]
  toolInvocations: DetailToolInvocation[]
  metrics: { totalRuns: number; successfulRuns: number; failedRuns: number; memories: number }
}

// ---------- Paletas locales (sin azul/índigo) ----------

const AVATAR_RING: Record<string, string> = {
  OFFLINE: 'border-slate-500/60 bg-slate-500/10 text-slate-300',
  IDLE: 'border-teal-400/60 bg-teal-400/10 text-teal-200',
  WORKING: 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200',
  WAITING: 'border-amber-400/60 bg-amber-400/10 text-amber-200',
  BLOCKED: 'border-rose-500/60 bg-rose-500/10 text-rose-200',
  REVIEW: 'border-violet-400/60 bg-violet-400/10 text-violet-200',
  IN_MEETING: 'border-fuchsia-400/60 bg-fuchsia-400/10 text-fuchsia-200',
  ERROR: 'border-rose-600/70 bg-rose-600/15 text-rose-200',
  PAUSED: 'border-amber-500/60 bg-amber-500/10 text-amber-200',
  SUSPENDED: 'border-slate-600/60 bg-slate-600/10 text-slate-400',
  DONE: 'border-emerald-300/60 bg-emerald-300/10 text-emerald-100',
  RECOVERY: 'border-amber-300/60 bg-amber-300/10 text-amber-100',
}

const CHIP: Record<string, string> = {
  // runs / sesiones / tools
  RUNNING: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  READY: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  SUCCEEDED: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  ACTIVE: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  COMPLETED: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  WAITING_APPROVAL: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  PAUSED: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  RECOVERING: 'border-amber-300/40 bg-amber-300/10 text-amber-200',
  EXECUTING: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  CHECKING: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  REQUESTED: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
  CREATED: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
  PENDING: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
  RESUMED: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  INITIALIZING: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  STARTING: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  IDLE: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  FAILED: 'border-rose-600/40 bg-rose-600/15 text-rose-300',
  ERROR: 'border-rose-600/40 bg-rose-600/15 text-rose-300',
  CRASHED: 'border-rose-600/40 bg-rose-600/15 text-rose-300',
  UNHEALTHY: 'border-rose-600/40 bg-rose-600/15 text-rose-300',
  TIMEOUT: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  TIMED_OUT: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  INTERRUPTED: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  DENIED: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  CANCELLED: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
  STOPPED: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
  STOPPING: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
  CLOSED: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
  SUPPRESSED_SIM: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
}

function chipClass(status: string): string {
  return CHIP[status] ?? 'border-slate-500/40 bg-slate-500/15 text-slate-300'
}

const SCOPE_CHIP: Record<string, string> = {
  SHORT_TERM_CONTEXT: 'border-slate-500/40 bg-slate-500/15 text-slate-300',
  WORKING_CONTEXT: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  LONG_TERM_MEMORY: 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  ORGANIZATIONAL_MEMORY: 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300',
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

function parseJsonStrings(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const second = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + second).toUpperCase()
}

// ---------- Acciones de agente según estado real ----------

function AgentActions({ agent }: { agent: EecAgent }) {
  const command = useEecStore((s) => s.command)
  const [busy, setBusy] = useState<string | null>(null)

  const exec = useCallback(
    async (type: string, label: string) => {
      setBusy(type)
      try {
        const res = await command(type, { agentId: agent.id })
        if (!res.ok) {
          toast.error(res.error ?? `No se pudo ejecutar: ${label}`)
          return
        }
        toast.success(`${label}: comando aceptado por el pipeline`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Fallo de red al enviar el comando')
      } finally {
        setBusy(null)
      }
    },
    [command, agent.id],
  )

  const btn =
    'h-11 px-3 text-xs border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-slate-100'

  switch (agent.state) {
    case 'OFFLINE':
      return (
        <Button
          variant="outline"
          className={cn(btn, 'border-emerald-400/40 text-emerald-300 hover:bg-emerald-950/40')}
          disabled={busy !== null}
          onClick={() => void exec('agent.start', 'Conectar agente')}
        >
          {busy === 'agent.start' ? 'Conectando…' : 'Conectar'}
        </Button>
      )
    case 'IDLE':
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className={btn}
            disabled={busy !== null}
            onClick={() => void exec('agent.pause', 'Pausar agente')}
          >
            {busy === 'agent.pause' ? '…' : 'Pausar'}
          </Button>
          <Button
            variant="outline"
            className={btn}
            disabled={busy !== null}
            onClick={() => void exec('agent.suspend', 'Suspender agente')}
          >
            {busy === 'agent.suspend' ? '…' : 'Suspender'}
          </Button>
        </div>
      )
    case 'PAUSED':
      return (
        <Button
          variant="outline"
          className={cn(btn, 'border-teal-400/40 text-teal-300 hover:bg-teal-950/40')}
          disabled={busy !== null}
          onClick={() => void exec('agent.resume', 'Reanudar agente')}
        >
          {busy === 'agent.resume' ? '…' : 'Reanudar'}
        </Button>
      )
    case 'SUSPENDED':
      return (
        <Button
          variant="outline"
          className={cn(btn, 'border-amber-400/40 text-amber-300 hover:bg-amber-950/40')}
          disabled={busy !== null}
          onClick={() => void exec('agent.wake', 'Despertar agente')}
        >
          {busy === 'agent.wake' ? '…' : 'Despertar'}
        </Button>
      )
    case 'WORKING':
      return (
        <Button
          variant="outline"
          className={btn}
          disabled={busy !== null}
          onClick={() => void exec('agent.pause', 'Pausar agente')}
        >
          {busy === 'agent.pause' ? '…' : 'Pausar'}
        </Button>
      )
    default:
      // WAITING / BLOCKED / IN_MEETING / ERROR / RECOVERY: sin comandos definidos — honesto
      return null
  }
}

// ---------- Tarjeta de agente ----------

function AgentCard({ agent }: { agent: EecAgent }) {
  const selectAgent = useEecStore((s) => s.selectAgent)
  const st = AGENT_STATE_STYLE[agent.state]
  const rt = agent.runtimes[0]

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <button
        type="button"
        onClick={() => selectAgent(agent.id)}
        className={cn(
          'flex min-h-11 w-full items-start gap-3 rounded-md text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50',
        )}
        aria-label={`Inspeccionar agente ${agent.code}`}
      >
        <span
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold',
            AVATAR_RING[agent.state] ?? 'border-slate-600/60 bg-slate-700/20 text-slate-300',
          )}
          aria-hidden
        >
          {initialsOf(agent.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-slate-500">{agent.code}</span>
            <Badge
              variant="outline"
              className={cn('border font-mono text-[9px]', st?.chip ?? 'border-slate-600/40 bg-slate-600/20 text-slate-400')}
            >
              {st?.label ?? agent.state}
            </Badge>
            {agent.state === 'OFFLINE' && (
              <Badge
                variant="outline"
                className="border-rose-600/40 bg-rose-600/15 font-mono text-[9px] text-rose-300"
              >
                NOT CONNECTED
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium text-slate-100">
            {agent.name}
          </span>
          <span className="block truncate text-xs text-slate-500">
            {agent.role}
            {agent.department?.name ? ` · ${agent.department.name}` : ''}
            {agent.office?.name ? ` · ${agent.office.name}` : ''}
          </span>
          <span className="mt-1 block truncate text-xs text-slate-400">
            {agent.activity ?? (agent.state === 'OFFLINE' ? 'sin conexión' : 'sin actividad reportada')}
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span
            className={cn('h-1.5 w-1.5 rounded-full', runtimeDot(rt?.status))}
            aria-hidden
          />
          <span className="font-mono">
            {rt ? `${rt.status} · ${rt.health}` : 'sin runtime'}
          </span>
        </span>
        <span className="font-mono">hb {timeAgo(agent.lastHeartbeatAt)}</span>
        {agent.currentTaskId && (
          <Badge
            variant="outline"
            className="border-teal-400/30 bg-teal-400/10 text-[9px] text-teal-300"
          >
            tarea en curso
          </Badge>
        )}
      </div>

      <div className="mt-auto">
        <AgentActions agent={agent} />
      </div>
    </div>
  )
}

// ---------- Secciones del Sheet ----------

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
      {children}
    </h3>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-600">{children}</p>
}

function AgentDetailContent({ detail }: { detail: AgentDetail }) {
  const a = detail.agent
  const capabilities = parseJsonStrings(a.capabilitiesJson)
  const runs = a.runs.slice(0, 10)
  const memories = a.memories.slice(0, 15)
  const conversations = detail.conversations.slice(0, 3)

  return (
    <div className="space-y-5">
      {/* Identidad */}
      <section className="space-y-2">
        <SectionTitle>Identidad</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-slate-500">Código</dt>
          <dd className="font-mono text-slate-200">{a.code}</dd>
          <dt className="text-slate-500">Rol</dt>
          <dd className="text-slate-200">{a.role}</dd>
          <dt className="text-slate-500">Proveedor</dt>
          <dd className="font-mono text-slate-200">{a.provider}</dd>
          <dt className="text-slate-500">Versión</dt>
          <dd className="font-mono text-slate-200">{a.version}</dd>
          <dt className="text-slate-500">Departamento</dt>
          <dd className="text-slate-200">{a.department?.name ?? '—'}</dd>
          <dt className="text-slate-500">Oficina</dt>
          <dd className="text-slate-200">{a.office?.name ?? '—'}</dd>
          <dt className="text-slate-500">Ubicación</dt>
          <dd className="text-slate-200">{a.location?.name ?? '—'}</dd>
          <dt className="text-slate-500">Salud</dt>
          <dd className="font-mono text-slate-200">{a.healthStatus}</dd>
          <dt className="text-slate-500">Último heartbeat</dt>
          <dd className="font-mono text-slate-200">{timeAgo(a.lastHeartbeatAt)}</dd>
          <dt className="text-slate-500">Actividad</dt>
          <dd className="text-slate-200">{a.activity ?? 'sin actividad reportada'}</dd>
        </dl>
        {a.description && (
          <p className="rounded-md border border-slate-800/70 bg-slate-950/50 p-3 text-xs leading-relaxed text-slate-400">
            {a.description}
          </p>
        )}
        {capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {capabilities.map((c) => (
              <Badge
                key={c}
                variant="outline"
                className="border-slate-700 bg-slate-900 font-mono text-[10px] text-slate-300"
              >
                {c}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Runtimes */}
      <section className="space-y-2">
        <SectionTitle>Runtimes</SectionTitle>
        {a.runtimes.length === 0 ? (
          <EmptyNote>Sin runtimes registrados para este agente.</EmptyNote>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-800/70">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="border-slate-800/70 hover:bg-transparent">
                  <TableHead className="h-8 text-[10px] text-slate-500">Provider</TableHead>
                  <TableHead className="h-8 text-[10px] text-slate-500">Estado</TableHead>
                  <TableHead className="h-8 text-[10px] text-slate-500">Salud</TableHead>
                  <TableHead className="h-8 text-[10px] text-slate-500">Reinicios</TableHead>
                  <TableHead className="h-8 text-[10px] text-slate-500">Heartbeat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.runtimes.map((rt) => (
                  <TableRow key={rt.id} className="border-slate-800/50">
                    <TableCell className="py-1.5 font-mono text-slate-300">{rt.provider}</TableCell>
                    <TableCell className="py-1.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn('h-1.5 w-1.5 rounded-full', runtimeDot(rt.status))}
                          aria-hidden
                        />
                        <span className="font-mono text-slate-300">{rt.status}</span>
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5 font-mono text-slate-300">{rt.health}</TableCell>
                    <TableCell className="py-1.5 font-mono text-slate-300">{rt.restarts}</TableCell>
                    <TableCell className="py-1.5 font-mono text-slate-400">
                      {timeAgo(rt.lastHeartbeatAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Permisos */}
      <section className="space-y-2">
        <SectionTitle>Permisos otorgados</SectionTitle>
        {detail.permissions.length === 0 ? (
          <EmptyNote>Sin permisos registrados (un agente nunca se otorga permisos a sí mismo).</EmptyNote>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.permissions.map((p) => (
              <Badge
                key={p.id}
                variant="outline"
                className={cn(
                  'gap-1 border font-mono text-[10px]',
                  p.effect === 'DENY'
                    ? 'border-rose-600/40 bg-rose-600/15 text-rose-300'
                    : 'border-teal-400/30 bg-teal-400/10 text-teal-300',
                )}
              >
                {p.capability}
                <span className="text-slate-500">· {p.action}</span>
              </Badge>
            ))}
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Sesiones recientes */}
      <section className="space-y-2">
        <SectionTitle>Sesiones recientes</SectionTitle>
        {a.sessions.length === 0 ? (
          <EmptyNote>Sin sesiones registradas.</EmptyNote>
        ) : (
          <ul className="space-y-1.5">
            {a.sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800/70 bg-slate-950/50 px-3 py-2 text-xs"
              >
                <Badge
                  variant="outline"
                  className={cn('border font-mono text-[9px]', chipClass(s.status))}
                >
                  {s.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-slate-400">
                  {s.purpose ?? 'sin propósito declarado'}
                </span>
                <span className="font-mono text-[10px] text-slate-600">
                  {timeAgo(s.startedAt)}
                  {s.endedAt ? ` → ${timeAgo(s.endedAt)}` : ' → activa'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Últimos runs */}
      <section className="space-y-2">
        <SectionTitle>Últimos 10 runs</SectionTitle>
        {runs.length === 0 ? (
          <EmptyNote>Sin runs registrados para este agente.</EmptyNote>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="rounded-md border border-slate-800/70 bg-slate-950/50 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-teal-300">{r.task?.code ?? '—'}</span>
                  <Badge variant="outline" className={cn('ml-auto border font-mono text-[9px]', chipClass(r.status))}>
                    {r.status}
                  </Badge>
                </div>
                <Progress
                  value={r.progress}
                  className="mt-1.5 h-1 bg-slate-800 [&>div]:bg-emerald-400"
                  aria-label={`Progreso ${r.progress}%`}
                />
                {r.error && (
                  <p className="mt-1 truncate text-[11px] text-rose-400" title={r.error}>
                    {r.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Memoria */}
      <section className="space-y-2">
        <SectionTitle>Memoria (últimos 15 registros)</SectionTitle>
        {memories.length === 0 ? (
          <EmptyNote>Sin registros de memoria.</EmptyNote>
        ) : (
          <ul className="space-y-1.5">
            {memories.map((m) => (
              <li key={m.id} className="rounded-md border border-slate-800/70 bg-slate-950/50 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className={cn('border font-mono text-[9px]', SCOPE_CHIP[m.scope] ?? chipClass(m.scope))}
                  >
                    {m.scope}
                  </Badge>
                  <span className="font-mono text-[10px] text-slate-600">{m.kind}</span>
                  {(m.classification === 'RESTRICTED' || m.classification === 'CONFIDENTIAL') && (
                    <Badge
                      variant="outline"
                      className="border-orange-500/40 bg-orange-500/15 font-mono text-[9px] text-orange-300"
                    >
                      {m.classification}
                    </Badge>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-slate-600">
                    {timeAgo(m.createdAt)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-400" title={m.content}>
                  {m.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Conversaciones */}
      <section className="space-y-2">
        <SectionTitle>Conversaciones</SectionTitle>
        {conversations.length === 0 ? (
          <EmptyNote>Sin conversaciones registradas.</EmptyNote>
        ) : (
          <div className="space-y-3">
            {conversations.map((c) => (
              <div key={c.id} className="rounded-md border border-slate-800/70 bg-slate-950/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-medium text-slate-300">
                    {c.title ?? 'Conversación'}
                  </span>
                  <Badge
                    variant="outline"
                    className="border-slate-700 bg-slate-900 font-mono text-[9px] text-slate-400"
                  >
                    {c.channel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn('ml-auto border font-mono text-[9px]', chipClass(c.status))}
                  >
                    {c.status}
                  </Badge>
                </div>
                <div className="mt-2 space-y-1.5">
                  {c.messages.length === 0 && (
                    <p className="text-[11px] text-slate-600">Sin mensajes.</p>
                  )}
                  {c.messages.map((msg) => {
                    if (msg.senderType === 'SYSTEM') {
                      return (
                        <p
                          key={msg.id}
                          className="rounded bg-slate-900/70 px-2 py-1 text-center text-[10px] text-slate-500"
                        >
                          {msg.content}
                        </p>
                      )
                    }
                    const isAgent = msg.senderType === 'AGENT'
                    return (
                      <div
                        key={msg.id}
                        className={cn('flex', isAgent ? 'justify-start' : 'justify-end')}
                      >
                        <div
                          className={cn(
                            'max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs',
                            isAgent
                              ? 'bg-slate-800 text-slate-200'
                              : 'bg-teal-900/40 text-teal-100',
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                          <p className="mt-0.5 font-mono text-[9px] text-slate-500">
                            {msg.senderName ?? msg.senderType} · {timeAgo(msg.createdAt)}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* Tool invocations */}
      <section className="space-y-2">
        <SectionTitle>Invocaciones de herramientas</SectionTitle>
        {detail.toolInvocations.length === 0 ? (
          <EmptyNote>Sin invocaciones de herramientas registradas.</EmptyNote>
        ) : (
          <ul className="space-y-1.5">
            {detail.toolInvocations.slice(0, 10).map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800/70 bg-slate-950/50 px-3 py-2 text-xs"
              >
                <span className="font-mono text-teal-300">{t.toolCode}</span>
                <Badge variant="outline" className={cn('border font-mono text-[9px]', chipClass(t.status))}>
                  {t.status}
                </Badge>
                {t.sim && (
                  <Badge
                    variant="outline"
                    className="border-slate-600/40 bg-slate-600/20 font-mono text-[9px] text-slate-400"
                  >
                    SIM
                  </Badge>
                )}
                <span className="ml-auto font-mono text-[10px] text-slate-500">
                  {t.latencyMs !== null ? `${t.latencyMs} ms` : 'sin latencia'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ---------- Panel de detalle (montado con key=agentId: estado fresco por agente) ----------

function AgentDetailPanel({ agentId }: { agentId: string }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/eec/agents?id=${encodeURIComponent(agentId)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`El servidor respondió ${res.status}`)
        return (await res.json()) as unknown
      })
      .then((data) => {
        if (!alive) return
        setDetail(data as AgentDetail)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : 'error desconocido')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [agentId])

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-40 bg-slate-800" />
        <Skeleton className="h-24 w-full bg-slate-800" />
        <Skeleton className="h-40 w-full bg-slate-800" />
        <p className="font-mono text-xs text-slate-500">consultando /api/eec/agents…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md border border-rose-500/30 bg-rose-950/30 p-4">
        <p className="text-sm font-medium text-rose-300">No se pudo cargar el detalle del agente</p>
        <p className="mt-1 font-mono text-xs text-rose-400/90">{error}</p>
        <p className="mt-2 text-xs text-slate-400">
          Reintenta cerrando y abriendo el inspector. El estado del grid sigue siendo confiable:
          proviene del snapshot.
        </p>
      </div>
    )
  }

  if (detail) return <AgentDetailContent detail={detail} />
  return null
}

// ---------- Vista principal ----------

export default function AgentInspector() {
  const snapshot = useEecStore((s) => s.snapshot)
  const selectedAgentId = useEecStore((s) => s.selectedAgentId)
  const selectAgent = useEecStore((s) => s.selectAgent)

  const agents = snapshot?.agents ?? []
  const selectedFromSnapshot = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  if (!snapshot) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44 bg-slate-800" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Agentes</h1>
        <p className="text-xs text-slate-500">
          {agents.length} agentes registrados · estados reales del control plane · clic para
          inspeccionar.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>

      {agents.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
          Sin agentes registrados en EEC STATE.
        </div>
      )}

      {/* Inspector lateral */}
      <Sheet open={selectedAgentId !== null} onOpenChange={(o) => { if (!o) selectAgent(null) }}>
        <SheetContent
          side="right"
          className="eec-scroll w-full gap-0 overflow-y-auto border-slate-800 bg-slate-950 p-0 text-slate-100 sm:max-w-xl"
        >
          <SheetHeader className="gap-1 border-b border-slate-800/80 px-5 py-4 pr-14 text-left">
            <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="font-mono tracking-widest text-emerald-400">
                {selectedFromSnapshot?.code ?? selectedAgentId}
              </span>
              <span>{selectedFromSnapshot?.name ?? 'Inspector'}</span>
              {selectedFromSnapshot && (
                <Badge
                  variant="outline"
                  className={cn(
                    'border font-mono text-[9px]',
                    AGENT_STATE_STYLE[selectedFromSnapshot.state]?.chip ??
                      'border-slate-600/40 bg-slate-600/20 text-slate-400',
                  )}
                >
                  {AGENT_STATE_STYLE[selectedFromSnapshot.state]?.label ?? selectedFromSnapshot.state}
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription className="text-xs text-slate-500">
              {selectedFromSnapshot
                ? `${selectedFromSnapshot.role} · ${selectedFromSnapshot.department?.name ?? 'sin departamento'}`
                : 'Detalle operacional del agente'}
            </SheetDescription>
            {selectedFromSnapshot && (
              <div className="pt-1">
                <AgentActions agent={selectedFromSnapshot} />
              </div>
            )}
          </SheetHeader>

          <div className="px-5 py-4">
            {selectedAgentId && <AgentDetailPanel key={selectedAgentId} agentId={selectedAgentId} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
