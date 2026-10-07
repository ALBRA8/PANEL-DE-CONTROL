'use client'

// ============================================================
// EEC — VISTA REUNIONES (spec §34)
// Reuniones del snapshot agrupadas en activas / históricas.
// Los comandos (start / end / create) cambian el estado real;
// la UI solo lo refleja (p.ej. agentes IN_MEETING al iniciar).
// ============================================================
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { es as localeEs } from 'date-fns/locale'
import {
  CalendarPlus, ChevronDown, ChevronRight, Crown, DoorOpen, Info, MapPin, Play, Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AGENT_STATE_STYLE, type CommandResult, type EecMeeting, type EecMeetingParticipant } from '@/lib/eec-client'
import { useEecStore } from '@/store/eec-store'
import { cn } from '@/lib/utils'

// ---------- catálogos ----------
const MEETING_STATUS_CHIP: Record<string, string> = {
  IN_PROGRESS: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40 animate-pulse',
  INVITED: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SCHEDULED: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  COMPLETED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
}

const AGENT_RING: Record<string, string> = {
  OFFLINE: 'ring-slate-500', IDLE: 'ring-teal-400', WORKING: 'ring-emerald-400',
  WAITING: 'ring-amber-400', BLOCKED: 'ring-rose-500', REVIEW: 'ring-violet-400',
  IN_MEETING: 'ring-fuchsia-400', ERROR: 'ring-rose-600', PAUSED: 'ring-amber-500',
  SUSPENDED: 'ring-slate-600', DONE: 'ring-emerald-300', RECOVERY: 'ring-amber-300',
}

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
type Priority = (typeof PRIORITIES)[number]

interface ActionItem { title: string; priority: Priority; taskId?: string }

const ACTIVE_STATUSES = ['SCHEDULED', 'INVITED', 'IN_PROGRESS'] as const
const HISTORY_STATUSES = ['COMPLETED', 'CANCELLED'] as const

