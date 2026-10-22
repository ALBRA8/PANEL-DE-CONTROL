'use client'

// ============================================================
// EEC — SISTEMA: PROVIDERS / TOOLS / POLÍTICAS / OBSERVABILIDAD
// (spec §43 · §17 · §23 · §30)
// Todo de SOLO LECTURA salvo: modo simulación (switch) y
// reintento de dead-letters. El EEC no permite tocar políticas
// desde la UI sin comando de alta responsabilidad.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Activity, Boxes, CircleDot, Gauge, HeartPulse, RefreshCw, RotateCcw, Star, Wrench,
} from 'lucide-react'

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEecStore } from '@/store/eec-store'
import { RISK_STYLE, timeAgo } from '@/lib/eec-client'

// ---------- tipos locales (forma de /api/eec/ops) ----------
interface ProviderRow {
  key: string
  type: string
  providerKey: string
  adapter: string
  status: string
  isDefault: boolean
}

interface ProviderDbRow {
  key: string
}

interface ToolRow {
  id: string
  code: string
  name: string
  capability: string
  provider: string
  risk: string
  status: string
  description: string | null
}

interface PolicyRow {
  id: string
  code: string
  name: string
  type: string
  effect: string
  actionJson: string
  conditionsJson: string
  priority: number
  enabled: boolean
}

interface MetricRow {
  id: string
  name: string
  value: number
  unit: string | null
  ts: string
  labelsJson: string
}

interface LogRow {
  id: string
  level: string
  message: string
  service: string
  traceId: string | null
  createdAt: string
}

interface DeadLetterRow {
  seq: number
  type: string
  status: string
  retryCount: number
  createdAt: string
}

interface InvocationRow {
  id: string
  toolCode: string
  status: string
  latencyMs: number | null
  cost: number | null
  error: string | null
  createdAt: string
}

interface OpsData {
  providers: ProviderRow[]
  providersDb: ProviderDbRow[]
  tools: ToolRow[]
  policies: PolicyRow[]
  metrics: MetricRow[]
  logs: LogRow[]
  deadLetters: DeadLetterRow[]
  invocations: InvocationRow[]
  simulationMode: boolean
  systemHealth: {
    agentsActive: number
    runsRunning: number
    tasksInProgress: number
    approvalsPending: number
  }
}

// ---------- paletas ----------
const PROVIDER_TYPE_STYLE: Record<string, string> = {
  AGENT: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  RUNTIME: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  ORCHESTRATION: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  TOOL: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  MODEL: 'bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30',
}

const EFFECT_STYLE: Record<string, string> = {
  ALLOW: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  DENY: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  REQUIRE_APPROVAL: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
}

const LOG_LEVEL_STYLE: Record<string, string> = {
  DEBUG: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  INFO: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  WARN: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  ERROR: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
}

const INVOCATION_STYLE: Record<string, string> = {
  SUCCEEDED: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  FAILED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  DENIED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  TIMEOUT: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SUPPRESSED_SIM: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  EXECUTING: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  REQUESTED: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  CHECKS_FAILED: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
}

function providerStatusDot(status: string): string {
  const s = status.toUpperCase()
  if (s === 'ACTIVE' || s === 'READY' || s === 'AVAILABLE') return 'bg-emerald-400'
  if (s === 'DEGRADED' || s === 'STARTING') return 'bg-amber-400'
  if (s === 'ERROR' || s === 'FAILED') return 'bg-rose-500'
  return 'bg-slate-500'
}

