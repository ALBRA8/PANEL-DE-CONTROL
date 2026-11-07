'use client'

// ============================================================
// EEC — PANEL OBSERVATORIO (línea principal V2 · spec §27)
// Sala de situación consolidada: doctor, cadena hash, órganos
// adversariales, eval harness, SLA, dead-letters y uso por org.
// Solo lectura; refresco manual + automático cada 30 s.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { Activity, Gauge, HeartPulse, RefreshCw, ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

interface ResolvedFlag {
  key: string
  value: boolean | number | string | null
  source: 'default' | 'override'
}

interface ObservatoryData {
  generatedAt: string
  simMode: boolean
  durationMs: number
  doctor: { overall: 'OK' | 'WARN' | 'FAIL'; checks: Array<{ id: string; label: string; status: 'OK' | 'WARN' | 'FAIL'; detail: string; ms: number }>; durationMs: number }
  chain: { ok: boolean; verified: number; checked: number; unsealedLegacy: number; brokenAt: Array<{ chainSeq: number; reason: string }> }
  adversarial: { blocked24h: number; review24h: number }
  evals: { pass24h: number; fail24h: number }
  approvalsPending: number
  sla: { overdue: number; critical: number; warning: number; onTrack: number }
  deadLetters: number
  eventsByType: Array<{ type: string; count: number }>
  orgs: Array<{ id: string; code: string; name: string; flags: Record<string, ResolvedFlag> }>
  usage: {
    rows: Array<{ orgCode: string; orgName: string; invocations: number; succeeded: number; failed: number; costTotal: number }>
    totals: { orgCode: string; invocations: number; succeeded: number; failed: number; costTotal: number }
  }
}

const STATUS_STYLE: Record<'OK' | 'WARN' | 'FAIL', string> = {
  OK: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  WARN: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  FAIL: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'fail' }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={`text-xl font-semibold tabular-nums ${tone === 'fail' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-emerald-600' : ''}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  )
}

export function ObservatoryPanel() {
  const [data, setData] = useState<ObservatoryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/eec/observatory', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json() as ObservatoryData)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-slate-500" aria-hidden />
            <CardTitle className="text-base">Observatorio</CardTitle>
            {data && (
              <Badge className={STATUS_STYLE[data.doctor.overall]}>
                {data.doctor.overall === 'OK' ? 'Salud OK' : data.doctor.overall === 'WARN' ? 'Con avisos' : 'En fallo'}
              </Badge>
            )}
            {data?.simMode && <Badge variant="outline">SIMULACIÓN</Badge>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refrescar observatorio">
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </Button>
        </div>
        <CardDescription>
          Sala de situación: todos los órganos de control leen de la BD viva (solo lectura, 30 s).
          {data ? ` Snapshot en ${data.durationMs} ms.` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            El observatorio no pudo leer el estado: {error}
          </div>
        )}
        {!data && !error && (
          <div className="grid gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}
          </div>
        )}
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Cadena hash verificada" tone={data.chain.ok ? 'ok' : 'fail'} value={`${data.chain.verified}/${data.chain.checked}`} />
              <Stat label="Adversarial: bloqueos 24 h" tone={data.adversarial.blocked24h > 0 ? 'warn' : undefined} value={data.adversarial.blocked24h} />
              <Stat label="Adversarial: segundas miradas 24 h" value={data.adversarial.review24h} />
              <Stat label="Eval 24 h: PASS / FAIL" tone={data.evals.fail24h > 0 ? 'warn' : 'ok'} value={`${data.evals.pass24h} / ${data.evals.fail24h}`} />
              <Stat label="Aprobaciones pendientes" value={data.approvalsPending} />
              <Stat label="SLA: vencidas / críticas" tone={data.sla.overdue + data.sla.critical > 0 ? 'fail' : 'ok'} value={`${data.sla.overdue} / ${data.sla.critical}`} />
              <Stat label="Dead-letters del bus" tone={data.deadLetters > 0 ? 'warn' : 'ok'} value={data.deadLetters} />
              <Stat label="Doctor: checks OK" tone={data.doctor.overall === 'FAIL' ? 'fail' : 'ok'} value={`${data.doctor.checks.filter(c => c.status === 'OK').length}/${data.doctor.checks.length}`} />
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <HeartPulse className="size-4 text-slate-500" aria-hidden /> Verificaciones del doctor
              </div>
              <div className="flex flex-wrap gap-2">
                {data.doctor.checks.map(c => (
                  <Badge key={c.id} className={STATUS_STYLE[c.status]} title={`${c.detail} (${c.ms} ms)`}>
                    {c.label}: {c.status}
                  </Badge>
                ))}
              </div>
            </div>

            {data.orgs.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <ShieldAlert className="size-4 text-slate-500" aria-hidden /> Organizaciones y flags con override
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.orgs.map(o => {
                    const overrides = Object.values(o.flags).filter(f => f.source === 'override')
                    return (
                      <Badge key={o.id} variant={overrides.length > 0 ? 'default' : 'outline'} title={overrides.map(f => f.key).join(', ') || 'sin overrides'}>
                        {o.code}: {overrides.length > 0 ? `${overrides.length} override(s)` : 'defaults'}
                      </Badge>
                    )
                  })}
                </div>
              </div>
            )}

            {data.usage.rows.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Activity className="size-4 text-slate-500" aria-hidden /> Uso y coste por organización (atribución ToolInvocation → Task → Project → Org)
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Organización</TableHead>
                      <TableHead className="text-right">Invocaciones</TableHead>
                      <TableHead className="text-right">OK / fallos</TableHead>
                      <TableHead className="text-right">Coste</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.usage.rows.map(r => (
                      <TableRow key={r.orgCode}>
                        <TableCell className="font-medium">{r.orgCode}<span className="ml-2 text-xs text-slate-500">{r.orgName}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{r.invocations}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.succeeded} / {r.failed}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.costTotal.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold">
                      <TableCell>TOTAL ({data.usage.totals.orgCode})</TableCell>
                      <TableCell className="text-right tabular-nums">{data.usage.totals.invocations}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.usage.totals.succeeded} / {data.usage.totals.failed}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.usage.totals.costTotal.toFixed(4)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="text-xs text-slate-500">
              Generado: {new Date(data.generatedAt).toLocaleString()} · Eventos 24 h (top): {data.eventsByType.map(e => `${e.type}×${e.count}`).join(' · ') || '—'}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
