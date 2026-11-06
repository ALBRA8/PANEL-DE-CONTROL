'use client'
// ============================================================
// EEC — PANEL DOCTOR DEL SISTEMA (P2-2 · matriz #26)
// Vista Sistema: verificaciones reales del estado vivo con veredicto
// por check y global. Solo lectura — el doctor nunca repara.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'

interface Check {
  id: string
  label: string
  status: 'OK' | 'WARN' | 'FAIL'
  detail: string
  ms: number
}
interface DoctorPayload {
  ok: boolean
  overall: 'OK' | 'WARN' | 'FAIL'
  checks: Check[]
  durationMs: number
  generatedAt: string
}

const STATUS_STYLE: Record<Check['status'], string> = {
  OK: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  WARN: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  FAIL: 'border-red-400/40 bg-red-400/10 text-red-300',
}

export function DoctorPanel() {
  const [data, setData] = useState<DoctorPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/eec/doctor', { cache: 'no-store' })
      const json = (await res.json()) as DoctorPayload
      if (!json.ok) throw new Error('payload no ok')
      setData(json)
      setError(null)
    } catch {
      setError('No se pudo ejecutar el doctor')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void run() }, [run])

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700/40 bg-slate-800/20 p-4" aria-label="Doctor del sistema">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">Doctor del sistema</h3>
          {data && (
            <Badge variant="outline" className={`font-mono text-[9px] ${STATUS_STYLE[data.overall]}`}>
              {data.overall}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data && <span className="font-mono text-[10px] text-slate-500">{data.checks.length} checks · {data.durationMs} ms</span>}
          <button
            onClick={() => void run()}
            disabled={busy}
            className="rounded border border-slate-600/50 bg-slate-700/30 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700/50 disabled:opacity-50"
            aria-label="Ejecutar doctor"
          >
            {busy ? 'verificando…' : 'Ejecutar verificaciones'}
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-300">{error}</div>}

      <div className="flex flex-col gap-1.5">
        {(data?.checks ?? []).map(c => (
          <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700/40 bg-slate-900/40 px-3 py-1.5">
            <Badge variant="outline" className={`font-mono text-[9px] ${STATUS_STYLE[c.status]}`}>{c.status}</Badge>
            <span className="text-xs text-slate-300">{c.label}</span>
            <span className="font-mono text-[10px] text-slate-500">{c.ms} ms</span>
            <span className="w-full text-[11px] text-slate-400">{c.detail}</span>
          </div>
        ))}
        {!data && !error && (
          <div className="rounded-md border border-slate-700/40 bg-slate-900/40 p-3 text-xs text-slate-400">Ejecutando verificaciones…</div>
        )}
      </div>
    </div>
  )
}
