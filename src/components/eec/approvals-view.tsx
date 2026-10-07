'use client'

// ============================================================
// EEC — APROBACIONES (spec §24 · HUMAN OVERSIGHT)
// Control humano: aprobar / rechazar / cancelar solicitudes.
// La UI nunca decide sola: cada acción pasa por el pipeline de
// comandos y queda auditada. Rechazo exige nota obligatoria.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Clock, Info, PauseCircle, RefreshCw, ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useEecStore } from '@/store/eec-store'
import { RISK_STYLE, timeAgo, type EecApproval } from '@/lib/eec-client'

const DECISION_STYLE: Record<string, string> = {
  APPROVED: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  REJECTED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  EXPIRED: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  CANCELLED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
}

/** Countdown corto para expiresAt: "en 4m 12s" | "expirado". */
function countdown(iso: string | null, now: number): { label: string; urgent: boolean } {
  if (!iso) return { label: 'sin expiración', urgent: false }
  const diff = new Date(iso).getTime() - now
  if (diff <= 0) return { label: 'expirado', urgent: true }
  const s = Math.floor(diff / 1000)
  if (s < 60) return { label: `en ${s}s`, urgent: true }
  const m = Math.floor(s / 60)
  if (m < 60) return { label: `en ${m}m ${s % 60}s`, urgent: m < 5 }
  const h = Math.floor(m / 60)
  return { label: `en ${h}h ${m % 60}m`, urgent: false }
}

