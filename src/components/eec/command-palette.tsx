'use client'

// ============================================================
// EEC — COMMAND PALETTE (Task 1-b)
// Paleta de comandos ⌘K / Ctrl+K: navegación por las 12 vistas,
// salto directo a agentes del snapshot y acciones reales del
// store (refresh, tema). La UI no fabrica actividad: la palette
// solo ejecuta setView / selectAgent / refresh / setTheme.
// Extra: atajos globales Alt+1..9 → primeras 9 vistas (guard de
// inputs). Los toggles operacionales (simulación, agentes)
// quedan fuera a propósito: viven en sus vistas con confirmación.
// ============================================================

import { useEffect } from 'react'
import { create } from 'zustand'
import { useTheme } from 'next-themes'
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
  RefreshCw,
  Sun,
  Moon,
  Check,
  type LucideIcon,
} from 'lucide-react'

import { useEecStore, type EecView } from '@/store/eec-store'
import { AGENT_STATE_STYLE, type EecAgent } from '@/lib/eec-client'
import { cn } from '@/lib/utils'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'

// ---------- Mini-API propia de la palette (zustand local) ----------

interface CommandPaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

/** Estado mínimo para abrir/cerrar la palette desde el shell (botón del header). */
export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

// ---------- Vistas (espejo exacto de la sidebar del shell) ----------

interface PaletteView {
  view: EecView
  label: string
  icon: LucideIcon
}

const PALETTE_VIEWS: PaletteView[] = [
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

/** Primeras 9 vistas para los atajos Alt+1 … Alt+9. */
const ALT_VIEWS: EecView[] = PALETTE_VIEWS.slice(0, 9).map((v) => v.view)

const EMPTY_AGENTS: EecAgent[] = []

const STATE_CHIP_FALLBACK = 'bg-slate-500/15 text-slate-400 border-slate-500/30'

// ---------- Guarda: ignorar atajos cuando el foco está en un campo editable ----------

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

// ---------- Componente ----------

export default function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open)
  const setOpen = useCommandPaletteStore((s) => s.setOpen)

  const view = useEecStore((s) => s.view)
  const setView = useEecStore((s) => s.setView)
  const selectAgent = useEecStore((s) => s.selectAgent)
  const refresh = useEecStore((s) => s.refresh)
  const snapshotAgents = useEecStore((s) => s.snapshot?.agents)
  const agents = snapshotAgents ?? EMPTY_AGENTS

  const { theme, setTheme } = useTheme()
  const isDark = theme === 'dark'

  // Atajos globales (un solo listener):
  //  · ⌘K / Ctrl+K → abrir/cerrar la palette (ignora inputs editables)
  //  · Alt+1..9    → saltar a las primeras 9 vistas (ignora inputs editables)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return

      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const { open: current, setOpen: set } = useCommandPaletteStore.getState()
        set(!current)
        return
      }

      if (e.altKey && !e.metaKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const targetView = ALT_VIEWS[Number(e.key) - 1]
        if (!targetView) return
        e.preventDefault()
        useEecStore.getState().setView(targetView)
        useCommandPaletteStore.getState().setOpen(false)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Paleta de comandos"
      description="Busca vistas, agentes y acciones del EEC. La palette solo ejecuta acciones reales."
      showCloseButton={false}
      className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-xl"
    >
      <CommandInput
        placeholder="Buscar vistas, agentes, acciones…"
        aria-label="Buscar en la paleta de comandos"
      />
      <CommandList className="eec-scroll max-h-[min(60vh,420px)]">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        {/* Navegación: las 12 vistas del shell, la activa marcada con check */}
        <CommandGroup heading="Navegación">
          {PALETTE_VIEWS.map((item, idx) => {
            const Icon = item.icon
            const active = view === item.view
            const altNumber = idx < ALT_VIEWS.length ? idx + 1 : null
            return (
              <CommandItem
                key={item.view}
                value={`vista ${item.label} ${item.view}`}
                onSelect={() => {
                  setView(item.view)
                  setOpen(false)
                }}
                className="gap-3 data-[selected=true]:bg-emerald-400/10 data-[selected=true]:text-emerald-100"
              >
                <Icon
                  className={cn('h-4 w-4 shrink-0', active ? 'text-emerald-300' : 'text-slate-500')}
                  aria-hidden
                />
                <span className={cn('min-w-0 flex-1 truncate', active && 'text-emerald-200')}>
                  {item.label}
                </span>
                {active && (
                  <>
                    <Check className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                    <span className="sr-only">vista actual</span>
                  </>
                )}
                {altNumber !== null && !active && (
                  <CommandShortcut className="font-mono text-[10px] text-slate-500">
                    Alt+{altNumber}
                  </CommandShortcut>
                )}
              </CommandItem>
            )
          })}
        </CommandGroup>

        {/* Agentes reales del snapshot (OFFLINE incluido, sin fabricar) */}
        {agents.length > 0 && (
          <CommandGroup heading="Agentes">
            {agents.map((a) => {
              const st = AGENT_STATE_STYLE[a.state]
              return (
                <CommandItem
                  key={a.id}
                  value={`agente ${a.code} ${a.name} ${a.state} ${a.activity ?? ''}`}
                  onSelect={() => {
                    selectAgent(a.id)
                    setOpen(false)
                  }}
                  className="gap-2 data-[selected=true]:bg-emerald-400/10 data-[selected=true]:text-emerald-100"
                >
                  <Bot className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                  <span className="font-mono text-xs text-teal-300">{a.code}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded border px-1 py-px font-mono text-[9px] leading-4',
                      st?.chip ?? STATE_CHIP_FALLBACK,
                    )}
                  >
                    {a.state}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                    {a.activity ?? 'sin actividad'}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {/* Acciones reales del shell/store — sin toggles operacionales */}
        <CommandGroup heading="Acciones">
          <CommandItem
            value="accion actualizar datos refrescar snapshot sincronizar"
            onSelect={() => {
              void refresh()
              setOpen(false)
            }}
            className="gap-3 data-[selected=true]:bg-emerald-400/10 data-[selected=true]:text-emerald-100"
          >
            <RefreshCw className="h-4 w-4 shrink-0 text-teal-300" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Actualizar datos</span>
          </CommandItem>
          <CommandItem
            value="accion alternar tema claro oscuro dark light modo"
            onSelect={() => {
              setTheme(isDark ? 'light' : 'dark')
              setOpen(false)
            }}
            className="gap-3 data-[selected=true]:bg-emerald-400/10 data-[selected=true]:text-emerald-100"
          >
            {isDark ? (
              <Sun className="h-4 w-4 shrink-0 text-amber-300" aria-hidden />
            ) : (
              <Moon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">Alternar tema claro/oscuro</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
