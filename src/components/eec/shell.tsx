'use client'

// ============================================================
// EEC — SHELL PRINCIPAL (Task 7-a)
// Layout operacional 'ops room': sidebar colapsable + header fijo
// + contenido por vista (dynamic imports, ssr:false) + footer.
// La UI nunca inventa actividad: solo refleja el snapshot y eventos.
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import {
  LayoutDashboard,
  Bot,
  KanbanSquare,
  GitBranch,
  Stamp,
  Users,
  Calendar,
  Handshake,
  Globe,
  Brain,
  Radio,
  Settings,
  PanelLeft,
  Bell,
  Menu,
  Loader2,
  type LucideIcon,
} from 'lucide-react'

import { useEecStore, useEecBootstrap, type EecView } from '@/store/eec-store'
import { SEVERITY_STYLE, timeAgo, type EecRun } from '@/lib/eec-client'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Toaster } from '@/components/ui/sonner'

// ---------- Vistas (dynamic, ssr:false, con skeleton) ----------

const CentralScreen = dynamic(() => import('@/components/eec/central-screen'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const AgentInspector = dynamic(() => import('@/components/eec/agent-inspector'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const TaskBoard = dynamic(() => import('@/components/eec/task-board'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const ApprovalsView = dynamic(() => import('@/components/eec/approvals-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const MeetingsView = dynamic(() => import('@/components/eec/meetings-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const CalendarView = dynamic(() => import('@/components/eec/calendar-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const CrmView = dynamic(() => import('@/components/eec/crm-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const WorldView = dynamic(() => import('@/components/eec/world-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const MemoryView = dynamic(() => import('@/components/eec/memory-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const EventsAuditView = dynamic(() => import('@/components/eec/events-audit-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})
const OpsView = dynamic(() => import('@/components/eec/ops-view'), {
  ssr: false,
  loading: () => <ViewSkeleton />,
})

// ---------- Navegación ----------

interface NavItem {
  view: EecView
  label: string
  icon: LucideIcon
}

const NAV: NavItem[] = [
  { view: 'central', label: 'Central', icon: LayoutDashboard },
  { view: 'agents', label: 'Agentes', icon: Bot },
  { view: 'board', label: 'Tareas', icon: KanbanSquare },
  { view: 'workflows', label: 'Workflows', icon: GitBranch },
  { view: 'approvals', label: 'Aprobaciones', icon: Stamp },
  { view: 'meetings', label: 'Reuniones', icon: Users },
  { view: 'calendar', label: 'Calendario', icon: Calendar },
  { view: 'crm', label: 'CRM', icon: Handshake },
  { view: 'world', label: 'Mundo HQ', icon: Globe },
  { view: 'memory', label: 'Memoria', icon: Brain },
  { view: 'events', label: 'Eventos', icon: Radio },
  { view: 'ops', label: 'Sistema', icon: Settings },
]

// ---------- Utilidades locales ----------

const RUN_STATUS_CHIP: Record<string, string> = {
  PENDING: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  RUNNING: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  WAITING_APPROVAL: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  SUCCEEDED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
  CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
  TIMED_OUT: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
}

/** Scrollbars finos para el look 'ops room'. Se inyecta una sola vez desde el shell. */
const SCROLLBAR_CSS = `
.eec-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.eec-scroll::-webkit-scrollbar-track { background: transparent; }
.eec-scroll::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 8px; }
.eec-scroll::-webkit-scrollbar-thumb:hover { background: #334155; }
.eec-scroll { scrollbar-width: thin; scrollbar-color: #1e293b transparent; }
`

function ViewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-56 bg-slate-800" />
        <Skeleton className="h-7 w-24 bg-slate-800" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full bg-slate-800" />
        ))}
      </div>
    </div>
  )
}

function NavList({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const view = useEecStore((s) => s.view)
  const setView = useEecStore((s) => s.setView)
  const pendingApprovals = useEecStore((s) => s.snapshot?.health.approvalsPending ?? 0)

  return (
    <nav aria-label="Navegación EEC" className="eec-scroll flex flex-col gap-0.5 overflow-y-auto p-2">
      {NAV.map((item) => {
        const Icon = item.icon
        const active = view === item.view
        const showBadge = item.view === 'approvals' && pendingApprovals > 0
        return (
          <button
            key={item.view}
            type="button"
            onClick={() => {
              setView(item.view)
              onNavigate?.()
            }}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
            className={cn(
              'relative flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50',
              collapsed && 'justify-center px-0',
              active
                ? 'bg-emerald-400/10 text-emerald-200'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
            )}
          >
            <Icon className={cn('h-5 w-5 shrink-0', active && 'text-emerald-300')} />
            {!collapsed && <span className="truncate">{item.label}</span>}
            {showBadge &&
              (collapsed ? (
                <span
                  aria-label={`${pendingApprovals} aprobaciones pendientes`}
                  className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500"
                />
              ) : (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500/20 px-1.5 font-mono text-[10px] font-semibold text-rose-300">
                  {pendingApprovals}
                </span>
              ))}
          </button>
        )
      })}
    </nav>
  )
}

function Clock() {
  const [clock, setClock] = useState('')

  useEffect(() => {
    const fmt = () => new Date().toLocaleTimeString('es-CO', { hour12: false })
    const initial = setTimeout(() => setClock(fmt()), 0)
    const t = setInterval(() => setClock(fmt()), 1000)
    return () => {
      clearTimeout(initial)
      clearInterval(t)
    }
  }, [])

  return (
    <span className="hidden font-mono text-xs text-slate-400 sm:inline" suppressHydrationWarning>
      {clock || '--:--:--'}
    </span>
  )
}

function NotificationsBell() {
  const snapshot = useEecStore((s) => s.snapshot)
  const command = useEecStore((s) => s.command)
  const [markingId, setMarkingId] = useState<string | null>(null)

  const unread = useMemo(
    () => (snapshot?.notifications ?? []).filter((n) => !n.readAt),
    [snapshot],
  )

  async function markRead(notificationId: string) {
    setMarkingId(notificationId)
    try {
      const res = await command('notification.read', { notificationId })
      if (!res.ok) toast.error(res.error ?? 'No se pudo marcar la notificación')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fallo de red')
    } finally {
      setMarkingId(null)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-11 w-11 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          aria-label={`Notificaciones (${unread.length} sin leer)`}
        >
          <Bell className="h-5 w-5" />
          {unread.length > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 font-mono text-[9px] font-semibold text-white">
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 border-slate-800 bg-slate-900 p-0 text-slate-100"
      >
        <div className="border-b border-slate-800 px-4 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Notificaciones
          </p>
        </div>
        <div className="eec-scroll max-h-80 overflow-y-auto p-2">
          {unread.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-slate-500">
              Sin notificaciones sin leer.
            </p>
          ) : (
            unread.map((n) => (
              <div
                key={n.id}
                className="rounded-md border border-slate-800/70 bg-slate-950/60 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'font-mono text-[10px] uppercase tracking-wider',
                      SEVERITY_STYLE[n.severity] ?? 'text-slate-400',
                    )}
                  >
                    {n.severity}
                  </span>
                  <span className="font-mono text-[10px] text-slate-600">
                    {timeAgo(n.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium text-slate-200">{n.title}</p>
                {n.body && <p className="mt-0.5 text-xs text-slate-500">{n.body}</p>}
                <Button
                  variant="outline"
                  className="mt-2 h-11 w-full border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
                  disabled={markingId === n.id}
                  onClick={() => void markRead(n.id)}
                >
                  {markingId === n.id ? 'Marcando…' : 'Marcar leída'}
                </Button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Vista provisional de Workflows: solo runs reales del snapshot hasta integración completa. */
function WorkflowsLocal() {
  const snapshot = useEecStore((s) => s.snapshot)

  const groups = useMemo(() => {
    const runs = snapshot?.runs ?? []
    const m = new Map<string, EecRun[]>()
    for (const r of runs) {
      const key = r.workflow?.code ?? 'SIN-WORKFLOW'
      const arr = m.get(key) ?? []
      arr.push(r)
      m.set(key, arr)
    }
    return Array.from(m.entries())
  }, [snapshot])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-slate-100">Workflows</h1>
        <Badge
          variant="outline"
          className="border-slate-600/40 bg-slate-600/20 text-[10px] text-slate-400"
        >
          VISTA PROVISIONAL
        </Badge>
      </div>
      <p className="text-xs text-slate-500">
        Integración completa del módulo en curso: esta vista muestra únicamente los runs reales
        presentes en el snapshot. No se genera actividad simulada.
      </p>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
          Sin runs registrados todavía.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map(([wfCode, runs]) => (
            <div key={wfCode} className="rounded-lg border border-slate-800/80 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-sm text-violet-300">{wfCode}</p>
                <span className="font-mono text-[10px] text-slate-500">{runs.length} runs</span>
              </div>
              <div className="eec-scroll mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                {runs.map((run) => (
                  <div key={run.id} className="rounded-md border border-slate-800/60 bg-slate-950/50 p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-teal-300">
                        {run.task?.code ?? '—'}
                      </span>
                      {run.agent && (
                        <span className="font-mono text-[10px] text-slate-500">
                          {run.agent.code}
                        </span>
                      )}
                      <Badge
                        variant="outline"
                        className={cn(
                          'ml-auto font-mono text-[10px]',
                          RUN_STATUS_CHIP[run.status] ?? 'bg-slate-500/15 text-slate-300 border-slate-500/30',
                        )}
                      >
                        {run.status}
                      </Badge>
                    </div>
                    <Progress
                      value={run.progress}
                      className="mt-2 h-1.5 bg-slate-800 [&>div]:bg-emerald-400"
                      aria-label={`Progreso ${run.progress}%`}
                    />
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate font-mono text-slate-500">
                        {run.currentNode ?? 'nodo —'}
                      </span>
                      <span className="font-mono text-slate-500">{run.progress}%</span>
                    </div>
                    {run.error && (
                      <p className="mt-1 truncate text-[11px] text-rose-400" title={run.error}>
                        {run.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function renderView(view: EecView) {
  switch (view) {
    case 'central':
      return <CentralScreen />
    case 'agents':
      return <AgentInspector />
    case 'board':
      return <TaskBoard />
    case 'workflows':
      return <WorkflowsLocal />
    case 'approvals':
      return <ApprovalsView />
    case 'meetings':
      return <MeetingsView />
    case 'calendar':
      return <CalendarView />
    case 'crm':
      return <CrmView />
    case 'world':
      return <WorldView />
    case 'memory':
      return <MemoryView />
    case 'events':
      return <EventsAuditView />
    case 'ops':
      return <OpsView />
    default:
      return <CentralScreen />
  }
}

// ---------- Shell ----------

export default function EecShell() {
  useEecBootstrap()

  const snapshot = useEecStore((s) => s.snapshot)
  const loading = useEecStore((s) => s.loading)
  const connected = useEecStore((s) => s.connected)
  const view = useEecStore((s) => s.view)
  const lastError = useEecStore((s) => s.lastError)
  const refresh = useEecStore((s) => s.refresh)

  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  // Pantalla de carga estilo terminal (sin snapshot y cargando)
  if (loading && !snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <div className="w-full max-w-md space-y-2 font-mono text-sm" role="status">
          <p className="tracking-widest text-emerald-300">
            EEC // ENTERPRISE EXECUTION &amp; CONTROL
          </p>
          <p className="text-slate-400">[boot] inicializando control plane …</p>
          <p className="text-slate-500">[ws ] conectando canal realtime :3030</p>
          <p className="text-slate-500">[st ] esperando primer snapshot de EEC STATE</p>
          <p className="flex items-center gap-2 text-teal-300">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            cargando…
          </p>
        </div>
      </div>
    )
  }

  // Error de arranque sin datos: mensaje honesto + reintento
  if (!snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
        <div className="w-full max-w-md space-y-3 rounded-lg border border-rose-500/30 bg-rose-950/30 p-6">
          <p className="font-mono text-sm tracking-widest text-rose-300">EEC // SIN CONEXIÓN</p>
          <p className="text-sm text-slate-300">
            No se pudo obtener el estado inicial del control plane.
          </p>
          {lastError && <p className="font-mono text-xs text-rose-400">{lastError}</p>}
          <Button
            className="h-11 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            onClick={() => void refresh()}
          >
            Reintentar
          </Button>
        </div>
      </div>
    )
  }

  const simulationMode = snapshot.simulationMode

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />
      <Toaster theme="dark" position="bottom-right" richColors closeButton />

      {/* Sidebar desktop colapsable */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-slate-800/80 bg-slate-950 transition-[width] duration-200 md:flex',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        <div className={cn('flex h-14 items-center border-b border-slate-800/80', collapsed ? 'justify-center px-0' : 'px-4')}>
          <span
            className={cn(
              'font-mono font-bold tracking-[0.2em] text-emerald-400',
              collapsed && 'text-base',
            )}
          >
            EEC
          </span>
        </div>
        <NavList collapsed={collapsed} />
        <div className="mt-auto border-t border-slate-800/80 p-2">
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-11 w-11 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200', collapsed && 'mx-auto')}
            aria-label={collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <PanelLeft className={cn('h-5 w-5 transition-transform', collapsed && 'rotate-180')} />
          </Button>
        </div>
      </aside>

      {/* Columna principal: header fijo + contenido + footer pegado abajo */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-800/80 bg-slate-950/90 px-3 backdrop-blur md:px-4">
          {/* Menú móvil */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 md:hidden"
                aria-label="Abrir navegación"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-64 border-slate-800 bg-slate-950 p-0 text-slate-100"
            >
              <SheetHeader className="border-b border-slate-800/80 px-4 py-3 text-left">
                <SheetTitle className="font-mono font-bold tracking-[0.2em] text-emerald-400">
                  EEC
                </SheetTitle>
                <SheetDescription className="text-[10px] uppercase tracking-wider text-slate-500">
                  Enterprise Execution &amp; Control
                </SheetDescription>
              </SheetHeader>
              <NavList collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>

          {/* Logo */}
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-lg font-bold tracking-[0.2em] text-emerald-400">
              EEC
            </span>
            <span className="hidden truncate text-[10px] uppercase tracking-[0.18em] text-slate-500 lg:inline">
              Enterprise Execution &amp; Control
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
            {/* Modo simulación */}
            <Badge
              variant="outline"
              title={
                simulationMode
                  ? 'Las acciones externas están suprimidas'
                  : 'Acciones externas activas contra sistemas reales'
              }
              className={cn(
                'cursor-help border font-mono text-[10px]',
                simulationMode
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                  : 'border-rose-600/50 bg-rose-600/15 text-rose-300',
              )}
            >
              {simulationMode ? 'SIMULACIÓN' : 'PRODUCCIÓN'}
            </Badge>

            {/* Indicador realtime */}
            <span
              className="flex items-center gap-1.5 font-mono text-xs"
              title={connected ? 'Realtime conectado (socket.io)' : 'Sin realtime: respaldo por polling'}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  connected ? 'animate-pulse bg-emerald-400' : 'bg-slate-500',
                )}
                aria-hidden
              />
              <span className={connected ? 'text-emerald-300' : 'text-slate-400'}>
                {connected ? 'LIVE' : 'POLL'}
              </span>
            </span>

            <Clock />

            <Separator orientation="vertical" className="hidden h-6 bg-slate-800 sm:block" />

            <NotificationsBell />
          </div>
        </header>

        {lastError && (
          <div className="flex items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-950/40 px-4 py-2 font-mono text-xs text-rose-300">
            <span className="truncate">error de sincronización: {lastError}</span>
            <Button
              variant="outline"
              className="h-11 shrink-0 border-rose-500/40 px-3 text-xs text-rose-200 hover:bg-rose-950/60"
              onClick={() => void refresh()}
            >
              Reintentar
            </Button>
          </div>
        )}

        <main className="min-w-0 flex-1 p-4 md:p-6">{renderView(view)}</main>

        <footer className="mt-auto flex items-center justify-between gap-3 border-t border-slate-800/80 px-4 py-2.5 font-mono text-[10px] text-slate-600">
          <span>EEC v1.0 · fuente de verdad: EEC STATE · la UI no fabrica actividad</span>
          <span suppressHydrationWarning>snapshot {timeAgo(snapshot.generatedAt)}</span>
        </footer>
      </div>
    </div>
  )
}
