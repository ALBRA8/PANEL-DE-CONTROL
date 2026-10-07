'use client'

// ============================================================
// EEC — EVENTOS + AUDITORÍA + TRAZAS (spec §14, §27, §28)
// - Eventos en vivo: cola realtime del bus (store socket.io).
// - Auditoría: registros WHO/WHAT/WHEN/WHY (inmutables).
// - Reconstrucción: toda operación es reconstruible por entidad.
// - Comandos: bitácora del pipeline (única vía de escritura).
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown, GitBranch, History, ListFilter, PenLine, RefreshCw, ScrollText,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useEecStore } from '@/store/eec-store'
import { RISK_STYLE, timeAgo } from '@/lib/eec-client'

// ---------- tipos locales (formas de la API) ----------
interface AuditRecordRow {
  id: string
  actorId: string
  actorType: string
  action: string
  entityType: string
  entityId: string
  why: string | null
  inputJson: string | null
  outputJson: string | null
  toolsJson: string | null
  result: string | null
  cost: number | null
  sim: boolean
  prevAuditId: string | null
  createdAt: string
}

interface EventTrailRow {
  seq: number
  id: string
  type: string
  subject: string
  createdAt: string
  payload: Record<string, unknown>
  correlationId: string | null
  causationId: string | null
  sim: boolean
}

interface CommandRow {
  id: string
  type: string
  status: string
  requesterType: string
  risk: string
  rejectionReason: string | null
  createdAt: string
  executedAt: string | null
}

// ---------- paletas por namespace / actor / estado ----------
const NS_STYLE: Record<string, string> = {
  agent: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  task: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  workflow: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  run: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  runtime: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  approval: 'bg-orange-400/10 text-orange-300 border-orange-400/30',
  meeting: 'bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30',
  client: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  memory: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  tool: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  system: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  knowledge: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
}

const ACTOR_STYLE: Record<string, string> = {
  HUMAN: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  AGENT: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  SYSTEM: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  COMMAND_PIPELINE: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
}

