'use client'

// ============================================================
// EEC — VISTA CRM (spec §32)
// Pipeline kanban por etapa + interacciones + detalle de cliente.
// La UI no inventa estado: lee /api/eec/crm y despacha comandos.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Building2, ChevronLeft, ChevronRight, Eye, Mail, MessageSquare, MoreHorizontal,
  Phone, Plus, RefreshCw, Users, Webhook,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { timeAgo, type CommandResult } from '@/lib/eec-client'
import { useEecStore } from '@/store/eec-store'
import { cn } from '@/lib/utils'

// ---------- catálogos ----------
const CRM_STAGES = ['PROSPECT', 'CONTACTED', 'QUALIFIED', 'OPPORTUNITY', 'NEGOTIATION', 'CLIENT', 'RETENTION'] as const
type CrmStage = (typeof CRM_STAGES)[number]

const OPP_STAGES = ['PROSPECT', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST'] as const
type OppStage = (typeof OPP_STAGES)[number]

const CHANNELS = ['EMAIL', 'CALL', 'MEETING', 'CHAT', 'WEBHOOK'] as const
type Channel = (typeof CHANNELS)[number]

const CHANNEL_ICON: Record<Channel, LucideIcon> = {
  EMAIL: Mail, CALL: Phone, MEETING: Users, CHAT: MessageSquare, WEBHOOK: Webhook,
}

const CHANNEL_CHIP: Record<Channel, string> = {
  EMAIL: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  CALL: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  MEETING: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  CHAT: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  WEBHOOK: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
}

const STAGE_ACCENT: Record<CrmStage, { chip: string; bar: string }> = {
  PROSPECT: { chip: 'bg-slate-500/15 text-slate-300 border-slate-500/30', bar: 'bg-slate-500/60' },
  CONTACTED: { chip: 'bg-teal-400/10 text-teal-300 border-teal-400/30', bar: 'bg-teal-400/60' },
  QUALIFIED: { chip: 'bg-violet-400/10 text-violet-300 border-violet-400/30', bar: 'bg-violet-400/60' },
  OPPORTUNITY: { chip: 'bg-amber-400/10 text-amber-300 border-amber-400/30', bar: 'bg-amber-400/60' },
  NEGOTIATION: { chip: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30', bar: 'bg-emerald-400/60' },
  CLIENT: { chip: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40', bar: 'bg-emerald-500/70' },
  RETENTION: { chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30', bar: 'bg-rose-500/60' },
}

const OPP_CHIP: Record<OppStage, string> = {
  PROSPECT: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  CONTACTED: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  QUALIFIED: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  NEGOTIATION: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  WON: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40',
  LOST: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
}

// ---------- tipos del API /api/eec/crm (modelos Prisma serializados) ----------
interface CrmOpportunity {
  id: string; name: string; stage: string; value: number; currency: string
  probability: number; expectedCloseAt: string | null
}
interface CrmContact { id: string; name: string; email: string | null; phone: string | null; role: string | null }
interface CrmClient {
  id: string; name: string; segment: string | null; stage: string
  contactName: string | null; contactEmail: string | null; notes: string | null
  healthScore: number | null; tagsJson: string
  opportunities: CrmOpportunity[]; contacts: CrmContact[]
}
interface CrmInteraction {
  id: string; channel: string; summary: string; occurredAt: string
  clientId: string | null; client?: { name: string } | null
}
interface CrmData { clients: CrmClient[]; interactions: CrmInteraction[] }

const fmtMoney = (v: number): string =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v)

function isCrmStage(s: string): s is CrmStage {
  return (CRM_STAGES as readonly string[]).includes(s)
}
function isOppStage(s: string): s is OppStage {
  return (OPP_STAGES as readonly string[]).includes(s)
}

export default function CrmView() {
  const command = useEecStore((s) => s.command)

  const [data, setData] = useState<CrmData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [newClientOpen, setNewClientOpen] = useState(false)
  const [newOppOpen, setNewOppOpen] = useState(false)
  const [logChannelFor, setLogChannelFor] = useState<string | null>(null) // clientId
  const [detailClientId, setDetailClientId] = useState<string | null>(null)

  // form: nuevo cliente
  const [cName, setCName] = useState(''); const [cSegment, setCSegment] = useState('')
  const [cContact, setCContact] = useState(''); const [cEmail, setCEmail] = useState(''); const [cNotes, setCNotes] = useState('')
  // form: nueva oportunidad
  const [oClientId, setOClientId] = useState(''); const [oName, setOName] = useState('')
  const [oValue, setOValue] = useState(''); const [oStage, setOStage] = useState<OppStage>('PROSPECT')
  // form: interacción
  const [iChannel, setIChannel] = useState<Channel>('EMAIL'); const [iSummary, setISummary] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/crm', { cache: 'no-store' })
      if (!res.ok) throw new Error(`crm ${res.status}`)
      const json = (await res.json()) as CrmData
      setData({ clients: json.clients ?? [], interactions: json.interactions ?? [] })
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'error de red')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Ejecuta un comando, notifica y refresca el fetch local del CRM. */
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

  const clients = data?.clients ?? []
  const interactions = data?.interactions ?? []

  const byStage = useMemo(() => {
    const map = new Map<string, CrmClient[]>()
    for (const st of CRM_STAGES) map.set(st, [])
    for (const c of clients) {
      const st = isCrmStage(c.stage) ? c.stage : 'PROSPECT'
      map.get(st)?.push(c)
    }
    return map
  }, [clients])

  const openValue = (c: CrmClient): number =>
    c.opportunities.filter(o => o.stage !== 'WON' && o.stage !== 'LOST').reduce((acc, o) => acc + (o.value ?? 0), 0)

  const detailClient = detailClientId ? clients.find(c => c.id === detailClientId) ?? null : null
  const detailInteractions = detailClient
    ? interactions.filter(i => i.clientId === detailClient.id)
    : []

  const submitNewClient = async () => {
    if (cName.trim().length < 2) { toast.error('El nombre del cliente requiere al menos 2 caracteres'); return }
    if (cEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cEmail.trim())) { toast.error('Email de contacto inválido'); return }
    const ok = await run('client.create', {
      name: cName.trim(),
      ...(cSegment.trim() ? { segment: cSegment.trim() } : {}),
      ...(cContact.trim() ? { contactName: cContact.trim() } : {}),
      ...(cEmail.trim() ? { contactEmail: cEmail.trim() } : {}),
      ...(cNotes.trim() ? { notes: cNotes.trim() } : {}),
      tags: [],
    }, `Cliente "${cName.trim()}" creado en PROSPECT`)
    if (ok) { setNewClientOpen(false); setCName(''); setCSegment(''); setCContact(''); setCEmail(''); setCNotes('') }
  }

  const submitNewOpp = async () => {
    if (!oClientId) { toast.error('Selecciona un cliente'); return }
    if (oName.trim().length < 2) { toast.error('El nombre de la oportunidad requiere al menos 2 caracteres'); return }
    const value = Number(oValue)
    if (!Number.isFinite(value) || value < 0) { toast.error('Valor numérico inválido'); return }
    const ok = await run('opportunity.create', {
      clientId: oClientId, name: oName.trim(), value, stage: oStage, currency: 'USD',
    }, `Oportunidad "${oName.trim()}" creada`)
    if (ok) { setNewOppOpen(false); setOClientId(''); setOName(''); setOValue(''); setOStage('PROSPECT') }
  }

  const submitInteraction = async () => {
    if (!logChannelFor) return
    if (iSummary.trim().length < 3) { toast.error('El resumen requiere al menos 3 caracteres'); return }
    const ok = await run('interaction.log', {
      clientId: logChannelFor, channel: iChannel, summary: iSummary.trim(),
    }, 'Interacción registrada')
    if (ok) { setLogChannelFor(null); setIChannel('EMAIL'); setISummary('') }
  }

  const moveStage = (client: CrmClient, stage: string) => {
    if (stage === client.stage) return
    void run('client.update_stage', { clientId: client.id, stage }, `${client.name}: etapa → ${stage}`)
  }

  const shiftStage = (client: CrmClient, dir: -1 | 1) => {
    const idx = CRM_STAGES.indexOf(isCrmStage(client.stage) ? client.stage : 'PROSPECT')
    const next = CRM_STAGES[Math.min(CRM_STAGES.length - 1, Math.max(0, idx + dir))]
    if (next === client.stage) return
    moveStage(client, next)
  }

  // ---------- estados de carga y error ----------
  if (loading && !data) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Cargando CRM">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-8 w-56" />
          <div className="flex gap-2"><Skeleton className="h-9 w-36" /><Skeleton className="h-9 w-40" /></div>
        </div>
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-[264px] shrink-0 space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (loadError && !data) {
    return (
      <Card className="border-rose-500/30 bg-slate-900/60">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-rose-300">No se pudo cargar el CRM: {loadError}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }}>
            <RefreshCw className="size-4" /> Reintentar
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* ---------- header ---------- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">CRM — Pipeline comercial</h2>
          <p className="text-xs text-slate-400">
            {clients.length} cliente{clients.length === 1 ? '' : 's'} · {interactions.length} interacciones recientes
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="border-slate-700 bg-slate-900/60 hover:bg-slate-800"
            onClick={() => setNewOppOpen(true)}>
            <Plus className="size-4" /> Nueva oportunidad
          </Button>
          <Button size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
            onClick={() => setNewClientOpen(true)}>
            <Plus className="size-4" /> Nuevo cliente
          </Button>
        </div>
      </div>

      {/* ---------- kanban pipeline ---------- */}
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-start gap-3">
          {CRM_STAGES.map((stage) => {
            const list = byStage.get(stage) ?? []
            const acc = STAGE_ACCENT[stage]
            return (
              <section key={stage} className="w-[264px] shrink-0 rounded-lg border border-slate-800 bg-slate-900/50">
                <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', acc.bar)} aria-hidden="true" />
                    <Badge variant="outline" className={cn('font-mono text-[10px]', acc.chip)}>{stage}</Badge>
                  </div>
                  <span className="font-mono text-xs text-slate-400">{list.length}</span>
                </header>
                <div className="max-h-[480px] space-y-2 overflow-y-auto p-2">
                  {list.length === 0 && (
                    <p className="px-1 py-6 text-center text-xs text-slate-500">Sin clientes en esta etapa</p>
                  )}
                  {list.map((c) => (
                    <article key={c.id} className="rounded-md border border-slate-800 bg-slate-950/70 p-3 transition-colors hover:border-slate-700">
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          className="min-w-0 text-left text-sm font-medium text-slate-100 hover:text-emerald-300"
                          onClick={() => setDetailClientId(c.id)}
                          title={`Ver detalle de ${c.name}`}
                        >
                          {c.name}
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-6 text-slate-500 hover:text-slate-200"
                                aria-label={`Etapa anterior de ${c.name}`}
                                onClick={() => shiftStage(c, -1)} disabled={c.stage === 'PROSPECT'}>
                                <ChevronLeft className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Etapa anterior</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-6 text-slate-500 hover:text-slate-200"
                                aria-label={`Etapa siguiente de ${c.name}`}
                                onClick={() => shiftStage(c, 1)} disabled={c.stage === 'RETENTION'}>
                                <ChevronRight className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Etapa siguiente</TooltipContent>
                          </Tooltip>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-6 text-slate-500 hover:text-slate-200"
                                aria-label={`Mover ${c.name} a etapa`}>
                                <MoreHorizontal className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="border-slate-800 bg-slate-900">
                              <DropdownMenuLabel className="text-xs text-slate-400">Mover a etapa</DropdownMenuLabel>
                              <DropdownMenuSeparator className="bg-slate-800" />
                              {CRM_STAGES.map((st) => (
                                <DropdownMenuItem key={st}
                                  className={cn('font-mono text-xs', st === c.stage && 'text-emerald-300')}
                                  onClick={() => moveStage(c, st)}>
                                  {st}{st === c.stage ? ' (actual)' : ''}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      {c.segment && <p className="mt-1 text-[11px] text-slate-400">{c.segment}</p>}
                      {(c.contactName || c.contactEmail) && (
                        <p className="mt-1 truncate text-[11px] text-slate-500">
                          {c.contactName}{c.contactName && c.contactEmail ? ' · ' : ''}{c.contactEmail}
                        </p>
                      )}

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-400">Pipeline abierto</span>
                        <span className="font-mono text-xs text-emerald-300">{fmtMoney(openValue(c))}</span>
                      </div>

                      {c.opportunities.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {c.opportunities.slice(0, 4).map((o) => (
                            <Badge key={o.id} variant="outline"
                              className={cn('max-w-full truncate text-[10px]', isOppStage(o.stage) ? OPP_CHIP[o.stage] : 'bg-slate-500/15 text-slate-300 border-slate-500/30')}>
                              {o.name} · {o.stage}
                            </Badge>
                          ))}
                          {c.opportunities.length > 4 && (
                            <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-700">
                              +{c.opportunities.length - 4}
                            </Badge>
                          )}
                        </div>
                      )}

                      <div className="mt-2 flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-teal-300 hover:bg-teal-400/10 hover:text-teal-200"
                          onClick={() => { setLogChannelFor(c.id); setIChannel('EMAIL'); setISummary('') }}>
                          <MessageSquare className="size-3" /> Registrar interacción
                        </Button>
                        <Button variant="ghost" size="icon" className="ml-auto size-6 text-slate-500 hover:text-slate-200"
                          aria-label={`Detalle de ${c.name}`} onClick={() => setDetailClientId(c.id)}>
                          <Eye className="size-3.5" />
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {/* ---------- interacciones recientes ---------- */}
      <Card className="border-slate-800 bg-slate-900/50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-slate-200">
            <Webhook className="size-4 text-teal-300" /> Interacciones recientes
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {interactions.length === 0 ? (
            <p className="px-6 pb-6 text-xs text-slate-500">Sin interacciones registradas todavía.</p>
          ) : (
            <ScrollArea className="max-h-56">
              <ul className="divide-y divide-slate-800/70 px-6">
                {interactions.map((i) => {
                  const Icon = CHANNEL_ICON[(i.channel as Channel)] ?? MessageSquare
                  return (
                    <li key={i.id} className="flex items-start gap-3 py-2.5">
                      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border', CHANNEL_CHIP[(i.channel as Channel)] ?? CHANNEL_CHIP.WEBHOOK)}>
                        <Icon className="size-3.5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-slate-200">{i.summary}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          {i.client?.name
                            ? (
                              <button type="button" className="font-mono text-teal-400 hover:text-teal-300"
                                onClick={() => setDetailClientId(i.clientId)}>
                                {i.client.name}
                              </button>
                            )
                            : <span className="font-mono">sin cliente</span>}
                          {' · '}hace {timeAgo(i.occurredAt).replace('hace ', '')}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn('shrink-0 font-mono text-[10px]', CHANNEL_CHIP[(i.channel as Channel)] ?? CHANNEL_CHIP.WEBHOOK)}>
                        {i.channel}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ---------- sheet: detalle de cliente ---------- */}
      <Sheet open={detailClientId !== null} onOpenChange={(open) => { if (!open) setDetailClientId(null) }}>
        <SheetContent side="right" className="w-full overflow-y-auto border-slate-800 bg-slate-950 sm:max-w-lg">
          {detailClient ? (
            <div className="space-y-5">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-slate-100">
                  <Building2 className="size-4 text-emerald-300" /> {detailClient.name}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('font-mono text-[10px]', STAGE_ACCENT[isCrmStage(detailClient.stage) ? detailClient.stage : 'PROSPECT'].chip)}>
                    {detailClient.stage}
                  </Badge>
                  {detailClient.segment && <span>{detailClient.segment}</span>}
                  {detailClient.healthScore !== null && (
                    <span className="font-mono">health {detailClient.healthScore}</span>
                  )}
                </SheetDescription>
              </SheetHeader>

              {/* contactos */}
              <section>
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <Users className="size-3.5" /> Contactos
                </h3>
                {detailClient.contacts.length === 0 && detailClient.contactName ? (
                  <p className="text-xs text-slate-300">{detailClient.contactName} · {detailClient.contactEmail ?? 'sin email'}</p>
                ) : detailClient.contacts.length === 0 ? (
                  <p className="text-xs text-slate-500">Sin contactos registrados.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detailClient.contacts.map((ct) => (
                      <li key={ct.id} className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2">
                        <p className="text-xs text-slate-200">{ct.name}{ct.role ? ` — ${ct.role}` : ''}</p>
                        <p className="font-mono text-[11px] text-slate-500">{ct.email ?? '—'}{ct.phone ? ` · ${ct.phone}` : ''}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <Separator className="bg-slate-800" />

              {/* oportunidades */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Oportunidades</h3>
                {detailClient.opportunities.length === 0 ? (
                  <p className="text-xs text-slate-500">Sin oportunidades registradas.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detailClient.opportunities.map((o) => (
                      <li key={o.id} className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-slate-200">{o.name}</p>
                          <p className="font-mono text-[11px] text-slate-500">
                            {fmtMoney(o.value)} · prob {o.probability}%
                            {o.expectedCloseAt ? ` · cierre ${new Date(o.expectedCloseAt).toLocaleDateString('es-CO')}` : ''}
                          </p>
                        </div>
                        <Badge variant="outline" className={cn('shrink-0 font-mono text-[10px]', isOppStage(o.stage) ? OPP_CHIP[o.stage] : 'bg-slate-500/15 text-slate-300 border-slate-500/30')}>
                          {o.stage}
                        </Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-6 text-slate-500 hover:text-slate-200"
                              aria-label={`Actualizar etapa de ${o.name}`}>
                              <MoreHorizontal className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="border-slate-800 bg-slate-900">
                            {OPP_STAGES.map((st) => (
                              <DropdownMenuItem key={st} className={cn('font-mono text-xs', st === o.stage && 'text-emerald-300')}
                                onClick={() => {
                                  if (st === o.stage) return
                                  void run('opportunity.update_stage', { opportunityId: o.id, stage: st }, `${o.name}: etapa → ${st}`)
                                }}>
                                {st}{st === o.stage ? ' (actual)' : ''}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <Separator className="bg-slate-800" />

              {/* interacciones del cliente */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Interacciones</h3>
                {detailInteractions.length === 0 ? (
                  <p className="text-xs text-slate-500">Sin interacciones para este cliente.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detailInteractions.map((i) => {
                      const Icon = CHANNEL_ICON[(i.channel as Channel)] ?? MessageSquare
                      return (
                        <li key={i.id} className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2">
                          <Icon className="mt-0.5 size-3.5 shrink-0 text-teal-300" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="text-xs text-slate-200">{i.summary}</p>
                            <p className="text-[11px] text-slate-500">{i.channel} · {timeAgo(i.occurredAt)}</p>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              <Separator className="bg-slate-800" />

              {/* notas */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Notas</h3>
                <p className="whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                  {detailClient.notes || '—'}
                </p>
              </section>
            </div>
          ) : (
            <SheetHeader>
              <SheetTitle className="text-slate-300">Cliente no encontrado</SheetTitle>
              <SheetDescription>Puede haber sido eliminado o el listado está desactualizado.</SheetDescription>
            </SheetHeader>
          )}
        </SheetContent>
      </Sheet>

      {/* ---------- dialog: nuevo cliente ---------- */}
      <Dialog open={newClientOpen} onOpenChange={setNewClientOpen}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Nuevo cliente</DialogTitle>
            <DialogDescription className="text-slate-400">
              Se creará en etapa PROSPECT vía <span className="font-mono">client.create</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="crm-c-name" className="text-xs text-slate-300">Nombre *</Label>
              <Input id="crm-c-name" value={cName} onChange={(e) => setCName(e.target.value)}
                placeholder="Industrias Andinas S.A." className="border-slate-800 bg-slate-900" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="crm-c-seg" className="text-xs text-slate-300">Segmento</Label>
                <Input id="crm-c-seg" value={cSegment} onChange={(e) => setCSegment(e.target.value)}
                  placeholder="Manufactura" className="border-slate-800 bg-slate-900" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="crm-c-contact" className="text-xs text-slate-300">Contacto</Label>
                <Input id="crm-c-contact" value={cContact} onChange={(e) => setCContact(e.target.value)}
                  placeholder="María Gómez" className="border-slate-800 bg-slate-900" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-c-email" className="text-xs text-slate-300">Email de contacto</Label>
              <Input id="crm-c-email" type="email" value={cEmail} onChange={(e) => setCEmail(e.target.value)}
                placeholder="maria@andinas.co" className="border-slate-800 bg-slate-900" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-c-notes" className="text-xs text-slate-300">Notas</Label>
              <Textarea id="crm-c-notes" value={cNotes} onChange={(e) => setCNotes(e.target.value)}
                rows={3} placeholder="Contexto comercial…" className="border-slate-800 bg-slate-900" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setNewClientOpen(false)}>Cancelar</Button>
            <Button className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => void submitNewClient()}>
              Crear cliente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- dialog: nueva oportunidad ---------- */}
      <Dialog open={newOppOpen} onOpenChange={setNewOppOpen}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Nueva oportunidad</DialogTitle>
            <DialogDescription className="text-slate-400">
              Vía <span className="font-mono">opportunity.create</span> — moneda USD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-300">Cliente *</Label>
              <Select value={oClientId} onValueChange={(v) => setOClientId(v)}>
                <SelectTrigger className="w-full border-slate-800 bg-slate-900">
                  <SelectValue placeholder="Selecciona cliente" />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900">
                  {clients.length === 0 && (
                    <SelectItem value="_none" disabled>Sin clientes disponibles</SelectItem>
                  )}
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-o-name" className="text-xs text-slate-300">Nombre *</Label>
              <Input id="crm-o-name" value={oName} onChange={(e) => setOName(e.target.value)}
                placeholder="Renovación anual de licencias" className="border-slate-800 bg-slate-900" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="crm-o-value" className="text-xs text-slate-300">Valor (USD) *</Label>
                <Input id="crm-o-value" type="number" min={0} step="100" value={oValue}
                  onChange={(e) => setOValue(e.target.value)} placeholder="25000"
                  className="border-slate-800 bg-slate-900 font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-300">Etapa</Label>
                <Select value={oStage} onValueChange={(v) => { if (isOppStage(v)) setOStage(v) }}>
                  <SelectTrigger className="w-full border-slate-800 bg-slate-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-900">
                    {OPP_STAGES.map((st) => (
                      <SelectItem key={st} value={st} className="font-mono text-xs">{st}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setNewOppOpen(false)}>Cancelar</Button>
            <Button className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => void submitNewOpp()}>
              Crear oportunidad
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- dialog: registrar interacción ---------- */}
      <Dialog open={logChannelFor !== null} onOpenChange={(open) => { if (!open) setLogChannelFor(null) }}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-100">Registrar interacción</DialogTitle>
            <DialogDescription className="text-slate-400">
              Cliente:{' '}
              <span className="font-mono text-teal-300">
                {clients.find(c => c.id === logChannelFor)?.name ?? '—'}
              </span>{' '}vía <span className="font-mono">interaction.log</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-300">Canal</Label>
              <Select value={iChannel} onValueChange={(v) => { if ((CHANNELS as readonly string[]).includes(v)) setIChannel(v as Channel) }}>
                <SelectTrigger className="w-full border-slate-800 bg-slate-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900">
                  {CHANNELS.map((ch) => {
                    const Icon = CHANNEL_ICON[ch]
                    return (
                      <SelectItem key={ch} value={ch}>
                        <span className="flex items-center gap-2"><Icon className="size-3.5" /> {ch}</span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-i-summary" className="text-xs text-slate-300">Resumen *</Label>
              <Textarea id="crm-i-summary" value={iSummary} onChange={(e) => setISummary(e.target.value)}
                rows={3} placeholder="Llamada de seguimiento:…"
                className="border-slate-800 bg-slate-900" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-slate-700" onClick={() => setLogChannelFor(null)}>Cancelar</Button>
            <Button className="bg-teal-500 text-teal-950 hover:bg-teal-400" onClick={() => void submitInteraction()}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