export default function ApprovalsView() {
  const command = useEecStore((s) => s.command)
  const refresh = useEecStore((s) => s.refresh)

  const [approvals, setApprovals] = useState<EecApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [now, setNow] = useState<number | null>(null)

  // diálogos de decisión
  const [approveTarget, setApproveTarget] = useState<EecApproval | null>(null)
  const [approveNote, setApproveNote] = useState('')
  const [rejectTarget, setRejectTarget] = useState<EecApproval | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/approvals', { cache: 'no-store' })
      if (!res.ok) throw new Error(`approvals ${res.status}`)
      const data = (await res.json()) as { approvals: EecApproval[] }
      setApprovals(Array.isArray(data.approvals) ? data.approvals : [])
    } catch (err) {
      toast.error('No se pudieron cargar las aprobaciones', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // carga inicial + auto-refresh 8s + ticker 1s para countdowns
  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 8000)
    const tick = setInterval(() => { setNow(Date.now()) }, 1000)
    setNow(Date.now())
    return () => { clearInterval(t); clearInterval(tick) }
  }, [load])

  const pending = useMemo(
    () => approvals.filter((a) => a.status === 'REQUESTED'),
    [approvals],
  )
  const history = useMemo(
    () => approvals.filter((a) => a.status !== 'REQUESTED'),
    [approvals],
  )

  const runDecision = useCallback(async (
    type: string,
    payload: Record<string, unknown>,
    successMsg: string,
  ) => {
    try {
      const res = await command(type, payload)
      if (res.ok) {
        toast.success(successMsg)
        void refresh()
      } else if (res.duplicate) {
        toast.info('Comando duplicado — ya fue procesado')
      } else {
        toast.error('El pipeline rechazó el comando', {
          description: res.error ?? res.status,
        })
      }
    } catch (err) {
      toast.error('Error ejecutando la decisión', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      void load()
    }
  }, [command, load, refresh])

  const confirmApprove = useCallback(async () => {
    if (!approveTarget) return
    setBusyId(approveTarget.id)
    setApproveTarget(null)
    await runDecision('approval.approve', {
      approvalId: approveTarget.id,
      ...(approveNote.trim() ? { note: approveNote.trim() } : {}),
    }, `Aprobado: ${approveTarget.title}`)
    setBusyId(null)
    setApproveNote('')
  }, [approveNote, approveTarget, runDecision])

  const confirmReject = useCallback(async () => {
    if (!rejectTarget) return
    if (rejectNote.trim().length < 3) {
      toast.error('La nota de rechazo es obligatoria (mínimo 3 caracteres)')
      return
    }
    setBusyId(rejectTarget.id)
    setRejectTarget(null)
    await runDecision('approval.reject', {
      approvalId: rejectTarget.id,
      note: rejectNote.trim(),
    }, `Rechazado: ${rejectTarget.title}`)
    setBusyId(null)
    setRejectNote('')
  }, [rejectNote, rejectTarget, runDecision])

  const cancelApproval = useCallback(async (a: EecApproval) => {
    setBusyId(a.id)
    await runDecision('approval.cancel', { approvalId: a.id }, `Cancelado: ${a.title}`)
    setBusyId(null)
  }, [runDecision])

  return (
    <div className="flex flex-col gap-6" aria-label="Aprobaciones humanas">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <ShieldAlert className="size-5 text-amber-400" aria-hidden />
            Control humano
          </h2>
          <p className="text-sm text-slate-400">
            Las acciones de riesgo HIGH / CRITICAL esperan decisión explícita antes de ejecutarse.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Actualizar
        </Button>
      </header>

      {/* ---------- PENDIENTES ---------- */}
      <section aria-label="Pendientes de aprobación" className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-slate-300">
          Pendientes <span className="font-mono text-slate-500">({pending.length})</span>
        </h3>

        {loading && approvals.length === 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-44 rounded-xl bg-slate-800/60" />
            <Skeleton className="h-44 rounded-xl bg-slate-800/60" />
          </div>
        ) : pending.length === 0 ? (
          <Card className="border-dashed border-slate-800 bg-slate-900/40">
            <CardContent className="flex items-center gap-3 p-6 text-sm text-slate-400">
              <CheckCircle2 className="size-5 text-emerald-400" aria-hidden />
              Nada pendiente de aprobación humana.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pending.map((a) => {
              const cd = countdown(a.expiresAt, now ?? Date.now())
              const isCommand = a.subjectType === 'COMMAND'
              return (
                <Card key={a.id} className="flex flex-col gap-3 border-slate-800 bg-slate-900/60">
                  <CardHeader className="gap-1.5 p-4 pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-slate-700 font-mono text-[10px] text-slate-400">
                        {a.requestType}
                      </Badge>
                      <Badge variant="outline" className={`font-mono text-[10px] ${RISK_STYLE[a.risk] ?? 'border-slate-700 text-slate-400'}`}>
                        riesgo {a.risk}
                      </Badge>
                      {cd.urgent && a.status === 'REQUESTED' && (
                        <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 text-[10px] text-amber-300">
                          <Clock className="size-3" aria-hidden />
                          {cd.label}
                        </Badge>
                      )}
                    </div>
                    <CardTitle className="text-sm leading-snug text-slate-100">{a.title}</CardTitle>
                    {a.description && (
                      <CardDescription className="line-clamp-3 text-xs text-slate-400">{a.description}</CardDescription>
                    )}
                  </CardHeader>

                  <CardContent className="flex flex-1 flex-col justify-between gap-3 p-4 pt-0">
                    <div className="flex flex-col gap-1.5 text-xs text-slate-400">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>solicitado <span className="text-slate-300">{timeAgo(a.createdAt)}</span></span>
                        <span>expira <span className={cd.urgent ? 'text-amber-300' : 'text-slate-300'}>{cd.label}</span></span>
                      </div>
                      {a.subjectType && (
                        <p className="truncate font-mono text-[11px] text-slate-500" title={`${a.subjectType}:${a.subjectId ?? ''}`}>
                          sujeto {a.subjectType}:{a.subjectId ?? '—'}
                        </p>
                      )}
                      {isCommand && (
                        <p className="flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-[11px] text-violet-300">
                          <PauseCircle className="size-3.5 shrink-0" aria-hidden />
                          Al aprobar se reanudará el comando pausado
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                        disabled={busyId === a.id}
                        onClick={() => { setApproveNote(''); setApproveTarget(a) }}
                      >
                        Aprobar
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                        disabled={busyId === a.id}
                        onClick={() => { setRejectNote(''); setRejectTarget(a) }}
                      >
                        Rechazar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-400 hover:text-slate-200"
                        disabled={busyId === a.id}
                        onClick={() => { void cancelApproval(a) }}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <Separator className="bg-slate-800" />

      {/* ---------- HISTORIAL ---------- */}
      <section aria-label="Historial de decisiones" className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-slate-300">
          Historial <span className="font-mono text-slate-500">({history.length})</span>
        </h3>

        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 p-4 text-sm text-slate-500">
            Sin decisiones registradas todavía.
          </p>
        ) : (
          <ScrollArea className="max-h-96 rounded-lg border border-slate-800">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-400">Estado</TableHead>
                  <TableHead className="text-slate-400">Solicitud</TableHead>
                  <TableHead className="text-slate-400">Riesgo</TableHead>
                  <TableHead className="text-slate-400">Decidido</TableHead>
                  <TableHead className="text-slate-400">Nota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((a) => (
                  <TableRow key={a.id} className="border-slate-800/70">
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${DECISION_STYLE[a.status] ?? 'border-slate-700 text-slate-400'}`}>
                        {a.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <p className="truncate text-slate-200" title={a.title}>{a.title}</p>
                      <p className="font-mono text-[10px] text-slate-500">{a.requestType}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-mono text-[10px] ${RISK_STYLE[a.risk] ?? 'border-slate-700 text-slate-400'}`}>
                        {a.risk}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-slate-400">
                      {a.decidedAt ? timeAgo(a.decidedAt) : '—'}
                    </TableCell>
                    <TableCell className="max-w-72">
                      {a.decisionNote ? (
                        <p className="truncate text-xs text-slate-400" title={a.decisionNote}>{a.decisionNote}</p>
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
      </section>

      {/* ---------- DIALOG APROBAR (nota opcional) ---------- */}
      <Dialog open={!!approveTarget} onOpenChange={(open) => { if (!open) setApproveTarget(null) }}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-emerald-300">Aprobar solicitud</DialogTitle>
            <DialogDescription className="text-slate-400">
              {approveTarget?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {approveTarget?.subjectType === 'COMMAND' && (
              <p className="flex items-start gap-2 rounded-md border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-violet-300">
                <PauseCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Al aprobar se reanudará el comando pausado.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="approve-note" className="text-slate-300">Nota de decisión (opcional)</Label>
              <Input
                id="approve-note"
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                placeholder="ej: revisado por comité de riesgo"
                className="border-slate-800 bg-slate-900 text-slate-200"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveTarget(null)}>Cancelar</Button>
            <Button
              className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              onClick={() => { void confirmApprove() }}
            >
              Confirmar aprobación
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- DIALOG RECHAZAR (nota OBLIGATORIA) ---------- */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-rose-300">Rechazar solicitud</DialogTitle>
            <DialogDescription className="text-slate-400">
              {rejectTarget?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              La nota de rechazo es obligatoria y quedará registrada en la auditoría.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reject-note" className="text-slate-300">
                Motivo del rechazo <span className="text-rose-400">*</span>
              </Label>
              <Textarea
                id="reject-note"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="ej: el destinatario del email no está verificado en el CRM"
                rows={3}
                className="border-slate-800 bg-slate-900 text-slate-200"
              />
              {rejectNote.trim().length > 0 && rejectNote.trim().length < 3 && (
                <p className="text-[11px] text-rose-400">Mínimo 3 caracteres.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>Cancelar</Button>
            <Button
              variant="outline"
              className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
              disabled={rejectNote.trim().length < 3}
              onClick={() => { void confirmReject() }}
            >
              Confirmar rechazo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
