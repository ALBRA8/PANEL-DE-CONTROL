'use client'

// ============================================================
// EEC — AGENT OFFICE (spec §39)
// Escritorio individual de una oficina: estado real del agente,
// runtime honesto (o NOT CONNECTED si OFFLINE), tabs de métricas,
// herramientas, memoria y conversaciones. Control humano vía
// comandos (pipeline único). Nada se inventa: sin datos → sin sección.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import {
  Brain, CircleSlash, MessagesSquare, Pause, Play, Plug,
  Puzzle, Sunrise, Wrench,
} from 'lucide-react'
import { useEecStore } from '@/store/eec-store'
import { AGENT_STATE_STYLE, timeAgo } from '@/lib/eec-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// ---------- Tipos del detalle servido por /api/eec/agents?id= ----------
interface DetailRuntime {
  id: string
  provider: string
  status: string
  health: string
  restarts: number
  lastHeartbeatAt: string | null
  startedAt: string | null
}

interface DetailRun {
  id: string
  status: string
  progress: number
  currentNode: string | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  task?: { code: string; title: string } | null
}

interface DetailMemory {
  id: string
  scope: string
  kind: string
  content: string
  importance: number
  classification: string
  createdAt: string
}

interface DetailMessage {
  id: string
  senderType: string
  senderName: string | null
  content: string
  createdAt: string
}

interface DetailConversation {
  id: string
  title: string | null
  channel: string
  status: string
  createdAt: string
  messages: DetailMessage[]
}

interface DetailToolInvocation {
  id: string
  toolCode: string
  status: string
  latencyMs: number | null
  cost: number | null
  error: string | null
  sim: boolean
  createdAt: string
}

interface DetailPermission {
  id: string
  capability: string
  resource: string
  action: string
  effect: string
}

interface DetailAgent {
  id: string
  code: string
  name: string
  role: string
  description: string | null
  state: string
  activity: string | null
  healthStatus: string
  lastHeartbeatAt: string | null
  location?: { id: string; code: string; name: string } | null
  office?: { id: string; code: string; name: string } | null
  department?: { id: string; code: string; name: string } | null
  runtimes: DetailRuntime[]
  runs: DetailRun[]
  memories: DetailMemory[]
}

interface AgentDetailResponse {
  agent: DetailAgent
  permissions: DetailPermission[]
  conversations: DetailConversation[]
  toolInvocations: DetailToolInvocation[]
  metrics: { totalRuns: number; successfulRuns: number; failedRuns: number; memories: number }
}

// ---------- Paletas locales (mismos matices que el cliente EEC, sin azul/índigo) ----------
const STATE_BORDER: Record<string, string> = {
  OFFLINE: 'border-slate-600',
  IDLE: 'border-teal-400',
  WORKING: 'border-emerald-400',
  WAITING: 'border-amber-400',
  BLOCKED: 'border-rose-500',
  REVIEW: 'border-violet-400',
  IN_MEETING: 'border-fuchsia-400',
  ERROR: 'border-rose-600',
  PAUSED: 'border-amber-500',
  SUSPENDED: 'border-slate-600',
  DONE: 'border-emerald-300',
  RECOVERY: 'border-amber-300',
}

const RUN_CHIP: Record<string, string> = {
  PENDING: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  RUNNING: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  WAITING_APPROVAL: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SUCCEEDED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
  TIMED_OUT: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
}

const TOOL_CHIP: Record<string, string> = {
  REQUESTED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  CHECKING: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  CHECKS_FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  EXECUTING: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  SUCCEEDED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  TIMEOUT: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  DENIED: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SUPPRESSED_SIM: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
}

const SCOPE_CHIP: Record<string, string> = {
  SHORT_TERM_CONTEXT: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  WORKING_CONTEXT: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  LONG_TERM_MEMORY: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  ORGANIZATIONAL_MEMORY: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
}

const CLASSIFICATION_TEXT: Record<string, string> = {
  PUBLIC: 'text-teal-300',
  INTERNAL: 'text-slate-400',
  CONFIDENTIAL: 'text-amber-300',
  RESTRICTED: 'text-rose-300',
  SECRET: 'text-rose-400 font-semibold',
}