export default function OpsView() {
  const command = useEecStore((s) => s.command)

  const [data, setData] = useState<OpsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [simOn, setSimOn] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // confirmaciones destructivas: dirección pendiente del switch de simulación y reintento de dead-letters
  const [simConfirm, setSimConfirm] = useState<'on' | 'off' | null>(null)
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/ops', { cache: 'no-store' })
      if (!res.ok) throw new Error(`ops ${res.status}`)
      const json = (await res.json()) as OpsData
      setData(json)
      setSimOn(json.simulationMode)
    } catch (err) {
      toast.error('No se pudo cargar el estado del sistema', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 15000)
    return () => { clearInterval(t) }
  }, [load])

  // ---------- modo simulación (única mutación "de sistema" junto a dead-letters) ----------
  const toggleSimulation = useCallback(async (enabled: boolean) => {
    const prev = simOn
    setSimOn(enabled)
    try {
      const res = await command('system.simulation.toggle', { enabled })
      if (res.ok) {
        toast.success(enabled
          ? 'Modo simulación ACTIVADO — las tools externas quedan suprimidas y marcadas SIM'
          : 'Modo simulación DESACTIVADO — las tools externas vuelven a operar')
        void load()
      } else {
        setSimOn(prev)
        toast.error('El pipeline rechazó el cambio de simulación', { description: res.error ?? res.status })
      }
    } catch (err) {
      setSimOn(prev)
      toast.error('Error alternando el modo simulación', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    }
  }, [command, load, simOn])

  // ---------- reintento de dead-letters ----------
  const retryDeadLetters = useCallback(async () => {
    setRetrying(true)
    try {
      const res = await command('system.deadletter.retry', { limit: 50 })
      if (res.ok) {
        const retried = res.result && typeof res.result.retried === 'number' ? res.result.retried : null
        toast.success(retried != null
          ? `Reintentados ${retried} eventos de dead-letter`
          : 'Reintento de dead-letters ejecutado')
        void load()
      } else {
        toast.error('El pipeline rechazó el reintento', { description: res.error ?? res.status })
      }
    } catch (err) {
      toast.error('Error reintentando dead-letters', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setRetrying(false)
    }
  }, [command, load])

  // métricas: última lectura por nombre (la lista ya viene desc por ts)
  const latestMetrics = useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    return data.metrics.filter((m) => {
      if (seen.has(m.name)) return false
      seen.add(m.name)
      return true
    }).slice(0, 20)
  }, [data])

  const health = data?.systemHealth
  const healthStats: Array<{ label: string; value: number; cls: string }> = [
    { label: 'agentes activos', value: health?.agentsActive ?? 0, cls: 'text-emerald-300' },
    { label: 'runs corriendo', value: health?.runsRunning ?? 0, cls: 'text-teal-300' },
    { label: 'tareas en progreso', value: health?.tasksInProgress ?? 0, cls: 'text-violet-300' },
    { label: 'aprobaciones pendientes', value: health?.approvalsPending ?? 0, cls: 'text-amber-300' },
  ]

  return (
    <div className="flex flex-col gap-4" aria-label="Operación del sistema">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <Boxes className="size-5 text-teal-400" aria-hidden />
            Sistema
          </h2>
          <p className="text-sm text-slate-400">
            Providers, tools, políticas y observabilidad — de solo lectura salvo simulación y dead-letters.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Actualizar
        </Button>
      </header>

      {/* ---------- cards superiores ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="gap-1 p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-slate-100">
              <Activity className="size-4 text-amber-400" aria-hidden />
              Modo simulación
            </CardTitle>
            <CardDescription className="text-xs text-slate-500">
              Las tools externas quedan suprimidas y marcadas SIM.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 p-4 pt-0">
            <Badge variant="outline" className={`font-mono text-[10px] ${simOn ? 'border-amber-400/40 bg-amber-400/10 text-amber-300' : 'border-slate-600/40 bg-slate-500/10 text-slate-400'}`}>
              {simOn ? 'SIM ON' : 'SIM OFF'}
            </Badge>
            <Switch
              checked={simOn}
              onCheckedChange={(v) => { if (v !== simOn) setSimConfirm(v ? 'on' : 'off') }}
              aria-label="Alternar modo simulación"
              className="data-[state=checked]:bg-amber-400"
            />
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="gap-1 p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-slate-100">
              <HeartPulse className="size-4 text-emerald-400" aria-hidden />
              Salud
            </CardTitle>
            <CardDescription className="text-xs text-slate-500">
              Gauges operacionales recientes (30 min).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 p-4 pt-0">
            {healthStats.map((s) => (
              <div key={s.label} className="rounded-md border border-slate-800 bg-slate-950/60 px-2.5 py-1.5">
                <p className={`font-mono text-lg leading-tight ${s.cls}`}>{s.value}</p>
                <p className="text-[10px] text-slate-500">{s.label}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="gap-1 p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-slate-100">
              <RotateCcw className="size-4 text-rose-400" aria-hidden />
              Dead-letters
            </CardTitle>
            <CardDescription className="text-xs text-slate-500">
              Eventos que agotaron sus reintentos en el bus.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 p-4 pt-0">
            <p className={`font-mono text-2xl ${data && data.deadLetters.length > 0 ? 'text-rose-300' : 'text-slate-500'}`}>
              {data?.deadLetters.length ?? 0}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="border-amber-400/40 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
              disabled={!data || data.deadLetters.length === 0 || retrying}
              onClick={() => setRetryConfirmOpen(true)}
            >
              <RotateCcw className={`size-4 ${retrying ? 'animate-spin' : ''}`} aria-hidden />
              Reintentar
            </Button>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="providers" className="gap-4">
        <TabsList className="flex-wrap bg-slate-900/80">
          <TabsTrigger value="providers" className="text-xs sm:text-sm">Providers</TabsTrigger>
          <TabsTrigger value="tools" className="text-xs sm:text-sm">Tools</TabsTrigger>
          <TabsTrigger value="policies" className="text-xs sm:text-sm">Políticas</TabsTrigger>
          <TabsTrigger value="observability" className="text-xs sm:text-sm">Logs y métricas</TabsTrigger>
        </TabsList>

        {/* ================= PROVIDERS ================= */}
        <TabsContent value="providers" className="flex flex-col gap-3">
          <p className="text-xs text-slate-500">
            Los providers son reemplazables vía adapters — sin lock-in (spec §43 / §57).
            {data && <span className="ml-1 font-mono text-slate-600">[{data.providers.length} en registro · {data.providersDb.length} en DB]</span>}
          </p>

          {loading && !data ? (
            <Skeleton className="h-56 rounded-lg bg-slate-800/60" />
          ) : !data || data.providers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin providers registrados en el runtime.
            </p>
          ) : (
            <ScrollArea className="max-h-96 rounded-lg border border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">Key</TableHead>
                    <TableHead className="text-slate-400">Tipo</TableHead>
                    <TableHead className="text-slate-400">Adapter</TableHead>
                    <TableHead className="text-slate-400">Estado</TableHead>
                    <TableHead className="text-slate-400">Default</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.providers.map((p) => (
                    <TableRow key={p.key} className="border-slate-800/70">
                      <TableCell className="font-mono text-xs text-teal-300">{p.key}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[9px] ${PROVIDER_TYPE_STYLE[p.type] ?? 'border-slate-700 text-slate-400'}`}>
                          {p.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-slate-400">{p.adapter}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5 text-xs text-slate-300">
                          <CircleDot className={`size-3 ${providerStatusDot(p.status)}`} aria-hidden />
                          {p.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        {p.isDefault ? (
                          <span className="flex items-center gap-1 text-xs text-amber-300" title="provider por defecto">
                            <Star className="size-3.5 fill-amber-300 text-amber-300" aria-hidden />
                            default
                          </span>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </TabsContent>

        {/* ================= TOOLS ================= */}
        <TabsContent value="tools" className="flex flex-col gap-3">
          {loading && !data ? (
            <Skeleton className="h-56 rounded-lg bg-slate-800/60" />
          ) : !data || data.tools.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin tools registradas en el catálogo.
            </p>
          ) : (
            <>
              <ScrollArea className="max-h-80 rounded-lg border border-slate-800">
                <Table>
                  <TableHeader>
                    <TableRow className="border-slate-800 hover:bg-transparent">
                      <TableHead className="text-slate-400">Código</TableHead>
                      <TableHead className="text-slate-400">Nombre</TableHead>
                      <TableHead className="text-slate-400">Capability</TableHead>
                      <TableHead className="text-slate-400">Riesgo</TableHead>
                      <TableHead className="text-slate-400">Provider</TableHead>
                      <TableHead className="text-slate-400">Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tools.map((t) => (
                      <TableRow key={t.id} className="border-slate-800/70">
                        <TableCell className="font-mono text-xs text-teal-300">{t.code}</TableCell>
                        <TableCell className="text-xs text-slate-200">{t.name}</TableCell>
                        <TableCell className="font-mono text-[11px] text-slate-400">{t.capability}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`font-mono text-[9px] ${RISK_STYLE[t.risk] ?? 'border-slate-700 text-slate-400'}`}>
                            {t.risk}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-slate-500">{t.provider}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5 text-xs text-slate-300">
                            <CircleDot className={`size-3 ${t.status === 'AVAILABLE' ? 'bg-emerald-400 rounded-full text-emerald-400' : 'bg-slate-500 rounded-full text-slate-500'}`} aria-hidden />
                            {t.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>

              <Separator className="bg-slate-800" />

              <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
                <Wrench className="size-3.5" aria-hidden />
                Invocaciones recientes
              </h4>
              {data.invocations.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
                  Sin invocaciones de tools registradas todavía.
                </p>
              ) : (
                <ScrollArea className="max-h-64 rounded-lg border border-slate-800 bg-slate-900/40">
                  <div className="flex flex-col divide-y divide-slate-800/70">
                    {data.invocations.map((inv) => (
                      <div key={inv.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                        <span className="font-mono text-teal-300">{inv.toolCode}</span>
                        <Badge variant="outline" className={`text-[9px] ${INVOCATION_STYLE[inv.status] ?? 'border-slate-700 text-slate-400'}`}>
                          {inv.status}
                        </Badge>
                        {inv.latencyMs != null && (
                          <span className="font-mono text-[11px] text-slate-500">{inv.latencyMs} ms</span>
                        )}
                        {inv.cost != null && (
                          <span className="font-mono text-[11px] text-slate-600">cost {inv.cost.toFixed(4)}</span>
                        )}
                        {inv.error && (
                          <span className="max-w-64 truncate text-[11px] text-rose-300/80" title={inv.error}>{inv.error}</span>
                        )}
                        <span className="ml-auto text-[11px] text-slate-600">{timeAgo(inv.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </>
          )}
        </TabsContent>

        {/* ================= POLÍTICAS ================= */}
        <TabsContent value="policies" className="flex flex-col gap-3">
          <p className="text-xs text-slate-500">
            Las políticas no se editan desde la UI: solo vía comandos de alta responsabilidad —
            aquí son de lectura (spec §23).
          </p>

          {loading && !data ? (
            <Skeleton className="h-56 rounded-lg bg-slate-800/60" />
          ) : !data || data.policies.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin políticas cargadas en el motor.
            </p>
          ) : (
            <ScrollArea className="max-h-96 rounded-lg border border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">Código</TableHead>
                    <TableHead className="text-slate-400">Nombre</TableHead>
                    <TableHead className="text-slate-400">Tipo</TableHead>
                    <TableHead className="text-slate-400">Efecto</TableHead>
                    <TableHead className="text-slate-400">Acción</TableHead>
                    <TableHead className="text-right text-slate-400">Prioridad</TableHead>
                    <TableHead className="text-slate-400">Activa</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.policies.map((p) => (
                    <TableRow key={p.id} className="border-slate-800/70">
                      <TableCell className="font-mono text-xs text-teal-300">{p.code}</TableCell>
                      <TableCell className="max-w-44 text-xs text-slate-200">
                        <span className="block truncate" title={p.name}>{p.name}</span>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-slate-400">{p.type}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[9px] ${EFFECT_STYLE[p.effect] ?? 'border-slate-700 text-slate-400'}`}>
                          {p.effect}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-52">
                        <span className="block truncate font-mono text-[10px] text-slate-500" title={p.actionJson}>
                          {p.actionJson}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-slate-400">{p.priority}</TableCell>
                      <TableCell>
                        <Switch checked={p.enabled} disabled aria-label={`Política ${p.code} ${p.enabled ? 'activa' : 'inactiva'}`} className="pointer-events-none data-[state=checked]:bg-emerald-400" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </TabsContent>

        {/* ================= LOGS Y MÉTRICAS ================= */}
        <TabsContent value="observability" className="grid gap-4 lg:grid-cols-2">
          <section aria-label="Logs recientes" className="flex flex-col gap-2">
            <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              <Gauge className="size-3.5" aria-hidden />
              Logs recientes
            </h4>
            {loading && !data ? (
              <Skeleton className="h-72 rounded-lg bg-slate-800/60" />
            ) : !data || data.logs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
                Sin logs registrados todavía.
              </p>
            ) : (
              <ScrollArea className="max-h-96 rounded-lg border border-slate-800 bg-slate-900/40">
                <div className="flex flex-col divide-y divide-slate-800/70">
                  {data.logs.map((l) => (
                    <div key={l.id} className="flex flex-col gap-1 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={`font-mono text-[9px] ${LOG_LEVEL_STYLE[l.level] ?? 'border-slate-700 text-slate-400'}`}>
                          {l.level}
                        </Badge>
                        <span className="font-mono text-[10px] text-slate-500">{l.service}</span>
                        {l.traceId && (
                          <span className="font-mono text-[10px] text-slate-600" title={l.traceId}>
                            trace {l.traceId.slice(0, 12)}…
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-slate-600">{timeAgo(l.createdAt)}</span>
                      </div>
                      <p className="text-slate-300">{l.message}</p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </section>

          <section aria-label="Métricas recientes" className="flex flex-col gap-2">
            <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              <Gauge className="size-3.5" aria-hidden />
              Métricas (última lectura por nombre)
            </h4>
            {latestMetrics.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
                Sin métricas recientes (ventana de 30 min).
              </p>
            ) : (
              <ScrollArea className="max-h-96 rounded-lg border border-slate-800 bg-slate-900/40">
                <div className="flex flex-col divide-y divide-slate-800/70">
                  {latestMetrics.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="font-mono text-slate-300">{m.name}</span>
                      <span className="text-slate-600">=</span>
                      <span className="font-mono text-emerald-300">{m.value}</span>
                      {m.unit && <span className="text-[10px] text-slate-500">{m.unit}</span>}
                      <span className="ml-auto text-[10px] text-slate-600">{timeAgo(m.ts)}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </section>
        </TabsContent>
      </Tabs>

      {/* ---------- confirmación: alternar modo simulación (system.simulation.toggle) ---------- */}
      <AlertDialog open={simConfirm !== null} onOpenChange={(open) => { if (!open) setSimConfirm(null) }}>
        <AlertDialogContent className="border-slate-800 bg-slate-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-100">
              {simConfirm === 'off' ? 'Desactivar modo simulación' : 'Activar modo simulación'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              {simConfirm === 'off'
                ? 'Las herramientas volverán a ejecutarse contra proveedores reales (email, CRM…). Requiere aprobaciones según política.'
                : 'Las acciones externas se suprimirán y marcarán SIM.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            El cambio queda auditado en el pipeline (comando <span className="font-mono">system.simulation.toggle</span>, actor HUMAN).
          </p>
          <AlertDialogFooter aria-label="Confirmar o cancelar el cambio de simulación">
            <AlertDialogCancel className="h-11 border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800 hover:text-slate-100">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className={`h-11 ${simConfirm === 'off'
                ? 'bg-rose-600 text-white hover:bg-rose-500'
                : 'bg-amber-400 text-amber-950 hover:bg-amber-300'}`}
              onClick={() => {
                const enabled = simConfirm === 'on'
                setSimConfirm(null)
                void toggleSimulation(enabled)
              }}
            >
              {simConfirm === 'off' ? 'Pasar a ejecución real' : 'Activar simulación'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---------- confirmación: reintento de dead-letters (system.deadletter.retry) ---------- */}
      <AlertDialog open={retryConfirmOpen} onOpenChange={setRetryConfirmOpen}>
        <AlertDialogContent className="border-slate-800 bg-slate-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-100">Reintentar dead-letters</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              Se reencolarán hasta 50 eventos de la dead-letter queue. Los eventos reintentados vuelven al pipeline completo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="font-mono text-xs text-slate-500">
            En cola ahora: {data?.deadLetters.length ?? 0}
          </p>
          <AlertDialogFooter aria-label="Confirmar o cancelar el reintento">
            <AlertDialogCancel className="h-11 border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800 hover:text-slate-100">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-amber-400 text-amber-950 hover:bg-amber-300"
              onClick={() => {
                setRetryConfirmOpen(false)
                void retryDeadLetters()
              }}
            >
              Reintentar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
