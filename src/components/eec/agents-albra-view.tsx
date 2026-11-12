'use client'

// ============================================================
// ALBRA — AGENTES GESTIONADOS (vista EEC)
// Muestra el estado REAL reportado por el INSTALADOR vía contrato
// ops. Permite instalar/iniciar/detener/reiniciar/desinstalar.
// NUNCA muestra éxito si el INSTALADOR no lo confirmó.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, PackageCheck, Play, RefreshCw, RotateCcw, Square, Trash2, Download, Activity } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface ManagedAgent {
  productId: string
  displayName: string
  latestVersion: string | null
  installable: boolean
  installed: boolean
  state: string | null
  health: string | null
  version: string | null
  evidence: Record<string, unknown> | null
  lastError: string | null
  available: boolean
}

interface ManagedOp {
  id: string
  productId: string
  operation: string
  accepted: boolean
  runId: string | null
  resultCode: string | null
  createdAt: string
}

interface AgentsPayload {
  bridge: { configured: boolean; status: string }
  agents: ManagedAgent[]
  recentOps: ManagedOp[]
  error?: { code: string; message: string }
}

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  DEGRADED: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  FAILED: 'bg-red-500/15 text-red-400 border-red-500/30',
  UNKNOWN: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
}

export default function AgentsAlbraView() {
  const [data, setData] = useState<AgentsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [runProgress, setRunProgress] = useState<{ runId: string; percent: number; label: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/managed/agents', { cache: 'no-store' })
      const json = (await res.json()) as AgentsPayload
      setData(json)
      if (json.error?.code) toast.error(`${json.error.code}: ${json.error.message}`)
    } catch (e) {
      toast.error(`No se pudo cargar el catálogo de agentes: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Progreso REAL del run activo (polling del proxy de runs del INSTALADOR).
  useEffect(() => {
    if (!runProgress?.runId) return
    let stopped = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/v1/managed/runs/${runProgress.runId}`, { cache: 'no-store' })
        if (res.ok) {
          const run = (await res.json()) as { status?: string; steps?: Array<{ label?: string; status?: string }> }
          if (stopped) return
          const steps = run.steps ?? []
          const done = steps.filter((s) => ['SUCCESS', 'WARNING', 'SKIPPED', 'FAILURE'].includes(s.status ?? '')).length
          const running = steps.some((s) => s.status === 'RUNNING')
          const percent = steps.length ? Math.min(99, Math.round(((done + (running ? 0.5 : 0)) / steps.length) * 100)) : 0
          const current = steps.find((s) => s.status === 'RUNNING')
          setRunProgress((p) => p ? { ...p, percent, label: current?.label ?? p.label } : p)
          if (run.status === 'SUCCESS' || run.status === 'FAILURE') {
            setRunProgress(null)
            if (run.status === 'SUCCESS') toast.success('Operación completada por el INSTALADOR')
            else toast.error('La operación falló en el INSTALADOR — revisa el detalle')
            void load()
            return
          }
        }
      } catch { /* reintenta en el siguiente tick */ }
      if (!stopped) setTimeout(tick, 900)
    }
    void tick()
    return () => { stopped = true }
  }, [runProgress?.runId, load])

  const op = async (productId: string, operation: string, body?: Record<string, unknown>) => {
    setBusy(`${productId}:${operation}`)
    try {
      const res = await fetch(`/api/v1/managed/agents/${productId}/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json() as { accepted?: boolean; runId?: string; error?: { code: string; message: string }; detail?: Record<string, unknown> }
      if (json.error) {
        toast.error(`${json.error.code}: ${json.error.message}`)
      } else if (json.accepted === false) {
        toast.error('El INSTALADOR rechazó la operación (accepted:false).')
      } else if (json.runId) {
        toast.success(`Operación aceptada — run ${json.runId.slice(0, 12)}…`)
        setRunProgress({ runId: json.runId, percent: 2, label: 'Iniciando…' })
      } else {
        toast.success('Operación ejecutada por el INSTALADOR')
      }
      if (operation !== 'install' || json.accepted) void load()
    } catch (e) {
      toast.error(`Error de red: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const uninstall = (a: ManagedAgent) => {
    const removeData = window.confirm(
      `¿Desinstalar ${a.displayName}?\n\n• Aceptar = retirar servicios CONSERVANDO los datos (SQLite/reportes/backups)\n• Los datos solo se eliminan si además confirmas la pérdida de datos en el siguiente paso.`,
    )
    if (!removeData) return
    const purge = window.confirm(
      '⚠️ ¿ELIMINAR TAMBIÉN LOS DATOS (volúmenes)?\n\nEsta acción NO se puede deshacer: borra la base SQLite, reportes y backups del agente.',
    )
    void op(a.productId, 'uninstall', { dataMode: purge ? 'DELETE' : 'KEEP', confirmDataLoss: purge })
  }

  return (
    <div className="space-y-4 p-4 md:p-6" aria-label="Agentes ALBRA gestionados">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agentes ALBRA</h2>
          <p className="text-sm text-muted-foreground">
            Despliegue y ciclo de vida delegados al INSTALADOR (contrato EEC · Bearer + nonce).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium',
              data?.bridge?.configured
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400',
            )}
          >
            {data?.bridge?.configured ? 'INSTALADOR conectado' : 'puente sin configurar'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Actualizar
          </Button>
        </div>
      </header>

      {runProgress && (
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 className="size-3.5 animate-spin text-amber-400" />
              {runProgress.label}
            </span>
            <span className="font-mono tabular-nums">{runProgress.percent}%</span>
          </div>
          <Progress value={runProgress.percent} aria-label="Progreso de la operación" />
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Consultando INSTALADOR…
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data?.agents ?? []).map((a) => (
            <li key={a.productId} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.displayName}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {a.productId} · v{a.installed ? a.version ?? '?' : a.latestVersion ?? '—'}
                  </p>
                </div>
                <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', HEALTH_TONE[a.health ?? 'UNKNOWN'])}>
                  {a.health ?? 'DESCONOCIDO'}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {a.state
                  ? <><Activity className="mr-1 inline size-3" />{a.state}</>
                  : 'sin estado real (no instalado o INSTALADOR sin respuesta)'}
              </p>
              {a.lastError && (
                <p className="mt-1 line-clamp-2 text-[11px] text-red-400">{a.lastError}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {!a.installed ? (
                  <Button size="sm" className="gap-1.5" onClick={() => void op(a.productId, 'install')} disabled={busy !== null}>
                    {busy === `${a.productId}:install` ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    Instalar
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void op(a.productId, 'start')} disabled={busy !== null}>
                      <Play className="size-3.5" /> Iniciar
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void op(a.productId, 'stop')} disabled={busy !== null}>
                      <Square className="size-3.5" /> Detener
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void op(a.productId, 'restart')} disabled={busy !== null}>
                      <RotateCcw className="size-3.5" /> Reiniciar
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void op(a.productId, 'backup')} disabled={busy !== null}>
                      <PackageCheck className="size-3.5" /> Backup
                    </Button>
                    <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => uninstall(a)} disabled={busy !== null}>
                      <Trash2 className="size-3.5" /> Desinstalar
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {(data?.recentOps ?? []).length > 0 && (
        <section className="rounded-lg border bg-card">
          <h3 className="border-b px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Últimas operaciones delegadas (registro real)
          </h3>
          <ul className="max-h-56 overflow-y-auto p-2">
            {data!.recentOps.map((o) => (
              <li key={o.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs">
                <span className={cn('size-1.5 rounded-full', o.accepted ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
                <span className="font-mono">{o.productId}</span>
                <span className="text-muted-foreground">{o.operation}</span>
                <span className={cn('ml-auto font-medium', o.accepted ? 'text-emerald-400' : 'text-red-400')}>
                  {o.resultCode ?? (o.accepted ? 'ACCEPTED' : 'REJECTED')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