// ---------- helpers defensivos (el snapshot puede no traer estos campos) ----------
function readJsonField(meeting: EecMeeting, field: string): unknown {
  const raw = (meeting as unknown as Record<string, unknown>)[field]
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function readStringList(meeting: EecMeeting, field: string): string[] {
  const parsed = readJsonField(meeting, field)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((x): x is string => typeof x === 'string')
}

function readActionItems(meeting: EecMeeting): ActionItem[] {
  const parsed = readJsonField(meeting, 'actionItemsJson')
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((x) => {
    if (typeof x !== 'object' || x === null) return []
    const rec = x as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title : ''
    const priority = typeof rec.priority === 'string' && (PRIORITIES as readonly string[]).includes(rec.priority)
      ? rec.priority as Priority
      : 'MEDIUM'
    const taskId = typeof rec.taskId === 'string' ? rec.taskId : undefined
    return title ? [{ title, priority, taskId }] : []
  })
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

function parseLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

function parseActionItemLines(text: string): Array<{ title: string; priority: Priority }> {
  return parseLines(text).flatMap((line) => {
    const parts = line.split('|').map((p) => p.trim())
    const title = parts[0] ?? ''
    if (!title) return []
    const rawPri = (parts[1] ?? 'MEDIUM').toUpperCase()
    const priority: Priority = (PRIORITIES as readonly string[]).includes(rawPri) ? rawPri as Priority : 'MEDIUM'
    return [{ title, priority }]
  })
}

// ---------- tarjeta de reunión ----------
interface MeetingCardProps {
  meeting: EecMeeting
  onFinish: (m: EecMeeting) => void
  onStart: (m: EecMeeting) => void
  busy: boolean
}

function MeetingCard({ meeting, onFinish, onStart, busy }: MeetingCardProps) {
  const chip = MEETING_STATUS_CHIP[meeting.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30'
  const organizer = meeting.participants.find((p) => p.role === 'ORGANIZER') ?? null
  const agenda = readStringList(meeting, 'agendaJson')
  const decisions = readStringList(meeting, 'decisionsJson')
  const items = readActionItems(meeting)
  const result = typeof (meeting as unknown as Record<string, unknown>).result === 'string'
    ? (meeting as unknown as Record<string, unknown>).result as string
    : null
  const completed = meeting.status === 'COMPLETED'
  const cancelled = meeting.status === 'CANCELLED'

  return (
    <article className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 transition-colors hover:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-500">{meeting.code}</span>
            <Badge variant="outline" className={cn('font-mono text-[10px]', chip)}>{meeting.status}</Badge>
          </div>
          <h3 className="mt-1 truncate text-sm font-medium text-slate-100" title={meeting.title}>{meeting.title}</h3>
          {meeting.objective && <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{meeting.objective}</p>}
          {agenda.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {agenda.slice(0, 3).map((a, idx) => (
                <li key={idx} className="flex items-start gap-1.5 text-[11px] text-slate-500">
                  <span className="font-mono text-slate-600">{String(idx + 1).padStart(2, '0')}</span>
                  <span className="truncate">{a}</span>
                </li>
              ))}
              {agenda.length > 3 && <li className="text-[11px] text-slate-600">+{agenda.length - 3} puntos más</li>}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {meeting.location && (
            <span className="flex items-center gap-1 text-[11px] text-slate-400">
              <MapPin className="size-3 text-teal-300" aria-hidden="true" /> {meeting.location.name}
            </span>
          )}
          <span className="font-mono text-[11px] text-slate-300">
            {format(new Date(meeting.scheduledStartAt), 'EEE d MMM · HH:mm', { locale: localeEs })}
            {meeting.scheduledEndAt ? `–${format(new Date(meeting.scheduledEndAt), 'HH:mm')}` : ''}
          </span>
          {meeting.startedAt && meeting.status === 'IN_PROGRESS' && (
            <span className="text-[10px] text-fuchsia-300">
              inició {format(new Date(meeting.startedAt), 'HH:mm')}
            </span>
          )}
        </div>
      </div>

      {/* participantes */}
      {meeting.participants.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5">
          <Users className="mr-1 size-3.5 text-slate-500" aria-hidden="true" />
          {meeting.participants.map((p) => (
            <ParticipantAvatar key={p.id} participant={p} />
          ))}
        </div>
      )}

      {/* resultados de reuniones completadas (si el snapshot los trae) */}
      {completed && (
        <div className="mt-3 space-y-2 rounded-md border border-slate-800 bg-slate-900/50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Resultado</p>
          <div>
            <p className="text-[11px] text-slate-500">Decisiones</p>
            {decisions.length > 0 ? (
              <ul className="list-inside list-disc text-xs text-slate-300">
                {decisions.map((d, idx) => <li key={idx}>{d}</li>)}
              </ul>
            ) : <p className="text-xs text-slate-600">—</p>}
          </div>
          <div>
            <p className="text-[11px] text-slate-500">Action items</p>
            {items.length > 0 ? (
              <ul className="space-y-0.5">
                {items.map((a, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-xs text-slate-300">
                    <span className="truncate">{a.title}</span>
                    <Badge variant="outline" className="shrink-0 font-mono text-[9px] text-slate-400 border-slate-700">{a.priority}</Badge>
                    {a.taskId && <span className="shrink-0 font-mono text-[9px] text-emerald-400">tarea creada</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-slate-600">—</p>}
          </div>
          <div>
            <p className="text-[11px] text-slate-500">Resultado general</p>
            <p className="text-xs text-slate-300">{result ?? '—'}</p>
          </div>
        </div>
      )}

      {/* acciones según estado real */}
      {!cancelled && (
        <div className="mt-3 flex items-center gap-2">
          {(meeting.status === 'SCHEDULED' || meeting.status === 'INVITED') && (
            <Button size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              disabled={busy} onClick={() => onStart(meeting)}>
              <Play className="size-3.5" /> Iniciar reunión
            </Button>
          )}
          {meeting.status === 'IN_PROGRESS' && (
            <Button size="sm" className="bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400"
              disabled={busy} onClick={() => onFinish(meeting)}>
              <DoorOpen className="size-3.5" /> Finalizar
            </Button>
          )}
        </div>
      )}
      {/* organizer destacado (referencia para lectores) */}
      {organizer?.agent && <span className="sr-only">Organizador: {organizer.agent.name}</span>}
    </article>
  )
}

function ParticipantAvatar({ participant }: { participant: EecMeetingParticipant }) {
  const agent = participant.agent
  const state = agent?.state ?? 'OFFLINE'
  const ring = AGENT_RING[state] ?? 'ring-slate-600'
  const label = agent
    ? `${agent.name} (${agent.code}) — ${state} · respuesta: ${participant.response}${participant.role === 'ORGANIZER' ? ' · organizador' : ''}`
    : `Participante sin agente — ${participant.response}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(
          'relative flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-[10px] font-semibold text-slate-200 ring-2',
          ring,
        )}>
          {initials(agent?.name ?? '?')}
          {participant.role === 'ORGANIZER' && (
            <Crown className="absolute -right-1 -top-1.5 size-3 text-amber-300" aria-hidden="true" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-56 border border-slate-700 bg-slate-900 text-xs">
        <p className="font-medium text-slate-100">{agent?.name ?? 'Participante'}</p>
        {agent && <p className="font-mono text-[10px] text-slate-400">{agent.code} · {state}</p>}
        <p className="text-[10px] text-slate-400">{participant.role} · {participant.response}</p>
      </TooltipContent>
    </Tooltip>
  )
}

// ---------- vista principal ----------
export default function MeetingsView() {
  const snapshot = useEecStore((s) => s.snapshot)
  const command = useEecStore((s) => s.command)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // dialog: finalizar
  const [finishMeeting, setFinishMeeting] = useState<EecMeeting | null>(null)
  const [fDecisions, setFDecisions] = useState('')
  const [fItems, setFItems] = useState('')
  const [fResult, setFResult] = useState('')

  // dialog: programar
  const [createOpen, setCreateOpen] = useState(false)
  const [mTitle, setMTitle] = useState('')
  const [mObjective, setMObjective] = useState('')
  const [mAgenda, setMAgenda] = useState('')
  const [mRoom, setMRoom] = useState('')
  const [mStart, setMStart] = useState('')
  const [mDuration, setMDuration] = useState('30')
  const [mAgents, setMAgents] = useState<string[]>([])

  const run = useCallback(async (type: string, payload: Record<string, unknown>, okMsg: string): Promise<boolean> => {
    setBusy(true)
    try {
      const res: CommandResult = await command(type, payload)
      if (!res.ok) {
        toast.error(res.error ? `Comando rechazado: ${res.error}` : 'Comando rechazado')
        return false
      }
      toast.success(okMsg)
      return true
    } finally {
      setBusy(false)
    }
  }, [command])

  const meetings = snapshot?.meetings ?? []
  const active = useMemo(() => meetings
    .filter((m) => (ACTIVE_STATUSES as readonly string[]).includes(m.status))
    .sort((a, b) => new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime()), [meetings])
  const history = useMemo(() => meetings
    .filter((m) => (HISTORY_STATUSES as readonly string[]).includes(m.status))
    .sort((a, b) => new Date(b.scheduledStartAt).getTime() - new Date(a.scheduledStartAt).getTime()), [meetings])

  const locations = snapshot?.locations ?? []
  const selectableAgents = useMemo(() =>
    (snapshot?.agents ?? []).filter((a) => a.state !== 'OFFLINE'), [snapshot])

  const openFinish = (m: EecMeeting) => {
    setFinishMeeting(m); setFDecisions(''); setFItems(''); setFResult('')
  }

  const submitFinish = async () => {
    if (!finishMeeting) return
    const decisions = parseLines(fDecisions)
    const actionItems = parseActionItemLines(fItems)
    if (fItems.trim() && actionItems.length === 0) {
      toast.error('No se pudo interpretar ninguna action item (formato: título | prioridad)')
      return
    }
    const ok = await run('meeting.end', {
      meetingId: finishMeeting.id,
      decisions,
      actionItems,
      ...(fResult.trim() ? { result: fResult.trim() } : {}),
    }, `Reunión ${finishMeeting.code} finalizada${actionItems.length > 0 ? ` · ${actionItems.length} tarea(s) generada(s)` : ''}`)
    if (ok) setFinishMeeting(null)
  }

  const openCreate = () => {
    setMTitle(''); setMObjective(''); setMAgenda('')
    setMRoom(locations.some((l) => l.code === 'HQ-BOARDROOM') ? 'HQ-BOARDROOM' : (locations[0]?.code ?? ''))
    setMStart(format(new Date(Date.now() + 60 * 60_000), "yyyy-MM-dd'T'HH:mm"))
    setMDuration('30'); setMAgents([])
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    if (mTitle.trim().length < 3) { toast.error('El título requiere al menos 3 caracteres'); return }
    if (!mStart) { toast.error('Define la fecha/hora de inicio'); return }
    const start = new Date(mStart)
    if (Number.isNaN(start.getTime())) { toast.error('Fecha de inicio inválida'); return }
    const duration = Number(mDuration)
    if (!Number.isInteger(duration) || duration <= 0) { toast.error('Duración inválida (minutos enteros positivos)'); return }
    const ok = await run('meeting.create', {
      title: mTitle.trim(),
      ...(mObjective.trim() ? { objective: mObjective.trim() } : {}),
      agenda: parseLines(mAgenda),
      ...(mRoom ? { locationCode: mRoom } : {}),
      scheduledStartAt: start.toISOString(),
      durationMinutes: duration,
      participantAgentIds: mAgents,
    }, `Reunión "${mTitle.trim()}" programada`)
    if (ok) setCreateOpen(false)
  }

  const toggleAgent = (agentId: string, checked: boolean) => {
    setMAgents((prev) => checked ? [...prev, agentId] : prev.filter((id) => id !== agentId))
  }

  // ---------- carga ----------
  if (!snapshot) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Cargando reuniones">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Reuniones</h2>
          <p className="text-xs text-slate-400">
            {active.length} activa{active.length === 1 ? '' : 's'} · {history.length} histórica{history.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={openCreate}>
          <CalendarPlus className="size-4" /> Programar reunión
        </Button>
      </div>

      {/* ---------- activas ---------- */}
      <section aria-label="Reuniones activas" className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <span className="size-1.5 rounded-full bg-fuchsia-400 animate-pulse" aria-hidden="true" /> Activas
        </h3>
        {active.length === 0 ? (
          <Card className="border-slate-800 bg-slate-900/50">
            <CardContent className="p-6 text-center text-xs text-slate-500">
              Sin reuniones activas. Programa la primera con &quot;Programar reunión&quot;.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {active.map((m) => (
              <MeetingCard key={m.id} meeting={m} busy={busy}
                onStart={(mm) => { void run('meeting.start', { meetingId: mm.id }, `Reunión ${mm.code} iniciada — participantes en IN_MEETING`) }}
                onFinish={openFinish} />
            ))}
          </div>
        )}
      </section>

      {/* ---------- históricas (colapsable) ---------- */}
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <section aria-label="Reuniones históricas">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="flex w-full items-center gap-2 px-0 hover:bg-transparent">
              {historyOpen
                ? <ChevronDown className="size-4 text-slate-400" aria-hidden="true" />
                : <ChevronRight className="size-4 text-slate-400" aria-hidden="true" />}
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Históricas</span>
              <Badge variant="outline" className="font-mono text-[10px] text-slate-500 border-slate-700">{history.length}</Badge>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {history.length === 0 ? (
              <Card className="mt-3 border-slate-800 bg-slate-900/50">
                <CardContent className="p-6 text-center text-xs text-slate-500">Sin reuniones completadas ni canceladas.</CardContent>
              </Card>
            ) : (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {history.map((m) => (
                  <MeetingCard key={m.id} meeting={m} busy={busy}
                    onStart={(mm) => { void run('meeting.start', { meetingId: mm.id }, `Reunión ${mm.code} iniciada`) }}
                    onFinish={openFinish} />
                ))}
              </div>
            )}
          </CollapsibleContent>
        </section>
      </Collapsible>

      {/* ---------- dialog: finalizar reunión ---------- */}
      <Dialog open={finishMeeting !== null} onOpenChange={(open) => { if (!open) setFinishMeeting(null) }}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Finalizar {finishMeeting?.code}</DialogTitle>
            <DialogDescription className="text-slate-400">
              Vía <span className="font-mono">meeting.end</span> — los participantes volverán a su estado y ubicación previos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mtg-decisions" className="text-xs text-slate-300">Decisiones (una por línea)</Label>
              <Textarea id="mtg-decisions" value={fDecisions} onChange={(e) => setFDecisions(e.target.value)}
                rows={3} placeholder={'Se aprueba el presupuesto Q3\nSe posterga la migración'} className="border-slate-800 bg-slate-900" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-items" className="text-xs text-slate-300">Action items — una por línea: <span className="font-mono text-teal-300">título | prioridad</span></Label>
              <Textarea id="mtg-items" value={fItems} onChange={(e) => setFItems(e.target.value)}
                rows={3} placeholder={'Preparar propuesta técnica | HIGH\nActualizar matriz de riesgos | LOW'} className="border-slate-800 bg-slate-900" />
              <p className="flex items-start gap-1.5 text-[11px] text-amber-200">
                <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                Las action items generarán tareas reales en el tablero (prioridad por defecto: MEDIUM).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-result" className="text-xs text-slate-300">Resultado general (opcional)</Label>
              <Textarea id="mtg-result" value={fResult} onChange={(e) => setFResult(e.target.value)}
                rows={2} placeholder="Síntesis del desenlace…" className="border-slate-800 bg-slate-900" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setFinishMeeting(null)}>Cancelar</Button>
            <Button className="bg-fuchsia-500 text-fuchsia-950 hover:bg-fuchsia-400" disabled={busy}
              onClick={() => void submitFinish()}>
              Finalizar reunión
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- dialog: programar reunión ---------- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-slate-800 bg-slate-950 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Programar reunión</DialogTitle>
            <DialogDescription className="text-slate-400">
              Vía <span className="font-mono">meeting.create</span> — la hora local se envía como ISO UTC y se agenda
              automáticamente en el calendario.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mtg-title" className="text-xs text-slate-300">Título *</Label>
              <Input id="mtg-title" value={mTitle} onChange={(e) => setMTitle(e.target.value)}
                placeholder="Kickoff proyecto Fénix" className="border-slate-800 bg-slate-900" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-objective" className="text-xs text-slate-300">Objetivo</Label>
              <Input id="mtg-objective" value={mObjective} onChange={(e) => setMObjective(e.target.value)}
                placeholder="Alinear alcance y responsables" className="border-slate-800 bg-slate-900" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-agenda" className="text-xs text-slate-300">Agenda (una por línea)</Label>
              <Textarea id="mtg-agenda" value={mAgenda} onChange={(e) => setMAgenda(e.target.value)}
                rows={3} placeholder={'Contexto y métricas\nDecisiones pendientes'} className="border-slate-800 bg-slate-900" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-300">Sala</Label>
                <Select value={mRoom} onValueChange={setMRoom}>
                  <SelectTrigger className="w-full border-slate-800 bg-slate-900"><SelectValue placeholder="Sin sala" /></SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-900">
                    {locations.length === 0 && <SelectItem value="_none" disabled>Sin ubicaciones</SelectItem>}
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.code}>{l.name} <span className="font-mono text-[10px] text-slate-500">{l.code}</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mtg-duration" className="text-xs text-slate-300">Duración (minutos) *</Label>
                <Input id="mtg-duration" type="number" min={5} step={5} value={mDuration}
                  onChange={(e) => setMDuration(e.target.value)} className="border-slate-800 bg-slate-900 font-mono" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-start" className="text-xs text-slate-300">Inicio *</Label>
              <Input id="mtg-start" type="datetime-local" value={mStart}
                onChange={(e) => setMStart(e.target.value)} className="border-slate-800 bg-slate-900 font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-300">Participantes (agentes no OFFLINE)</Label>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-800 bg-slate-900/60 p-2">
                {selectableAgents.length === 0 && (
                  <p className="px-1 py-2 text-xs text-slate-500">No hay agentes disponibles (todos OFFLINE).</p>
                )}
                {selectableAgents.map((a) => {
                  const style = AGENT_STATE_STYLE[a.state]
                  return (
                    <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-slate-800/60">
                      <Checkbox checked={mAgents.includes(a.id)}
                        onCheckedChange={(v) => toggleAgent(a.id, v === true)}
                        aria-label={`Invitar a ${a.name}`} />
                      <span className="text-xs text-slate-200">{a.name}</span>
                      <span className="font-mono text-[10px] text-slate-500">{a.code}</span>
                      {style && (
                        <Badge variant="outline" className={cn('ml-auto font-mono text-[9px]', style.chip)}>{style.label}</Badge>
                      )}
                    </label>
                  )
                })}
              </div>
              <p className="text-[11px] text-slate-500">
                {mAgents.length} invitado{mAgents.length === 1 ? '' : 's'} — al iniciar la reunión pasarán a IN_MEETING (derivado del motor).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" disabled={busy}
              onClick={() => void submitCreate()}>
              Programar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