// Controles humanos por estado real (misma lógica que las tarjetas de agentes)
function controlsForState(state: string): Array<{ label: string; cmd: string; icon: typeof Play }> {
  switch (state) {
    case 'OFFLINE':
      return [{ label: 'Conectar', cmd: 'agent.start', icon: Plug }]
    case 'IDLE':
    case 'WORKING':
      return [
        { label: 'Pausar', cmd: 'agent.pause', icon: Pause },
        { label: 'Suspender', cmd: 'agent.suspend', icon: CircleSlash },
      ]
    case 'PAUSED':
      return [
        { label: 'Reanudar', cmd: 'agent.resume', icon: Play },
        { label: 'Suspender', cmd: 'agent.suspend', icon: CircleSlash },
      ]
    case 'SUSPENDED':
      return [{ label: 'Despertar', cmd: 'agent.wake', icon: Sunrise }]
    default:
      return [{ label: 'Suspender', cmd: 'agent.suspend', icon: CircleSlash }]
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function Chip({ label, className }: { label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('h-4 px-1 py-0 font-mono text-[9px]', className)}>
      {label}
    </Badge>
  )
}

// ============================================================
export default function AgentOffice({ agentId }: { agentId: string }) {
  const command = useEecStore((s) => s.command)

  const [data, setData] = useState<AgentDetailResponse | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [cmdError, setCmdError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/eec/agents?id=${encodeURIComponent(agentId)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`detalle ${res.status}`)
      const json = (await res.json()) as AgentDetailResponse
      setData(json)
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'error de red')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    setLoading(true)
    void load()
    const t = setInterval(() => { void load() }, 5000)
    return () => clearInterval(t)
  }, [load])

  const act = async (cmd: string) => {
    setActing(true)
    setCmdError(null)
    try {
      const res = await command(cmd, { agentId })
      if (!res.ok) setCmdError(res.error ?? 'comando rechazado por el pipeline')
      await load()
    } catch (err) {
      setCmdError(err instanceof Error ? err.message : 'error de comando')
    } finally {
      setActing(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60">
        <p className="animate-pulse font-mono text-xs text-slate-500">Abriendo oficina…</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60">
        <p className="text-xs text-rose-300">No se pudo cargar la oficina del agente ({fetchError}).</p>
        <p className="font-mono text-[10px] text-slate-500">Reintentando cada 5 s…</p>
      </div>
    )
  }

  const agent = data.agent
  const st = AGENT_STATE_STYLE[agent.state]
  const offline = agent.state === 'OFFLINE'
  const runtime = agent.runtimes[0] ?? null
  const controls = controlsForState(agent.state)

  const metrics = [
    { label: 'Runs totales', value: data.metrics.totalRuns, text: 'text-slate-100' },
    { label: 'Exitosos', value: data.metrics.successfulRuns, text: 'text-emerald-300' },
    { label: 'Fallidos', value: data.metrics.failedRuns, text: 'text-rose-300' },
    { label: 'Memorias', value: data.metrics.memories, text: 'text-teal-300' },
  ]

  return (
    <section aria-label={`Oficina de ${agent.name}`} className="flex flex-col gap-4">
      {/* Escritorio de la oficina */}
      <Card className="gap-3 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4 sm:p-6 sm:py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex items-start gap-4">
            <div className="relative shrink-0">
              <div
                className={cn(
                  'flex size-16 items-center justify-center rounded-full border-2 bg-slate-950 text-sm font-bold',
                  offline
                    ? 'border-dashed border-slate-600 text-slate-500 grayscale'
                    : cn('bg-slate-900 text-slate-100', STATE_BORDER[agent.state] ?? 'border-slate-600'),
                )}
              >
                {initialsOf(agent.name)}
              </div>
              {!offline && st && (
                <span className={cn('absolute bottom-0 right-0 size-3 rounded-full border-2 border-slate-950', st.dot)} />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-slate-100">{agent.name}</h2>
              <p className="truncate font-mono text-[11px] text-slate-500">
                {agent.code} · {agent.role}
                {agent.department ? ` · ${agent.department.name}` : ''}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Chip label={st?.label ?? agent.state} className={st?.chip} />
                <span className="font-mono text-[10px] text-slate-500">
                  {agent.location ? `en ${agent.location.name}` : 'sin ubicación'}
                </span>
              </div>
            </div>
          </div>

          {/* Control humano */}
          <div className="flex flex-col items-stretch gap-1.5 sm:ml-auto sm:items-end">
            <div className="flex flex-wrap gap-1.5 sm:justify-end">
              {controls.map(({ label, cmd, icon: Icon }) => (
                <Button
                  key={cmd}
                  size="sm"
                  variant="outline"
                  disabled={acting}
                  className="h-7 gap-1 border-slate-700 bg-slate-900 px-2.5 text-[11px] text-slate-200 hover:bg-slate-800 hover:text-slate-100"
                  onClick={() => void act(cmd)}
                >
                  <Icon className="size-3.5" /> {label}
                </Button>
              ))}
            </div>
            {offline && (
              <p className="font-mono text-[10px] text-slate-500 sm:text-right">
                NOT CONNECTED — acciones deshabilitadas hasta conectar
              </p>
            )}
            {cmdError && (
              <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 sm:text-right">
                {cmdError}
              </p>
            )}
          </div>
        </div>

        <Separator className="bg-slate-800" />

        <div className="grid gap-2 text-[11px] sm:grid-cols-2">
          <p className="text-slate-400">
            <span className="font-mono uppercase tracking-wider text-slate-500">Actividad actual</span>{' '}
            <span className="text-slate-200">{agent.activity ?? '—'}</span>
          </p>
          <p className="font-mono text-slate-400 sm:text-right">
            {offline ? (
              <span className="text-slate-500">NOT CONNECTED</span>
            ) : runtime ? (
              <>
                runtime: <span className="text-slate-200">{runtime.status}</span>
                {' · '}salud <span className="text-slate-200">{runtime.health}</span>
                {' · '}reinicios <span className="text-slate-200">{runtime.restarts}</span>
                {' · '}último latido <span className="text-slate-200">{timeAgo(runtime.lastHeartbeatAt)}</span>
              </>
            ) : (
              <span className="text-slate-500">sin runtime registrado</span>
            )}
          </p>
        </div>
      </Card>

      {/* Detalle por pestañas */}
      <Tabs defaultValue="estado">
        <TabsList className="bg-slate-900 border border-slate-800">
          <TabsTrigger value="estado" className="gap-1.5 text-xs"><Brain className="size-3.5" /> Estado</TabsTrigger>
          <TabsTrigger value="herramientas" className="gap-1.5 text-xs"><Wrench className="size-3.5" /> Herramientas</TabsTrigger>
          <TabsTrigger value="memoria" className="gap-1.5 text-xs"><Puzzle className="size-3.5" /> Memoria</TabsTrigger>
          <TabsTrigger value="conversaciones" className="gap-1.5 text-xs"><MessagesSquare className="size-3.5" /> Conversaciones</TabsTrigger>
        </TabsList>

        {/* ESTADO */}
        <TabsContent value="estado" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {metrics.map((m) => (
              <Card key={m.label} className="gap-0.5 rounded-lg border-slate-800 bg-slate-900/60 p-3 py-3">
                <span className={cn('font-mono text-lg font-semibold', m.text)}>{m.value}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">{m.label}</span>
              </Card>
            ))}
          </div>

          <Card className="gap-2 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <CardTitle className="text-sm">Últimos runs</CardTitle>
            {agent.runs.length === 0 ? (
              <p className="text-[11px] text-slate-500">Sin registros todavía.</p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {agent.runs.map((r) => (
                  <li key={r.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip label={r.status} className={RUN_CHIP[r.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">
                        {r.task ? `${r.task.code} · ${r.task.title}` : 'sin tarea asociada'}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">
                        {r.startedAt ? timeAgo(r.startedAt) : timeAgo(r.createdAt)}
                      </span>
                    </div>
                    {r.currentNode && (
                      <p className="mt-1 font-mono text-[10px] text-slate-500">nodo: {r.currentNode}</p>
                    )}
                    <Progress
                      value={Math.max(0, Math.min(100, r.progress))}
                      aria-label={`Progreso run ${r.id}`}
                      className="mt-1.5 h-1.5 bg-slate-800 [&_[data-slot=progress-indicator]]:bg-emerald-400"
                    />
                    {r.error && <p className="mt-1 truncate text-[10px] text-rose-300">{r.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.permissions.length > 0 && (
            <Card className="gap-2 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
              <CardTitle className="text-sm">Permisos otorgados</CardTitle>
              <div className="flex flex-wrap gap-1.5">
                {data.permissions.map((p) => (
                  <span
                    key={p.id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px]',
                      p.effect === 'DENY'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                        : 'border-teal-400/30 bg-teal-400/10 text-teal-300',
                    )}
                    title={`${p.capability} · ${p.resource} · ${p.action}`}
                  >
                    {p.capability}
                    <span className="text-slate-500">/{p.action}</span>
                  </span>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>

        {/* HERRAMIENTAS */}
        <TabsContent value="herramientas">
          <Card className="gap-2 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <CardTitle className="text-sm">Invocaciones de herramientas</CardTitle>
            {data.toolInvocations.length === 0 ? (
              <p className="text-[11px] text-slate-500">Sin registros todavía.</p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {data.toolInvocations.map((t) => (
                  <li key={t.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-slate-200">{t.toolCode}</span>
                      <Chip label={t.status} className={TOOL_CHIP[t.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'} />
                      {t.sim && <Chip label="SIM" className="border-violet-400/30 bg-violet-400/10 text-violet-300" />}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
                        {t.latencyMs !== null ? `${t.latencyMs} ms` : 'latencia —'}
                        {t.cost !== null ? ` · costo ${t.cost.toFixed(4)}` : ''}
                      </span>
                    </div>
                    {t.error && <p className="mt-1 truncate text-[10px] text-rose-300">{t.error}</p>}
                    <p className="mt-0.5 font-mono text-[9px] text-slate-600">{timeAgo(t.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>

        {/* MEMORIA */}
        <TabsContent value="memoria">
          <Card className="gap-2 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <CardTitle className="text-sm">Memoria reciente</CardTitle>
            {agent.memories.length === 0 ? (
              <p className="text-[11px] text-slate-500">Sin registros todavía.</p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {agent.memories.map((mem) => (
                  <li key={mem.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip label={mem.scope} className={SCOPE_CHIP[mem.scope] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'} />
                      <span className="font-mono text-[9px] text-slate-500">{mem.kind}</span>
                      <span className="font-mono text-[9px] text-slate-500">importancia {mem.importance}/10</span>
                      <span className={cn('ml-auto shrink-0 font-mono text-[9px]', CLASSIFICATION_TEXT[mem.classification] ?? 'text-slate-400')}>
                        {mem.classification}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300">{mem.content}</p>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-600">{timeAgo(mem.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>

        {/* CONVERSACIONES */}
        <TabsContent value="conversaciones">
          <Card className="gap-3 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <CardTitle className="text-sm">Conversaciones</CardTitle>
            {data.conversations.length === 0 ? (
              <p className="text-[11px] text-slate-500">Sin registros todavía.</p>
            ) : (
              <div className="max-h-96 space-y-4 overflow-y-auto pr-1">
                {data.conversations.map((conv) => (
                  <div key={conv.id} className="flex flex-col gap-1.5">
                    <p className="truncate text-[11px] font-medium text-slate-300">
                      {conv.title ?? 'Conversación'}
                      <span className="ml-1.5 font-mono text-[9px] text-slate-500">{conv.channel} · {conv.status}</span>
                    </p>
                    {conv.messages.length === 0 ? (
                      <p className="text-[10px] text-slate-600">Sin mensajes.</p>
                    ) : (
                      conv.messages.map((msg) => {
                        const isAgent = msg.senderType === 'AGENT'
                        const isSystem = msg.senderType === 'SYSTEM'
                        return (
                          <div
                            key={msg.id}
                            className={cn(
                              'max-w-[85%] rounded-lg border px-2.5 py-1.5',
                              isSystem
                                ? 'mx-auto border-slate-800 bg-slate-950/60 text-center'
                                : isAgent
                                  ? 'self-end border-emerald-400/20 bg-emerald-400/[0.07]'
                                  : 'self-start border-slate-700 bg-slate-800/60',
                            )}
                          >
                            <p className="font-mono text-[9px] text-slate-500">
                              {msg.senderName ?? msg.senderType} · {timeAgo(msg.createdAt)}
                            </p>
                            <p className={cn(
                              'whitespace-pre-wrap break-words text-[11px] leading-relaxed',
                              isSystem ? 'italic text-slate-500' : 'text-slate-200',
                            )}>
                              {msg.content}
                            </p>
                          </div>
                        )
                      })
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  )
}
