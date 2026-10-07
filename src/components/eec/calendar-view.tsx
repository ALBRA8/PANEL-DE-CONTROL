'use client'

// ============================================================
// EEC — VISTA CALENDARIO (spec §33)
// Grid mensual custom + agenda del día + schedules del sistema.
// El scheduler del motor (spec §22) dispara comandos reales — la UI solo refleja.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth,
  isToday, startOfMonth, startOfWeek, subMonths,
} from 'date-fns'
import { es as localeEs } from 'date-fns/locale'
import {
  Bell, CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, Cpu, Info, Timer,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { timeAgo, type CommandResult } from '@/lib/eec-client'
import { useEecStore } from '@/store/eec-store'
import { cn } from '@/lib/utils'

// ---------- catálogos ----------
const EVENT_TYPES = ['MEETING', 'DEADLINE', 'SCHEDULED_RUN', 'REMINDER', 'FOCUS_BLOCK'] as const
type EventType = (typeof EVENT_TYPES)[number]

const TYPE_DOT: Record<EventType, string> = {
  MEETING: 'bg-fuchsia-400',
  DEADLINE: 'bg-rose-400',
  SCHEDULED_RUN: 'bg-emerald-400',
  REMINDER: 'bg-amber-400',
  FOCUS_BLOCK: 'bg-teal-400',
}

const TYPE_CHIP: Record<EventType, string> = {
  MEETING: 'bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30',
  DEADLINE: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  SCHEDULED_RUN: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  REMINDER: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  FOCUS_BLOCK: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
}

const STATUS_CHIP: Record<string, string> = {
  SCHEDULED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  CONFIRMED: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  COMPLETED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  CANCELLED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
}

const KIND_CHIP: Record<string, string> = {
  ONE_TIME: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  RECURRING: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  EVENT_TRIGGERED: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  DEPENDENCY_TRIGGERED: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  DEADLINE_TRIGGERED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
}

const RUN_COMMANDS = ['task.create', 'workflow.start'] as const
const WEEK_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const

// ---------- tipos del API /api/eec/calendar (modelos Prisma serializados) ----------
interface CalEvent {
  id: string; title: string; type: string
  startAt: string; endAt: string | null; allDay: boolean
  status: string; reminderMinutes: number | null
}
interface CalSchedule {
  id: string; name: string; kind: string; expression: string
  commandType: string; enabled: boolean
  lastRunAt: string | null; nextRunAt: string | null
}
interface CalData { events: CalEvent[]; schedules: CalSchedule[] }

function isEventType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t)
}