const COMMAND_STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  EXECUTED: { label: 'EXECUTED', cls: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30' },
  REJECTED: { label: 'REJECTED', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
  FAILED: { label: 'FAILED', cls: 'bg-rose-600/15 text-rose-300 border-rose-600/40' },
  POLICY_CHECKED: { label: 'esperando aprobación', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  DUPLICATE: { label: 'DUPLICATE', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  RECEIVED: { label: 'RECEIVED', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  DISPATCHED: { label: 'DISPATCHED', cls: 'bg-teal-400/10 text-teal-300 border-teal-400/30' },
}

function nsOf(eventType: string): string {
  return eventType.split('.')[0] ?? 'system'
}

function resultBadgeCls(result: string | null): string {
  if (!result) return 'bg-slate-500/10 text-slate-500 border-slate-700/60'
  const r = result.toUpperCase()
  if (/FAIL|REJECT|DENY|ERROR|BLOCK/.test(r)) return 'bg-rose-500/10 text-rose-300 border-rose-500/30'
  if (/PASS|OK|SUCCESS|APPROV|DONE|EXECUT/.test(r)) return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
  if (/REVIEW|PENDING|WAIT/.test(r)) return 'bg-amber-400/10 text-amber-300 border-amber-400/30'
  return 'bg-slate-500/15 text-slate-400 border-slate-600/40'
}

function prettyJson(raw: string | null | undefined): string {
  if (!raw) return '{}'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function prettyObj(obj: Record<string, unknown> | null | undefined): string {
  try {
    return JSON.stringify(obj ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('es-CO', { hour12: false })
  } catch {
    return '—'
  }
}

export default function EventsAuditView() {
  const events = useEecStore((s) => s.events)
  const connected = useEecStore((s) => s.connected)
  const command = useEecStore((s) => s.command)

  const [tab, setTab] = useState('events')

  // ---- eventos en vivo: filtros ----
  const [eventQuery, setEventQuery] = useState('')
  const [eventNs, setEventNs] = useState('ALL')

  // ---- auditoría ----
  const [auditRecords, setAuditRecords] = useState<AuditRecordRow[]>([])
  const [auditLoading, setAuditLoading] = useState(true)

  // ---- reconstrucción ----
  const [reconType, setReconType] = useState('')
  const [reconId, setReconId] = useState('')
  const [reconNonce, setReconNonce] = useState(0)
  const [reconData, setReconData] = useState<{ auditTrail: AuditRecordRow[]; eventTrail: EventTrailRow[] } | null>(null)
  const [reconLoading, setReconLoading] = useState(false)
  const [correctTarget, setCorrectTarget] = useState<AuditRecordRow | null>(null)
  const [correctWhy, setCorrectWhy] = useState('')
  const [correctOutput, setCorrectOutput] = useState('')
  const [correctResult, setCorrectResult] = useState('')

  // ---- comandos ----
  const [commands, setCommands] = useState<CommandRow[]>([])
  const [commandsLoading, setCommandsLoading] = useState(true)

  // ---------- cargas ----------
  const loadAudit = useCallback(async () => {
    setAuditLoading(true)
    try {
      const res = await fetch('/api/eec/audit', { cache: 'no-store' })
      if (!res.ok) throw new Error(`audit ${res.status}`)
      const data = (await res.json()) as { records: AuditRecordRow[] }
      setAuditRecords(Array.isArray(data.records) ? data.records : [])
    } catch (err) {
      toast.error('No se pudo cargar la auditoría', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setAuditLoading(false)
    }
  }, [])

  const loadCommands = useCallback(async () => {
    setCommandsLoading(true)
    try {
      const res = await fetch('/api/eec/ops', { cache: 'no-store' })
      if (!res.ok) throw new Error(`ops ${res.status}`)
      const data = (await res.json()) as { commands: CommandRow[] }
      setCommands(Array.isArray(data.commands) ? data.commands : [])
    } catch (err) {
      toast.error('No se pudo cargar la bitácora de comandos', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setCommandsLoading(false)
    }
  }, [])

  const loadReconstruction = useCallback(async (entityType: string, entityId: string) => {
    if (!entityType.trim() || !entityId.trim()) return
    setReconLoading(true)
    try {
      const params = new URLSearchParams({ entityType: entityType.trim(), entityId: entityId.trim() })
      const res = await fetch(`/api/eec/audit?${params.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`reconstruct ${res.status}`)
      const data = (await res.json()) as { auditTrail: unknown[]; eventTrail: unknown[] }
      setReconData({
        auditTrail: (data.auditTrail ?? []) as unknown as AuditRecordRow[],
        eventTrail: (data.eventTrail ?? []) as unknown as EventTrailRow[],
      })
    } catch (err) {
      setReconData(null)
      toast.error('No se pudo reconstruir la entidad', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setReconLoading(false)
    }
  }, [])

  // primera carga de cada tab bajo demanda + recarga al entrar
  useEffect(() => {
    if (tab === 'audit') void loadAudit()
    if (tab === 'commands') void loadCommands()
  }, [tab, loadAudit, loadCommands])

  // reconstrucción por nonce (llegada desde Auditoría o submit manual)
  useEffect(() => {
    if (reconNonce > 0 && reconType.trim() && reconId.trim()) {
      void loadReconstruction(reconType, reconId)
    }
  }, [reconNonce, reconType, reconId, loadReconstruction])

  // ---------- eventos en vivo: filtrado ----------
  const namespaces = useMemo(
    () => Array.from(new Set(events.map((e) => nsOf(e.event_type)))).sort(),
    [events],
  )

  const filteredEvents = useMemo(() => {
    const q = eventQuery.trim().toLowerCase()
    return events.filter((e) => {
      if (eventNs !== 'ALL' && nsOf(e.event_type) !== eventNs) return false
      if (!q) return true
      return (
        e.event_type.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        String(e.seq).includes(q)
      )
    })
  }, [events, eventQuery, eventNs])

  const visibleEvents = filteredEvents.slice(0, 150)
  const hiddenEvents = filteredEvents.length - visibleEvents.length

  // ---------- acciones ----------
  const goToReconstruction = useCallback((entityType: string, entityId: string) => {
    setReconType(entityType)
    setReconId(entityId)
    setReconData(null)
    setReconNonce((n) => n + 1)
    setTab('recon')
  }, [])

  const openCorrection = useCallback((rec: AuditRecordRow) => {
    setCorrectWhy('')
    setCorrectOutput(prettyJson(rec.outputJson))
    setCorrectResult(rec.result ?? '')
    setCorrectTarget(rec)
  }, [])

  const submitCorrection = useCallback(async () => {
    if (!correctTarget) return
    if (correctWhy.trim().length < 3) {
      toast.error('El motivo (why) de la corrección es obligatorio')
      return
    }
    let output: Record<string, unknown>
    try {
      output = JSON.parse(correctOutput || '{}') as Record<string, unknown>
    } catch {
      toast.error('El output no es JSON válido')
      return
    }
    try {
      const res = await command('audit.correct', {
        prevAuditId: correctTarget.id,
        action: correctTarget.action,
        entityType: correctTarget.entityType,
        entityId: correctTarget.entityId,
        why: correctWhy.trim(),
        output,
        ...(correctResult.trim() ? { result: correctResult.trim() } : {}),
      })
      if (res.ok) {
        toast.success('Corrección registrada como nuevo registro encadenado (prevAuditId)')
        setCorrectTarget(null)
        void loadReconstruction(correctTarget.entityType, correctTarget.entityId)
      } else {
        toast.error('El pipeline rechazó la corrección', { description: res.error ?? res.status })
      }
    } catch (err) {
      toast.error('Error ejecutando audit.correct', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    }
  }, [command, correctOutput, correctResult, correctTarget, correctWhy, loadReconstruction])

  // ---------- render ----------
  return (
    <div className="flex flex-col gap-4" aria-label="Eventos, auditoría y trazas">
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="flex-wrap bg-slate-900/80">
          <TabsTrigger value="events" className="text-xs sm:text-sm">Eventos en vivo</TabsTrigger>
          <TabsTrigger value="audit" className="text-xs sm:text-sm">Auditoría</TabsTrigger>
          <TabsTrigger value="recon" className="text-xs sm:text-sm">Reconstrucción</TabsTrigger>
          <TabsTrigger value="commands" className="text-xs sm:text-sm">Comandos</TabsTrigger>
        </TabsList>

        {/* ================= EVENTOS EN VIVO ================= */}
        <TabsContent value="events" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <ListFilter className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
              <Input
                value={eventQuery}
                onChange={(e) => setEventQuery(e.target.value)}
                placeholder="filtrar por tipo, sujeto o seq…"
                className="border-slate-800 bg-slate-900 pl-8 text-slate-200 placeholder:text-slate-600"
                aria-label="Filtrar eventos"
              />
            </div>
            <Select value={eventNs} onValueChange={setEventNs}>
              <SelectTrigger className="w-44 border-slate-800 bg-slate-900 text-slate-200" aria-label="Namespace de eventos">
                <SelectValue placeholder="namespace" />
              </SelectTrigger>
              <SelectContent className="border-slate-800 bg-slate-950">
                <SelectItem value="ALL">todos los namespaces</SelectItem>
                {namespaces.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    <span className="font-mono text-xs">{ns}.*</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="outline" className={`font-mono text-[10px] ${connected ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-slate-600/40 bg-slate-500/10 text-slate-400'}`}>
              {connected ? 'realtime conectado' : 'sin realtime (poll)'}
            </Badge>
          </div>

          {events.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin eventos recibidos todavía — el bus emitirá en cuanto haya actividad.
            </p>
          ) : filteredEvents.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Ningún evento coincide con el filtro actual.
            </p>
          ) : (
            <ScrollArea className="max-h-[480px] rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="flex flex-col divide-y divide-slate-800/70">
                {visibleEvents.map((e) => {
                  const ns = nsOf(e.event_type)
                  return (
                    <Collapsible key={e.seq} className="group/ev">
                      <div className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-800/30">
                        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-slate-600">{e.seq}</span>
                        <span className="w-16 shrink-0 font-mono text-[11px] text-slate-500">{shortTime(e.timestamp)}</span>
                        <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${NS_STYLE[ns] ?? NS_STYLE.system}`}>
                          {e.event_type}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400" title={e.subject}>
                          {e.subject}
                        </span>
                        {e.sim && (
                          <Badge variant="outline" className="shrink-0 border-amber-400/40 bg-amber-400/10 font-mono text-[9px] text-amber-300">
                            SIM
                          </Badge>
                        )}
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0 text-slate-500 hover:text-slate-200" aria-label={`Ver payload de ${e.event_type}`}>
                            <ChevronDown className="size-3.5 transition-transform group-data-[state=open]/ev:rotate-180" aria-hidden />
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                      <CollapsibleContent className="px-3 pb-3">
                        <pre className="max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-teal-200">
                          {prettyObj(e.payload)}
                        </pre>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            </ScrollArea>
          )}
          {hiddenEvents > 0 && (
            <p className="text-center text-[11px] text-slate-600">
              {hiddenEvents} eventos más antiguos ocultos (se muestran los 150 más recientes del filtro)
            </p>
          )}
        </TabsContent>

        {/* ================= AUDITORÍA ================= */}
        <TabsContent value="audit" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Registros inmutables WHO / WHAT / WHEN / WHY — las correcciones crean registros nuevos encadenados (spec §27).
            </p>
            <Button variant="outline" size="sm" onClick={() => { void loadAudit() }} disabled={auditLoading}>
              <RefreshCw className={`size-4 ${auditLoading ? 'animate-spin' : ''}`} aria-hidden />
              Actualizar
            </Button>
          </div>

          {auditLoading && auditRecords.length === 0 ? (
            <Skeleton className="h-64 rounded-lg bg-slate-800/60" />
          ) : auditRecords.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin registros de auditoría todavía.
            </p>
          ) : (
            <ScrollArea className="max-h-[520px] rounded-lg border border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">Cuándo</TableHead>
                    <TableHead className="text-slate-400">Actor</TableHead>
                    <TableHead className="text-slate-400">Acción</TableHead>
                    <TableHead className="text-slate-400">Entidad</TableHead>
                    <TableHead className="text-slate-400">Why</TableHead>
                    <TableHead className="text-slate-400">Resultado</TableHead>
                    <TableHead className="text-right text-slate-400">Costo</TableHead>
                    <TableHead className="text-slate-400">Reconstruir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditRecords.map((r) => (
                    <TableRow key={r.id} className="border-slate-800/70">
                      <TableCell className="whitespace-nowrap text-xs text-slate-400" title={r.createdAt}>
                        {timeAgo(r.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="outline" className={`w-fit text-[9px] ${ACTOR_STYLE[r.actorType] ?? 'border-slate-700 text-slate-400'}`}>
                            {r.actorType}
                          </Badge>
                          <span className="max-w-36 truncate font-mono text-[10px] text-slate-500" title={r.actorId}>{r.actorId}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-teal-300">{r.action}</span>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => { goToReconstruction(r.entityType, r.entityId) }}
                          className="max-w-44 truncate font-mono text-[11px] text-slate-300 underline decoration-slate-600 underline-offset-2 hover:text-emerald-300"
                          title={`${r.entityType}:${r.entityId} — reconstruir`}
                        >
                          {r.entityType}:{r.entityId}
                        </button>
                      </TableCell>
                      <TableCell className="max-w-48">
                        {r.why ? (
                          <p className="truncate text-xs text-slate-400" title={r.why}>{r.why}</p>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Badge variant="outline" className={`text-[9px] ${resultBadgeCls(r.result)}`}>
                            {r.result ?? '—'}
                          </Badge>
                          {r.sim && (
                            <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 font-mono text-[9px] text-amber-300">
                              SIM
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-slate-500">
                        {r.cost != null ? r.cost.toFixed(4) : '—'}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] text-slate-400 hover:text-emerald-300"
                          onClick={() => { goToReconstruction(r.entityType, r.entityId) }}
                          aria-label={`Reconstruir ${r.entityType}:${r.entityId}`}
                        >
                          <History className="size-3.5" aria-hidden />
                          Reconstruir
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </TabsContent>

        {/* ================= RECONSTRUCCIÓN ================= */}
        <TabsContent value="recon" className="flex flex-col gap-4">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardContent className="flex flex-col gap-3 p-4">
              <p className="text-xs text-slate-500">
                Toda operación del EEC es reconstruible a partir de su cola de auditoría + eventos (spec §28).
              </p>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  setReconData(null)
                  setReconNonce((n) => n + 1)
                }}
              >
                <div className="flex flex-col gap-1">
                  <Label htmlFor="recon-type" className="text-xs text-slate-400">entityType</Label>
                  <Input
                    id="recon-type"
                    value={reconType}
                    onChange={(e) => setReconType(e.target.value)}
                    placeholder="TASK · RUNTIME · APPROVAL…"
                    className="w-44 border-slate-800 bg-slate-950 font-mono text-xs text-slate-200"
                  />
                </div>
                <div className="flex min-w-52 flex-1 flex-col gap-1">
                  <Label htmlFor="recon-id" className="text-xs text-slate-400">entityId</Label>
                  <Input
                    id="recon-id"
                    value={reconId}
                    onChange={(e) => setReconId(e.target.value)}
                    placeholder="id de la entidad"
                    className="border-slate-800 bg-slate-950 font-mono text-xs text-slate-200"
                  />
                </div>
                <Button type="submit" size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" disabled={reconLoading || !reconType.trim() || !reconId.trim()}>
                  <GitBranch className="size-4" aria-hidden />
                  Reconstruir
                </Button>
              </form>
            </CardContent>
          </Card>

          {reconLoading ? (
            <Skeleton className="h-64 rounded-lg bg-slate-800/60" />
          ) : !reconData ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Ingresa entityType y entityId — o llega desde la pestaña Auditoría con el botón Reconstruir.
            </p>
          ) : reconData.auditTrail.length === 0 && reconData.eventTrail.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              No hay trazas de auditoría ni eventos para esa entidad.
            </p>
          ) : (
            <>
              {/* cola de auditoría — timeline vertical */}
              <section aria-label="Cola de auditoría de la entidad" className="flex flex-col gap-3">
                <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Auditoría <span className="font-mono">({reconData.auditTrail.length})</span> — orden cronológico
                </h4>
                {reconData.auditTrail.length === 0 ? (
                  <p className="text-sm text-slate-600">Sin registros de auditoría para esta entidad.</p>
                ) : (
                  <ol className="relative flex flex-col gap-3 border-l border-slate-800 pl-5">
                    {reconData.auditTrail.map((r) => (
                      <li key={r.id} className="relative">
                        <span className="absolute -left-[26px] top-3 size-2.5 rounded-full border-2 border-slate-950 bg-teal-400" aria-hidden />
                        <Card className="border-slate-800 bg-slate-900/50">
                          <CardContent className="flex flex-col gap-2 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className={`text-[9px] ${ACTOR_STYLE[r.actorType] ?? 'border-slate-700 text-slate-400'}`}>
                                {r.actorType}
                              </Badge>
                              <span className="font-mono text-[11px] text-slate-500" title={r.actorId}>{r.actorId}</span>
                              <span className="font-mono text-xs text-teal-300">{r.action}</span>
                              <Badge variant="outline" className={`text-[9px] ${resultBadgeCls(r.result)}`}>{r.result ?? '—'}</Badge>
                              {r.sim && (
                                <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 font-mono text-[9px] text-amber-300">SIM</Badge>
                              )}
                              {r.cost != null && (
                                <span className="font-mono text-[10px] text-slate-600">cost {r.cost.toFixed(4)}</span>
                              )}
                              <span className="ml-auto text-[11px] text-slate-500" title={r.createdAt}>{timeAgo(r.createdAt)}</span>
                            </div>

                            <p className="font-mono text-[10px] text-slate-600" title={`${r.entityType}:${r.entityId}`}>
                              {r.entityType}:{r.entityId}
                            </p>

                            {r.why && (
                              <p className="text-xs text-slate-300">
                                <span className="text-slate-500">why: </span>{r.why}
                              </p>
                            )}

                            {r.prevAuditId && (
                              <p className="flex items-center gap-1.5 rounded border border-orange-400/30 bg-orange-400/10 px-2 py-1 font-mono text-[10px] text-orange-300">
                                <PenLine className="size-3" aria-hidden />
                                corrección de {r.prevAuditId}
                              </p>
                            )}

                            <div className="flex flex-wrap gap-3">
                              {(['input', 'output', 'tools'] as const).map((key) => {
                                const raw = key === 'input' ? r.inputJson : key === 'output' ? r.outputJson : r.toolsJson
                                if (!raw || raw === '{}' || raw === '[]') return null
                                return (
                                  <Collapsible key={key} className="group/json">
                                    <CollapsibleTrigger className="flex items-center gap-1 font-mono text-[10px] uppercase text-slate-500 hover:text-slate-300">
                                      <ChevronDown className="size-3 transition-transform group-data-[state=open]/json:rotate-180" aria-hidden />
                                      {key}
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                      <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-teal-200">
                                        {prettyJson(raw)}
                                      </pre>
                                    </CollapsibleContent>
                                  </Collapsible>
                                )
                              })}
                            </div>

                            <div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1 border-amber-400/40 px-2 text-[11px] text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                                onClick={() => { openCorrection(r) }}
                              >
                                <PenLine className="size-3" aria-hidden />
                                Corregir registro
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <Separator className="bg-slate-800" />

              {/* cola de eventos de la entidad */}
              <section aria-label="Cola de eventos de la entidad" className="flex flex-col gap-3">
                <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Eventos <span className="font-mono">({reconData.eventTrail.length})</span> — orden por seq
                </h4>
                {reconData.eventTrail.length === 0 ? (
                  <p className="text-sm text-slate-600">Sin eventos asociados a esta entidad.</p>
                ) : (
                  <ScrollArea className="max-h-96 rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex flex-col divide-y divide-slate-800/70">
                      {reconData.eventTrail.map((ev) => {
                        const ns = nsOf(ev.type)
                        return (
                          <Collapsible key={ev.seq} className="group/trev">
                            <div className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-800/30">
                              <span className="w-14 shrink-0 text-right font-mono text-[11px] text-slate-600">#{ev.seq}</span>
                              <span className="w-16 shrink-0 font-mono text-[11px] text-slate-500">{shortTime(ev.createdAt)}</span>
                              <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${NS_STYLE[ns] ?? NS_STYLE.system}`}>
                                {ev.type}
                              </Badge>
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">{ev.subject}</span>
                              {ev.sim && (
                                <Badge variant="outline" className="shrink-0 border-amber-400/40 bg-amber-400/10 font-mono text-[9px] text-amber-300">SIM</Badge>
                              )}
                              <CollapsibleTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0 text-slate-500 hover:text-slate-200" aria-label={`Payload de evento ${ev.seq}`}>
                                  <ChevronDown className="size-3.5 transition-transform group-data-[state=open]/trev:rotate-180" aria-hidden />
                                </Button>
                              </CollapsibleTrigger>
                            </div>
                            <CollapsibleContent className="px-3 pb-2">
                              <pre className="max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-teal-200">
                                {prettyObj(ev.payload)}
                              </pre>
                            </CollapsibleContent>
                          </Collapsible>
                        )
                      })}
                    </div>
                  </ScrollArea>
                )}
              </section>
            </>
          )}
        </TabsContent>

        {/* ================= COMANDOS ================= */}
        <TabsContent value="commands" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Toda escritura de estado entra SOLO por el pipeline de comandos (spec §13) — bitácora de los últimos 60.
            </p>
            <Button variant="outline" size="sm" onClick={() => { void loadCommands() }} disabled={commandsLoading}>
              <ScrollText className="size-4" aria-hidden />
              Actualizar
            </Button>
          </div>

          {commandsLoading && commands.length === 0 ? (
            <Skeleton className="h-64 rounded-lg bg-slate-800/60" />
          ) : commands.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin comandos registrados todavía.
            </p>
          ) : (
            <ScrollArea className="max-h-[520px] rounded-lg border border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">Creado</TableHead>
                    <TableHead className="text-slate-400">Tipo</TableHead>
                    <TableHead className="text-slate-400">Estado</TableHead>
                    <TableHead className="text-slate-400">Solicitante</TableHead>
                    <TableHead className="text-slate-400">Riesgo</TableHead>
                    <TableHead className="text-slate-400">Motivo de rechazo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commands.map((c) => {
                    const st = COMMAND_STATUS_STYLE[c.status] ?? { label: c.status, cls: 'bg-slate-500/15 text-slate-400 border-slate-600/40' }
                    return (
                      <TableRow key={c.id} className="border-slate-800/70">
                        <TableCell className="whitespace-nowrap text-xs text-slate-400" title={c.createdAt}>
                          {timeAgo(c.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-teal-300">{c.type}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] ${st.cls}`}>{st.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] ${ACTOR_STYLE[c.requesterType] ?? 'border-slate-700 text-slate-400'}`}>
                            {c.requesterType}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`font-mono text-[9px] ${RISK_STYLE[c.risk] ?? 'border-slate-700 text-slate-400'}`}>
                            {c.risk}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-56">
                          {c.rejectionReason ? (
                            <p className="truncate text-xs text-rose-300/80" title={c.rejectionReason}>{c.rejectionReason}</p>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>

      {/* ---------- DIALOG CORREGIR REGISTRO DE AUDITORÍA ---------- */}
      <Dialog open={!!correctTarget} onOpenChange={(open) => { if (!open) setCorrectTarget(null) }}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-amber-300">Corregir registro de auditoría</DialogTitle>
            <DialogDescription className="text-slate-400">
              El registro original NO se muta: se crea un nuevo registro encadenado vía{' '}
              <span className="font-mono text-amber-200">prevAuditId</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 font-mono text-[11px] text-slate-400">
              {correctTarget?.action} · {correctTarget?.entityType}:{correctTarget?.entityId}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-why" className="text-slate-300">
                Motivo de la corrección (why) <span className="text-rose-400">*</span>
              </Label>
              <Textarea
                id="correct-why"
                value={correctWhy}
                onChange={(e) => setCorrectWhy(e.target.value)}
                placeholder="ej: el costo real de la invocación fue 0.02, se registró 0.2 por error de decimales"
                rows={2}
                className="border-slate-800 bg-slate-900 text-slate-200"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-output" className="text-slate-300">Output corregido (JSON)</Label>
              <Textarea
                id="correct-output"
                value={correctOutput}
                onChange={(e) => setCorrectOutput(e.target.value)}
                rows={5}
                className="border-slate-800 bg-slate-900 font-mono text-xs text-teal-200"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-result" className="text-slate-300">Resultado (opcional)</Label>
              <Input
                id="correct-result"
                value={correctResult}
                onChange={(e) => setCorrectResult(e.target.value)}
                placeholder="ej: CORRECTED"
                className="border-slate-800 bg-slate-900 font-mono text-xs text-slate-200"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCorrectTarget(null)}>Cancelar</Button>
            <Button
              className="bg-amber-400 text-amber-950 hover:bg-amber-300"
              disabled={correctWhy.trim().length < 3}
              onClick={() => { void submitCorrection() }}
            >
              Registrar corrección
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
