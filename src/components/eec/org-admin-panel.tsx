'use client'
// ============================================================
// EEC — PANEL DE ADMINISTRACIÓN POR ORGANIZACIÓN (P2-4)
// Vista Sistema: organizaciones del ecosistema con sus feature flags
// resueltos (override vs default) y el coste/usage atribuido (#22).
// Solo lectura: las mutaciones van por la paleta de comandos
// (org.create / org.flag.set / org.flag.unset) y quedan auditadas.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'

interface ResolvedFlag {
  key: string
  value: boolean | number | string | null
  source: 'default' | 'override'
  reason?: string
  setBy?: string
}
interface OrgRow {
  id: string
  code: string
  name: string
  mission?: string | null
  flags: Record<string, ResolvedFlag>
}
interface UsageRow {
  orgCode: string
  orgName: string
  invocations: number
  succeeded: number
  failed: number
  costTotal: number
}
interface OrgsPayload {
  ok: boolean
  catalog: Array<{ key: string; description: string; defaultValue: unknown }>
  organizations: OrgRow[]
  usage: UsageRow[]
  usageTotals: UsageRow
}

const fmtCost = (n: number) => (n === 0 ? '0' : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))

export function OrgAdminPanel() {
  const [data, setData] = useState<OrgsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/orgs', { cache: 'no-store' })
      const json = (await res.json()) as OrgsPayload
      if (!json.ok) throw new Error('payload no ok')
      setData(json)
      setError(null)
    } catch {
      setError('No se pudo cargar la administración por organización')
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300" aria-label="Error administración orgs">
        {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-slate-700/40 bg-slate-800/20 p-3 text-xs text-slate-400" aria-label="Cargando administración orgs">
        Cargando administración por organización…
      </div>
    )
  }

  const usageByOrg = new Map(data.usage.map(u => [u.orgCode, u]))

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700/40 bg-slate-800/20 p-4" aria-label="Administración por organización">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Administración por organización</h3>
        <Badge variant="outline" className="font-mono text-[9px] border-slate-600/40 bg-slate-500/10 text-slate-400">
          P2-4 · flags #21 + usage #22
        </Badge>
      </div>
      <p className="text-[11px] text-slate-400">
        Delegación de capacidades por organización (overrides auditados) y presupuesto de invocaciones atribuido
        vía tarea → proyecto. Mutaciones solo por comandos <code className="font-mono text-[10px] text-slate-300">org.*</code> (cadena hash).
      </p>

      <div className="flex flex-col gap-2">
        {data.organizations.map(org => {
          const overrides = Object.values(org.flags).filter(f => f.source === 'override')
          const usage = usageByOrg.get(org.code)
          return (
            <div key={org.id} className="rounded-md border border-slate-700/40 bg-slate-900/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-slate-200">{org.code}</span>
                <span className="text-xs text-slate-300">{org.name}</span>
                <Badge variant="outline" className="text-[9px] border-slate-600/40 bg-slate-500/10 text-slate-400">
                  {overrides.length} override{overrides.length === 1 ? '' : 's'}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {overrides.length === 0 && (
                  <span className="text-[10px] italic text-slate-500">sin delegaciones propias — opera con defaults globales</span>
                )}
                {overrides.map(f => (
                  <Badge
                    key={f.key}
                    variant="outline"
                    className="font-mono text-[9px] border-amber-400/40 bg-amber-400/10 text-amber-300"
                    title={f.reason ? `${f.reason} (por ${f.setBy})` : `por ${f.setBy}`}
                  >
                    {f.key}={String(f.value)}
                  </Badge>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-slate-400">
                <span>invocaciones: <span className="text-slate-200">{usage?.invocations ?? 0}</span></span>
                <span>ok: <span className="text-emerald-300">{usage?.succeeded ?? 0}</span></span>
                <span>fallo: <span className="text-red-300">{usage?.failed ?? 0}</span></span>
                <span>coste: <span className="text-slate-200">{fmtCost(usage?.costTotal ?? 0)}</span></span>
              </div>
            </div>
          )
        })}

        <div className="rounded-md border border-slate-700/40 bg-slate-900/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-200">{data.usageTotals.orgCode}</span>
            <span className="text-xs text-slate-300">{data.usageTotals.orgName}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-slate-400">
            <span>invocaciones: <span className="text-slate-200">{data.usageTotals.invocations}</span></span>
            <span>coste: <span className="text-slate-200">{fmtCost(data.usageTotals.costTotal)}</span></span>
          </div>
          <p className="mt-1 text-[10px] italic text-slate-500">
            CENTRAL = invocaciones sin tarea/proyecto (presupuesto de la sede, visible y no oculto).
          </p>
        </div>
      </div>
    </div>
  )
}