export default function CalendarView() {
  const command = useEecStore((s) => s.command)

  const [data, setData] = useState<CalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [monthCursor, setMonthCursor] = useState<Date>(() => startOfMonth(new Date()))
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date())
  const [schedulesOpen, setSchedulesOpen] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)

  // form: nuevo evento
  const [evTitle, setEvTitle] = useState('')
  const [evType, setEvType] = useState<EventType>('REMINDER')
  const [evStart, setEvStart] = useState('')
  const [evEnd, setEvEnd] = useState('')
  const [evCommandType, setEvCommandType] = useState<typeof RUN_COMMANDS[number]>('task.create')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/calendar', { cache: 'no-store' })
      if (!res.ok) throw new Error(`calendar ${res.status}`)
      const json = (await res.json()) as CalData
      setData({ events: json.events ?? [], schedules: json.schedules ?? [] })
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'error de red')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (type: string, payload: Record<string, unknown>, okMsg: string): Promise<boolean> => {
    const res: CommandResult = await command(type, payload)
    if (!res.ok) {
      toast.error(res.error ? `Comando rechazado: ${res.error}` : 'Comando rechazado')
      return false
    }
    toast.success(okMsg)
    void load()
    return true
  }, [command, load])

  const events = data?.events ?? []
  const schedules = data?.schedules ?? []

  // índice de eventos por día (yyyy-MM-dd)
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>()
    for (const ev of events) {
      const key = format(new Date(ev.startAt), 'yyyy-MM-dd')
      const list = map.get(key)
      if (list) list.push(ev)
      else map.set(key, [ev])
    }
    return map
  }, [events])

  const gridDays = useMemo(() => {
    return eachDayOfInterval({
      start: startOfWeek(startOfMonth(monthCursor), { weekStartsOn: 1 }),
      end: endOfWeek(endOfMonth(monthCursor), { weekStartsOn: 1 }),
    })
  }, [monthCursor])

  const dayEvents = useMemo(() => {
    const list = eventsByDay.get(format(selectedDay, 'yyyy-MM-dd')) ?? []
    return list.slice().sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
  }, [eventsByDay, selectedDay])

  const submitEvent = async () => {
    if (evTitle.trim().length < 2) { toast.error('El título requiere al menos 2 caracteres'); return }
    if (!evStart) { toast.error('Define la fecha/hora de inicio'); return }
    const start = new Date(evStart)
    if (Number.isNaN(start.getTime())) { toast.error('Fecha de inicio inválida'); return }
    let endIso: string | undefined
    if (evEnd) {
      const end = new Date(evEnd)
      if (Number.isNaN(end.getTime())) { toast.error('Fecha de fin inválida'); return }
      if (end.getTime() < start.getTime()) { toast.error('La fecha de fin es anterior al inicio'); return }
      endIso = end.toISOString()
    }
    const ok = await run('calendar.create', {
      title: evTitle.trim(),
      type: evType,
      startAt: start.toISOString(),
      ...(endIso ? { endAt: endIso } : {}),
      ...(evType === 'SCHEDULED_RUN' ? { commandType: evCommandType } : {}),
    }, `Evento "${evTitle.trim()}" creado en el calendario`)
    if (ok) {
      setDialogOpen(false); setEvTitle(''); setEvStart(''); setEvEnd(''); setEvType('REMINDER'); setEvCommandType('task.create')
    }
  }

  const toggleSchedule = (s: CalSchedule, enabled: boolean) => {
    void run('schedule.toggle', { scheduleId: s.id, enabled },
      `Schedule "${s.name}" ${enabled ? 'habilitado' : 'deshabilitado'}`)
  }

  // ---------- estados de carga y error ----------
  if (loading && !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]" aria-busy="true" aria-label="Cargando calendario">
        <Skeleton className="h-[420px] w-full" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    )
  }

  if (loadError && !data) {
    return (
      <Card className="border-rose-500/30 bg-slate-900/60">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-rose-300">No se pudo cargar el calendario: {loadError}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }}>
            Reintentar
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* ---------- grid mensual custom ---------- */}
        <Card className="border-slate-800 bg-slate-900/50">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm capitalize text-slate-100">
              {format(monthCursor, 'MMMM yyyy', { locale: localeEs })}
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="size-7 text-slate-400 hover:text-slate-100"
                aria-label="Mes anterior" onClick={() => setMonthCursor((m) => subMonths(m, 1))}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-teal-300 hover:bg-teal-400/10"
                onClick={() => { setMonthCursor(startOfMonth(new Date())); setSelectedDay(new Date()) }}>
                Hoy
              </Button>
              <Button variant="ghost" size="icon" className="size-7 text-slate-400 hover:text-slate-100"
                aria-label="Mes siguiente" onClick={() => setMonthCursor((m) => addMonths(m, 1))}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="mb-1 grid grid-cols-7 gap-1">
              {WEEK_LABELS.map((d) => (
                <div key={d} className="py-1 text-center font-mono text-[10px] uppercase text-slate-500">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {gridDays.map((day) => {
                const key = format(day, 'yyyy-MM-dd')
                const evs = eventsByDay.get(key) ?? []
                const dots = Array.from(new Set(evs.map(e => e.type))).filter(isEventType).slice(0, 4)
                const selected = isSameDay(day, selectedDay)
                const inMonth = isSameMonth(day, monthCursor)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedDay(day)}
                    aria-label={`Día ${format(day, 'd MMMM', { locale: localeEs })}, ${evs.length} evento(s)`}
                    aria-pressed={selected}
                    className={cn(
                      'flex h-16 flex-col items-center justify-start rounded-md border px-1 pt-1 transition-colors sm:h-[74px]',
                      inMonth ? 'border-slate-800 bg-slate-950/60' : 'border-transparent bg-slate-950/20 opacity-40',
                      !selected && 'hover:border-teal-400/40',
                      selected && 'border-teal-400/70 bg-teal-400/10',
                      isToday(day) && !selected && 'border-teal-400/40',
                    )}
                  >
                    <span className={cn(
                      'font-mono text-[11px]',
                      isToday(day) ? 'font-bold text-teal-300' : inMonth ? 'text-slate-300' : 'text-slate-500',
                    )}>
                      {format(day, 'd')}
                    </span>
                    <span className="mt-auto mb-1 flex items-center gap-0.5" aria-hidden="true">
                      {dots.map((t) => (
                        <span key={t} className={cn('size-1.5 rounded-full', TYPE_DOT[t])} />
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>
            {/* leyenda */}
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2">
              {EVENT_TYPES.map((t) => (
                <span key={t} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <span className={cn('size-1.5 rounded-full', TYPE_DOT[t])} aria-hidden="true" /> {t}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ---------- agenda del día ---------- */}
        <Card className="flex flex-col border-slate-800 bg-slate-900/50">
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-sm text-slate-100">Agenda</CardTitle>
              <p className="mt-0.5 text-xs capitalize text-slate-400">
                {format(selectedDay, "EEEE, d 'de' MMMM", { locale: localeEs })}
              </p>
            </div>
            <Button size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              onClick={() => { setEvStart(format(selectedDay, "yyyy-MM-dd'T'09:00")); setDialogOpen(true) }}>
              <CalendarPlus className="size-4" /> Nuevo evento
            </Button>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-3 pt-0">
            {dayEvents.length === 0 ? (
              <p className="py-10 text-center text-xs text-slate-500">Sin eventos para este día.</p>
            ) : (
              <ul className="max-h-[380px] space-y-2 overflow-y-auto pr-1">
                {dayEvents.map((ev) => {
                  const chip = isEventType(ev.type) ? TYPE_CHIP[ev.type] : 'bg-slate-500/15 text-slate-300 border-slate-500/30'
                  return (
                    <li key={ev.id} className="rounded-md border border-slate-800 bg-slate-950/70 p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
                          {ev.allDay
                            ? <Timer className="size-3" aria-label="todo el día" />
                            : format(new Date(ev.startAt), 'HH:mm')}
                          {ev.endAt && !ev.allDay && <>–{format(new Date(ev.endAt), 'HH:mm')}</>}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-100" title={ev.title}>{ev.title}</span>
                        <Badge variant="outline" className={cn('shrink-0 font-mono text-[10px]', chip)}>{ev.type}</Badge>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className={cn('font-mono text-[10px]', STATUS_CHIP[ev.status] ?? STATUS_CHIP.SCHEDULED)}>
                          {ev.status}
                        </Badge>
                        {ev.reminderMinutes !== null && ev.reminderMinutes !== undefined && (
                          <span className="flex items-center gap-1 text-[10px] text-amber-300/90">
                            <Bell className="size-3" aria-hidden="true" /> recordatorio {ev.reminderMinutes}m antes
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- schedules del sistema ---------- */}
      <Card className="border-slate-800 bg-slate-900/50">
        <Collapsible open={schedulesOpen} onOpenChange={setSchedulesOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="flex w-full items-center justify-between px-6 py-4 hover:bg-transparent">
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <Cpu className="size-4 text-emerald-300" /> Schedules del sistema
                <Badge variant="outline" className="font-mono text-[10px] text-slate-400 border-slate-700">
                  {schedules.length}
                </Badge>
              </span>
              {schedulesOpen
                ? <ChevronLeft className="size-4 text-slate-400" aria-label="Colapsar" />
                : <ChevronRight className="size-4 text-slate-400" aria-label="Expandir" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-3 px-6 pb-6 pt-0">
              <p className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Los disparos del scheduler son reales (spec §22): cada schedule habilitado ejecuta su comando en el
                motor según su expresión. Desactiva el switch para detener sus disparos.
              </p>
              {schedules.length === 0 ? (
                <p className="text-xs text-slate-500">Sin schedules registrados.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-800 hover:bg-transparent">
                        <TableHead className="text-xs text-slate-400">Nombre</TableHead>
                        <TableHead className="text-xs text-slate-400">Kind</TableHead>
                        <TableHead className="text-xs text-slate-400">Expresión</TableHead>
                        <TableHead className="text-xs text-slate-400">Comando</TableHead>
                        <TableHead className="text-xs text-slate-400">Activo</TableHead>
                        <TableHead className="text-xs text-slate-400">Última ejecución</TableHead>
                        <TableHead className="text-xs text-slate-400">Próxima</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schedules.map((s) => (
                        <TableRow key={s.id} className="border-slate-800">
                          <TableCell className="text-xs text-slate-200">{s.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn('font-mono text-[10px]', KIND_CHIP[s.kind] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30')}>
                              {s.kind}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-[11px] text-teal-300">{s.expression}</span>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-[11px] text-slate-300">{s.commandType}</span>
                          </TableCell>
                          <TableCell>
                            <Switch checked={s.enabled} aria-label={`Habilitar schedule ${s.name}`}
                              onCheckedChange={(v) => toggleSchedule(s, v)} />
                          </TableCell>
                          <TableCell className="text-[11px] text-slate-400">{timeAgo(s.lastRunAt)}</TableCell>
                          <TableCell className="text-[11px] text-slate-400">{s.enabled ? timeAgo(s.nextRunAt) : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* ---------- dialog: nuevo evento ---------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-100">
              <CalendarClock className="size-4 text-emerald-300" /> Nuevo evento
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              Vía <span className="font-mono">calendar.create</span> — fechas en tu zona horaria local, enviadas como ISO UTC.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cal-title" className="text-xs text-slate-300">Título *</Label>
              <Input id="cal-title" value={evTitle} onChange={(e) => setEvTitle(e.target.value)}
                placeholder="Revisión trimestral" className="border-slate-800 bg-slate-900" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cal-start" className="text-xs text-slate-300">Inicio *</Label>
                <Input id="cal-start" type="datetime-local" value={evStart}
                  onChange={(e) => setEvStart(e.target.value)} className="border-slate-800 bg-slate-900 font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cal-end" className="text-xs text-slate-300">Fin (opcional)</Label>
                <Input id="cal-end" type="datetime-local" value={evEnd}
                  onChange={(e) => setEvEnd(e.target.value)} className="border-slate-800 bg-slate-900 font-mono" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-300">Tipo</Label>
              <Select value={evType} onValueChange={(v) => { if (isEventType(v)) setEvType(v) }}>
                <SelectTrigger className="w-full border-slate-800 bg-slate-900"><SelectValue /></SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900">
                  {EVENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {evType === 'SCHEDULED_RUN' && (
              <div className="space-y-1.5 rounded-md border border-emerald-400/30 bg-emerald-400/5 p-3">
                <Label className="text-xs text-emerald-200">commandType del disparo</Label>
                <Select value={evCommandType} onValueChange={(v) => { if ((RUN_COMMANDS as readonly string[]).includes(v)) setEvCommandType(v as typeof RUN_COMMANDS[number]) }}>
                  <SelectTrigger className="w-full border-slate-800 bg-slate-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-900">
                    {RUN_COMMANDS.map((c) => (
                      <SelectItem key={c} value={c} className="font-mono text-xs">{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-emerald-200/80">
                  Este evento registra la ejecución programada en el calendario; el disparo real lo ejecuta el
                  scheduler del motor (spec §22) con el commandType seleccionado.
                </p>
              </div>
            )}
            <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
              La hora se interpreta en tu zona local y se almacena como UTC.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => void submitEvent()}>
              Crear evento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
