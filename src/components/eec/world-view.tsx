'use client'

// ============================================================
// EEC — WORLD VIEW (spec §36, §40)
// HQ visual 2D: salas posicionadas en grilla 12x7, agentes como
// avatares en su ubicación REAL (snapshot). El movimiento de un
// avatar SOLO se anima cuando existe un evento real
// `agent.location.changed` (from→to) que ya mutó el snapshot:
// framer-motion (layoutId por agentId) interpola el desplazamiento.
// La capa visual NUNCA inventa actividad operacional.
// ============================================================
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Archive, Briefcase, Building2, Coffee, DoorOpen, Globe, Monitor,
  MoveRight, PanelRightClose, PanelRightOpen, Play, Presentation,
  Radar, Square, type LucideIcon,
} from 'lucide-react'
import { useEecStore } from '@/store/eec-store'
import {
  AGENT_STATE_STYLE, timeAgo,
  type EecAgent, type EecLocation,
} from '@/lib/eec-client'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Anillo/borde por estado — mismos matices que AGENT_STATE_STYLE (sin azul/índigo)
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

const MEETING_CHIP: Record<string, string> = {
  SCHEDULED: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  INVITED: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  IN_PROGRESS: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
}

function iconForType(type: string): { Icon: LucideIcon; className: string } {
  switch (type) {
    case 'RECEPTION': return { Icon: Building2, className: 'text-slate-400' }
    case 'CONTROL_CENTER': return { Icon: Monitor, className: 'text-emerald-300' }
    case 'BOARDROOM': return { Icon: Presentation, className: 'text-violet-300' }
    case 'ARCHIVE': return { Icon: Archive, className: 'text-slate-400' }
    case 'LOUNGE': return { Icon: Coffee, className: 'text-amber-300' }
    case 'WORLD_GATE': return { Icon: Globe, className: 'text-teal-300' }
    case 'DEPARTMENT': return { Icon: Briefcase, className: 'text-slate-300' }
    case 'OFFICE': return { Icon: DoorOpen, className: 'text-slate-400' }
    default: return { Icon: Briefcase, className: 'text-slate-400' }
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ---------- Avatar de agente (derivado 1:1 del snapshot) ----------
function AgentAvatar({ agent, onSelect }: { agent: EecAgent; onSelect: (id: string) => void }) {
  const st = AGENT_STATE_STYLE[agent.state]
  const offline = agent.state === 'OFFLINE'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          aria-label={`${agent.name} — ${st?.label ?? agent.state}`}
          layoutId={`agent-${agent.id}`}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          onClick={() => onSelect(agent.id)}
          className={cn(
            'relative size-7 rounded-full border-2 flex items-center justify-center font-bold text-[9px] cursor-pointer select-none',
            offline
              ? 'bg-slate-800/80 text-slate-500 border-dashed border-slate-600 grayscale'
              : cn('bg-slate-900 text-slate-200', STATE_BORDER[agent.state] ?? 'border-slate-600'),
          )}
        >
          {initialsOf(agent.name)}
          {!offline && st && (
            <span className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-slate-950', st.dot)} />
          )}
        </motion.button>
      </TooltipTrigger>
      <TooltipContent className="bg-slate-900 border border-slate-700 text-slate-100">
        <div className="text-xs font-semibold">{agent.name}</div>
        <div className="font-mono text-[10px] text-slate-400">{agent.code} · {st?.label ?? agent.state}</div>
        <div className="text-[11px] text-slate-300">Actividad: {agent.activity ?? '—'}</div>
      </TooltipContent>
    </Tooltip>
  )
}

// ---------- Sala del HQ ----------
function Room({
  loc, agents, count, isLatestTarget, onSelect,
}: {
  loc: EecLocation
  agents: EecAgent[]
  count: number
  isLatestTarget: boolean
  onSelect: (id: string) => void
}) {
  const { Icon, className: iconClass } = iconForType(loc.type)
  const exceeded = count > loc.capacity
  return (
    <div style={{ gridColumn: loc.x + 1, gridRow: loc.y + 1 }} className="min-h-0 min-w-0">
      <Card
        title={loc.name}
        className={cn(
          'h-full gap-1 rounded-lg border-slate-800 bg-slate-900/70 p-2 py-2',
          loc.type === 'CONTROL_CENTER' && 'border-emerald-400/50 bg-emerald-400/[0.04]',
          isLatestTarget && 'ring-1 ring-teal-400/60',
        )}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="flex min-w-0 items-center gap-1">
            <Icon className={cn('size-3.5 shrink-0', iconClass)} />
            <span className="truncate text-[11px] font-medium leading-tight text-slate-200">{loc.name}</span>
          </span>
          <Badge
            variant="outline"
            aria-label={`Ocupación ${count} de ${loc.capacity}`}
            className={cn(
              'h-4 shrink-0 px-1 py-0 font-mono text-[9px]',
              exceeded
                ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                : count > 0
                  ? 'border-teal-400/30 bg-teal-400/10 text-teal-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-500',
            )}
          >
            {count}/{loc.capacity}
          </Badge>
        </div>
        <span className="truncate font-mono text-[9px] leading-tight text-slate-500">{loc.code}</span>
        <div className="mt-auto flex flex-wrap content-start gap-1">
          {agents.map((a) => <AgentAvatar key={a.id} agent={a} onSelect={onSelect} />)}
        </div>
      </Card>
    </div>
  )
}

// ============================================================
export default function WorldView() {
  const snapshot = useEecStore((s) => s.snapshot)
  const events = useEecStore((s) => s.events)
  const connected = useEecStore((s) => s.connected)
  const selectAgent = useEecStore((s) => s.selectAgent)
  const command = useEecStore((s) => s.command)

  const [panelOpen, setPanelOpen] = useState(true)
  const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null)
  const [cmdError, setCmdError] = useState<string | null>(null)
  // confirmación operacional previa a meeting.start / meeting.end
  const [pendingMeeting, setPendingMeeting] = useState<{
    id: string; code: string; cmd: 'meeting.start' | 'meeting.end'
  } | null>(null)

  // Movimientos REALES: únicamente eventos agent.location.changed recibidos por el bus.
  const moves = useMemo(
    () => events.filter((e) => e.event_type === 'agent.location.changed').slice(0, 8),
    [events],
  )
  const latest = moves[0] ?? null

  const locNameByCode = useMemo(() => {
    const m = new Map<string, string>()
    for (const loc of snapshot?.locations ?? []) m.set(loc.code, loc.name)
    return m
  }, [snapshot])

  const { byLocation, unassigned } = useMemo(() => {
    const byLocation = new Map<string, EecAgent[]>()
    const unassigned: EecAgent[] = []
    for (const a of snapshot?.agents ?? []) {
      const key = a.location?.id
      if (key) {
        const arr = byLocation.get(key)
        if (arr) arr.push(a)
        else byLocation.set(key, [a])
      } else {
        unassigned.push(a)
      }
    }
    return { byLocation, unassigned }
  }, [snapshot])

  const activeMeetings = useMemo(
    () => (snapshot?.meetings ?? []).filter((m) => m.status === 'SCHEDULED' || m.status === 'INVITED' || m.status === 'IN_PROGRESS'),
    [snapshot],
  )

  const runMeetingCommand = async (meetingId: string, cmd: 'meeting.start' | 'meeting.end') => {
    setBusyMeetingId(meetingId)
    setCmdError(null)
    try {
      const payload: Record<string, unknown> = { meetingId }
      if (cmd === 'meeting.end') {
        payload.decisions = []
        payload.actionItems = []
      }
      const res = await command(cmd, payload)
      if (!res.ok) setCmdError(res.error ?? 'comando rechazado por el pipeline')
    } catch (err) {
      setCmdError(err instanceof Error ? err.message : 'error de comando')
    } finally {
      setBusyMeetingId(null)
    }
  }

  if (!snapshot) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60">
        <p className="animate-pulse font-mono text-xs text-slate-500">Cargando estado del mundo…</p>
      </div>
    )
  }

  const latestToCode = latest ? str(latest.payload.to) : ''

  return (
    <section aria-label="Vista del mundo HQ" className="flex flex-col gap-4">
      {/* Encabezado */}
      <div className="flex flex-wrap items-center gap-2">
        <Radar className="size-4 text-emerald-300" />
        <h2 className="text-sm font-semibold text-slate-100">HQ — Vista del mundo</h2>
        <span className="font-mono text-[10px] text-slate-500">
          snapshot {new Date(snapshot.generatedAt).toLocaleTimeString('es-CO')}
        </span>
        <span
          className="ml-1 flex items-center gap-1"
          title={connected ? 'Stream realtime conectado' : 'Stream realtime desconectado (respaldo por polling)'}
        >
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-teal-400' : 'bg-slate-600')} />
          <span className="font-mono text-[10px] text-slate-500">{connected ? 'RT' : 'RT OFF'}</span>
        </span>
        {snapshot.simulationMode && (
          <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 text-[10px] text-amber-300">
            SIMULACIÓN
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Mapa HQ 2D */}
        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/80 p-3">
            <div
              className="grid min-w-[900px] auto-rows-[96px] gap-2"
              style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridTemplateRows: 'repeat(7, minmax(0, 96px))' }}
            >
              {snapshot.locations.map((loc) => (
                <Room
                  key={loc.id}
                  loc={loc}
                  agents={byLocation.get(loc.id) ?? []}
                  count={(byLocation.get(loc.id) ?? []).length}
                  isLatestTarget={latestToCode === loc.code}
                  onSelect={selectAgent}
                />
              ))}

              {/* Honestidad: agentes sin ubicación no se ocultan ni se inventa su posición */}
              {unassigned.length > 0 && (
                <div style={{ gridColumn: '1 / -1', gridRow: 8 }}>
                  <Card className="h-full gap-1 rounded-lg border-dashed border-slate-700 bg-slate-900/40 p-2 py-2">
                    <div className="flex items-center gap-1">
                      <MoveRight className="size-3 text-slate-500" />
                      <span className="text-[11px] text-slate-400">Sin ubicación asignada ({unassigned.length})</span>
                    </div>
                    <div className="mt-auto flex flex-wrap gap-1">
                      {unassigned.map((a) => <AgentAvatar key={a.id} agent={a} onSelect={selectAgent} />)}
                    </div>
                  </Card>
                </div>
              )}
            </div>
          </div>

          {/* Leyenda de estados (paleta operacional completa) */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            {Object.entries(AGENT_STATE_STYLE).map(([key, style]) => (
              <span key={key} className="flex items-center gap-1.5">
                <span className={cn('size-1.5 rounded-full', style.dot)} />
                <span className="font-mono text-[10px] text-slate-400">{style.label}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Columna lateral */}
        <aside className="flex shrink-0 flex-col gap-4 lg:w-[340px]">
          {/* Ticker de movimientos reales */}
          <Card className="gap-2 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <div className="flex items-center gap-2">
              <MoveRight className="size-4 text-teal-300" />
              <CardTitle className="text-sm">Últimos movimientos</CardTitle>
            </div>
            {moves.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Sin movimientos registrados. Los avatares solo se mueven con eventos reales
                <span className="font-mono text-slate-400"> agent.location.changed</span>.
              </p>
            ) : (
              <ul className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
                {moves.map((mv) => {
                  const fromName = locNameByCode.get(str(mv.payload.from)) ?? str(mv.payload.from)
                  const toName = locNameByCode.get(str(mv.payload.to)) ?? str(mv.payload.to)
                  return (
                    <li key={mv.seq} className="flex items-center gap-1.5 text-[11px]">
                      <span className="shrink-0 font-mono text-slate-300">{str(mv.payload.code) || '—'}</span>
                      <span className="truncate text-slate-500">{fromName}</span>
                      <MoveRight className="size-3 shrink-0 text-teal-400" />
                      <span className="truncate text-slate-300">{toName}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">{timeAgo(mv.timestamp)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          {/* Panel colapsable: Estado del mundo */}
          <Card className="gap-3 rounded-xl border-slate-800 bg-slate-900/60 p-4 py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Estado del mundo</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label={panelOpen ? 'Colapsar panel' : 'Expandir panel'}
                className="size-7 text-slate-400 hover:text-slate-200"
                onClick={() => setPanelOpen((v) => !v)}
              >
                {panelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
              </Button>
            </div>

            {cmdError && (
              <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                {cmdError}
              </p>
            )}

            {panelOpen && (
              <div className="flex flex-col gap-3">
                {/* Agentes reales del snapshot */}
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    Agentes ({snapshot.agents.length})
                  </p>
                  <div className="max-h-44 space-y-0.5 overflow-y-auto pr-1">
                    {snapshot.agents.length === 0 && (
                      <p className="px-1 py-2 text-[11px] text-slate-500">Sin agentes registrados.</p>
                    )}
                    {snapshot.agents.map((a) => {
                      const st = AGENT_STATE_STYLE[a.state]
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => selectAgent(a.id)}
                          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-slate-800/60"
                        >
                          <span className={cn('size-2 shrink-0 rounded-full', st?.dot ?? 'bg-slate-600')} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-slate-200">{a.name}</span>
                            <span className="block truncate font-mono text-[10px] text-slate-500">
                              {a.code} · {a.location?.name ?? 'sin ubicación'}
                            </span>
                          </span>
                          <Badge variant="outline" className={cn('h-4 shrink-0 px-1 py-0 text-[9px]', st?.chip)}>
                            {st?.label ?? a.state}
                          </Badge>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <Separator className="bg-slate-800" />

                {/* Reuniones activas reales */}
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    Reuniones activas ({activeMeetings.length})
                  </p>
                  <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                    {activeMeetings.length === 0 && (
                      <p className="px-1 py-2 text-[11px] text-slate-500">Sin reuniones activas.</p>
                    )}
                    {activeMeetings.map((m) => (
                      <div key={m.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">{m.title}</span>
                          <Badge variant="outline" className={cn('h-4 shrink-0 px-1 py-0 text-[9px]', MEETING_CHIP[m.status])}>
                            {m.status}
                          </Badge>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                          {m.code} · {m.location?.name ?? 'sin sala'}
                        </p>
                        {m.participants.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {m.participants.map((p) => {
                              const st = p.agent ? AGENT_STATE_STYLE[p.agent.state] : undefined
                              return (
                                <span
                                  key={p.id}
                                  className={cn(
                                    'inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[9px]',
                                    st?.chip ?? 'border-slate-700 bg-slate-800/60 text-slate-400',
                                  )}
                                >
                                  <span className={cn('size-1.5 rounded-full', st?.dot ?? 'bg-slate-500')} />
                                  <span className="font-mono">{p.agent?.code ?? '—'}</span>
                                </span>
                              )
                            })}
                          </div>
                        )}
                        <div className="mt-2 flex justify-end">
                          {m.status === 'SCHEDULED' || m.status === 'INVITED' ? (
                            <Button
                              size="sm"
                              className="h-6 gap-1 border border-emerald-400/30 bg-emerald-400/10 px-2 text-[10px] text-emerald-300 hover:bg-emerald-400/20"
                              disabled={busyMeetingId === m.id}
                              onClick={() => setPendingMeeting({ id: m.id, code: m.code, cmd: 'meeting.start' })}
                            >
                              <Play className="size-3" /> Iniciar
                            </Button>
                          ) : m.status === 'IN_PROGRESS' ? (
                            <Button
                              size="sm"
                              className="h-6 gap-1 border border-rose-400/30 bg-rose-400/10 px-2 text-[10px] text-rose-300 hover:bg-rose-400/20"
                              disabled={busyMeetingId === m.id}
                              onClick={() => setPendingMeeting({ id: m.id, code: m.code, cmd: 'meeting.end' })}
                            >
                              <Square className="size-3" /> Finalizar
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </aside>
      </div>

      {/* ---------- confirmación operacional: meeting.start / meeting.end ---------- */}
      <AlertDialog open={pendingMeeting !== null} onOpenChange={(open) => { if (!open) setPendingMeeting(null) }}>
        <AlertDialogContent className="border-slate-800 bg-slate-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-100">
              {pendingMeeting?.cmd === 'meeting.end'
                ? `Finalizar reunión ${pendingMeeting.code}`
                : `Iniciar reunión ${pendingMeeting?.code ?? ''}`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              {pendingMeeting?.cmd === 'meeting.end'
                ? (
                    <>
                      Se cerrará la reunión <span className="font-mono text-slate-300">{pendingMeeting.code}</span>. Los agentes
                      volverán a su estado previo y las action items pueden generar tareas reales.
                    </>
                  )
                : 'Los agentes invitados pasarán a IN_MEETING; se pausará su trabajo en curso.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter aria-label="Confirmar o cancelar el comando de reunión">
            <AlertDialogCancel className="h-11 border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800 hover:text-slate-100">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className={`h-11 ${pendingMeeting?.cmd === 'meeting.end'
                ? 'bg-rose-600 text-white hover:bg-rose-500'
                : 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400'}`}
              onClick={() => {
                const p = pendingMeeting
                setPendingMeeting(null)
                if (p) void runMeetingCommand(p.id, p.cmd)
              }}
            >
              {pendingMeeting?.cmd === 'meeting.end' ? 'Finalizar' : 'Iniciar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
