'use client'

// ============================================================
// EEC — TABLERO KANBAN DE TAREAS v2 (Task 1-a board-v2)
// Columnas INBOX → DONE + grupo terminal (CANCELLED/FAILED).
// v2: barra sticky con búsqueda/filtros, WIP real por columna,
// drag & drop refinado (hint + columnas inválidas atenuadas),
// selección de tarjeta, confirmación destructiva de cancelación
// y exportación CSV de las tareas filtradas.
// Ley de oro: la UI no inventa actividad — refleja EEC STATE y
// emite comandos por el pipeline (task.move valida de verdad).
// ============================================================

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, Download, MoreVertical, Plus, Search, X } from 'lucide-react'

import { useEecStore } from '@/store/eec-store'
import {
  AGENT_STATE_STYLE,
  RISK_STYLE,
  timeAgo,
  type CommandResult,
  type EecTask,
} from '@/lib/eec-client'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ---------- Configuración de columnas ----------

const MAIN_COLUMNS = [
  'INBOX',
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'REVIEW',
  'QUALITY_REVIEW',
  'DONE',
] as const

const TERMINAL_COLUMNS = ['CANCELLED', 'FAILED'] as const

const ALL_COLUMNS: string[] = [...MAIN_COLUMNS, ...TERMINAL_COLUMNS]

type MainColumn = (typeof MAIN_COLUMNS)[number]
type TerminalColumn = (typeof TERMINAL_COLUMNS)[number]

// Umbrales WIP (solo visual, honestos): amber > 8, rose > 12.
const WIP_WARN = 8
const WIP_MAX = 12

// Espejo UI de TASK_TRANSITIONS (dominio): guía visual del drag & drop.
// La verdad sigue siendo el pipeline: un movimiento inválido será rechazado.
const TASK_TRANSITIONS_UI: Record<string, string[]> = {
  INBOX: ['BACKLOG', 'TODO', 'CANCELLED'],
  BACKLOG: ['TODO', 'INBOX', 'CANCELLED'],
  TODO: ['IN_PROGRESS', 'BACKLOG', 'CANCELLED', 'BLOCKED'],
  IN_PROGRESS: ['REVIEW', 'BLOCKED', 'CANCELLED', 'FAILED', 'DONE'],
  REVIEW: ['QUALITY_REVIEW', 'IN_PROGRESS', 'DONE', 'CANCELLED'],
  QUALITY_REVIEW: ['DONE', 'IN_PROGRESS', 'FAILED'],
  DONE: [],
  BLOCKED: ['TODO', 'IN_PROGRESS', 'CANCELLED'],
  CANCELLED: [],
  FAILED: ['TODO', 'BACKLOG', 'CANCELLED'],
}

function canMoveUi(from: string, to: string): boolean {
  return !!TASK_TRANSITIONS_UI[from]?.includes(to) && from !== to
}

const COLUMN_LABEL: Record<string, string> = {
  INBOX: 'Entrada',
  BACKLOG: 'Backlog',
  TODO: 'Por hacer',
  IN_PROGRESS: 'En progreso',
  REVIEW: 'Revisión',
  QUALITY_REVIEW: 'Revisión de calidad',
  DONE: 'Hecho',
  CANCELLED: 'Canceladas',
  FAILED: 'Fallidas',
}

const COLUMN_ACCENT: Record<string, string> = {
  INBOX: 'text-slate-300',
  BACKLOG: 'text-slate-300',
  TODO: 'text-teal-300',
  IN_PROGRESS: 'text-emerald-300',
  REVIEW: 'text-violet-300',
  QUALITY_REVIEW: 'text-violet-300',
  DONE: 'text-emerald-300',
  CANCELLED: 'text-slate-500',
  FAILED: 'text-rose-300',
}

const PRIORITY_CHIP: Record<string, string> = {
  LOW: 'border-slate-600/40 bg-slate-600/20 text-slate-400',
  MEDIUM: 'border-teal-400/30 bg-teal-400/10 text-teal-300',
  HIGH: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  CRITICAL: 'border-rose-600/40 bg-rose-600/15 text-rose-300',
}

const TASK_KINDS = [
  'generic',
  'research',
  'report',
  'outreach',
  'crm_update',
  'analysis',
] as const

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

// Valores-centinela de los filtros Select (radix exige valores no vacíos).
const FILTER_ALL = 'all'
const FILTER_UNASSIGNED = 'unassigned'

// ---------- Acciones por estado ----------

interface TaskAction {
  label: string
  danger?: boolean
  run: () => void
}

function isTerminal(status: string): boolean {
  return status === 'DONE' || status === 'CANCELLED' || status === 'FAILED'
}

function isOverdue(task: EecTask): boolean {
  if (!task.dueAt || isTerminal(task.status)) return false
  return new Date(task.dueAt).getTime() < Date.now()
}

function groupByStatus(tasks: EecTask[]): Record<string, EecTask[]> {
  const g: Record<string, EecTask[]> = {}
  for (const col of ALL_COLUMNS) g[col] = []
  for (const t of tasks) {
    if (g[t.status]) g[t.status].push(t)
  }
  return g
}

// ---------- Card de tarea (memoizada) ----------

interface TaskCardProps {
  task: EecTask
  dragging: boolean
  selected: boolean
  onDragStart: (taskId: string, from: string) => void
  onDragEnd: () => void
  onToggleSelect: (taskId: string) => void
}

const TaskCard = memo(function TaskCard({
  task,
  dragging,
  selected,
  onDragStart,
  onDragEnd,
  onToggleSelect,
}: TaskCardProps) {
  const command = useEecStore((s) => s.command)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const exec = useCallback(
    async (type: string, payload: Record<string, unknown>, okMsg: string) => {
      try {
        const res: CommandResult = await command(type, payload)
        if (!res.ok) {
          toast.error(res.error ?? 'El comando fue rechazado por el pipeline')
          return
        }
        toast.success(okMsg)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Fallo de red al enviar el comando')
      }
    },
    [command],
  )

  const actions: TaskAction[] = useMemo(() => {
    const execFor = (type: string, payload: Record<string, unknown>, okMsg: string) => () => {
      void exec(type, payload, okMsg)
    }
    const move = (to: string, label: string): TaskAction => ({
      label,
      run: execFor('task.move', { taskId: task.id, to }, `${task.code} movida a ${COLUMN_LABEL[to] ?? to}`),
    })
    // Destructiva: pasa por AlertDialog antes de emitir task.cancel.
    const cancelAction: TaskAction = {
      label: 'Cancelar tarea…',
      danger: true,
      run: () => setConfirmCancel(true),
    }
    switch (task.status) {
      case 'INBOX':
        return [move('BACKLOG', 'Mover a Backlog'), cancelAction]
      case 'BACKLOG':
        return [cancelAction]
      case 'TODO':
        return [
          { label: 'Iniciar', run: execFor('task.start', { taskId: task.id }, `${task.code} iniciada`) },
          cancelAction,
        ]
      case 'IN_PROGRESS':
        return [
          { label: 'Pausar', run: execFor('task.pause', { taskId: task.id }, `${task.code} pausada`) },
          { label: 'Completar', run: execFor('task.complete', { taskId: task.id, result: {} }, `${task.code} completada`) },
          move('REVIEW', 'Mover a Revisión'),
          cancelAction,
        ]
      case 'REVIEW':
      case 'QUALITY_REVIEW':
        return [
          { label: 'Aprobar y cerrar', run: execFor('task.complete', { taskId: task.id, result: {} }, `${task.code} aprobada y cerrada`) },
          move('IN_PROGRESS', 'Devolver a En progreso'),
          cancelAction,
        ]
      case 'BLOCKED':
        return [cancelAction]
      case 'FAILED':
        return [
          { label: 'Reintentar', run: execFor('task.retry', { taskId: task.id }, `${task.code} reintentando`) },
          cancelAction,
        ]
      default:
        return []
    }
  }, [task.status, task.id, task.code, exec])

  const overdue = isOverdue(task)

  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', task.id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart(task.id, task.status)
        }}
        onDragEnd={onDragEnd}
        onClick={() => onToggleSelect(task.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleSelect(task.id)
          }
        }}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        title="Clic para seleccionar · arrastra para mover entre columnas (o usa el menú ⋮)"
        className={cn(
          'space-y-2 rounded-lg border border-slate-800 bg-slate-900/70 p-3',
          'cursor-grab touch-manipulation transition-all active:cursor-grabbing',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50',
          dragging && 'opacity-50 cursor-grabbing',
          selected && 'border-emerald-500/60 shadow-lg shadow-emerald-500/10 ring-2 ring-emerald-500',
        )}
      >
        <div className="flex items-start justify-between gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-slate-500">{task.code}</span>
            {task.project?.code && (
              <Badge
                variant="outline"
                className="border-slate-600/40 bg-slate-600/20 font-mono text-[9px] text-slate-400"
              >
                {task.project.code}
              </Badge>
            )}
          </div>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => e.stopPropagation()}
                className="-mr-1.5 -mt-1.5 h-11 w-11 shrink-0 text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
                aria-label={`Acciones para ${task.code}`}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
              className="w-52 border-slate-800 bg-slate-900 text-slate-200"
            >
              {actions.length === 0 ? (
                <DropdownMenuItem disabled>Sin acciones disponibles</DropdownMenuItem>
              ) : (
                actions.map((a, idx) => (
                  <div key={a.label}>
                    {idx > 0 && a.danger && <DropdownMenuSeparator className="bg-slate-800" />}
                    <DropdownMenuItem
                      onClick={() => a.run()}
                      className={cn(a.danger && 'text-rose-300 focus:text-rose-300')}
                    >
                      {a.label}
                    </DropdownMenuItem>
                  </div>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <p className="text-sm leading-snug text-slate-200">{task.title}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          {(task.priority === 'HIGH' || task.priority === 'CRITICAL') && (
            <Badge
              variant="outline"
              className={cn('border font-mono text-[9px]', PRIORITY_CHIP[task.priority])}
            >
              {task.priority}
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn('border text-[9px]', RISK_STYLE[task.risk] ?? 'border-slate-600/40 bg-slate-600/20 text-slate-400')}
          >
            riesgo {task.risk}
          </Badge>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
          {task.assignee ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  AGENT_STATE_STYLE[task.assignee.state]?.dot ?? 'bg-slate-600',
                )}
                aria-hidden
              />
              <span className="truncate font-mono">{task.assignee.code}</span>
            </span>
          ) : (
            <span>sin asignar</span>
          )}
          {overdue && (
            <span className="shrink-0 font-medium text-rose-400">
              vencida {timeAgo(task.dueAt)}
            </span>
          )}
        </div>
      </div>

      {/* Confirmación destructiva: task.cancel */}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent
          onClick={(e) => e.stopPropagation()}
          className="border-slate-800 bg-slate-950 text-slate-100"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿Cancelar <span className="font-mono text-rose-300">{task.code}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              La tarea quedará CANCELLED. Los runs asociados se cerrarán.
              Esta acción se registra en la auditoría y se emite vía comando task.cancel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100">
              No, volver
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-rose-600 text-slate-50 hover:bg-rose-500"
              onClick={() => {
                void exec('task.cancel', { taskId: task.id }, `${task.code} cancelada`)
              }}
            >
              Cancelar tarea
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
})

// ---------- Columna (memoizada) ----------

interface ColumnProps {
  status: string
  tasks: EecTask[]
  /** total REAL de tareas en este estado antes de filtrar (estado vacío honesto) */
  totalCount: number
  dragFrom: string | null
  dragTaskId: string | null
  selectedId: string | null
  onCardDragStart: (taskId: string, from: string) => void
  onCardDragEnd: () => void
  onCardDrop: (taskId: string, from: string, to: string) => void
  onToggleSelect: (taskId: string) => void
}

const Column = memo(function Column({
  status,
  tasks,
  totalCount,
  dragFrom,
  dragTaskId,
  selectedId,
  onCardDragStart,
  onCardDragEnd,
  onCardDrop,
  onToggleSelect,
}: ColumnProps) {
  const [over, setOver] = useState(false)
  const valid = dragFrom ? canMoveUi(dragFrom, status) : null

  const wipTone =
    tasks.length > WIP_MAX
      ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
      : tasks.length > WIP_WARN
        ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
        : 'border-transparent bg-slate-800 text-slate-400'

  return (
    <section
      onDragOver={(e) => {
        if (!dragFrom) return
        // Se acepta el drop en TODAS las columnas: en las inválidas el
        // onDrop mostrará el toast de transición rechazada (además del pipeline).
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (valid) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const taskId = e.dataTransfer.getData('text/plain')
        if (taskId && dragFrom) onCardDrop(taskId, dragFrom, status)
      }}
      className={cn(
        'flex w-64 min-w-64 shrink-0 flex-col rounded-lg border border-slate-800/80 bg-slate-950/60 transition-all',
        dragFrom && valid === false && 'opacity-40',
        dragFrom && valid && 'border-emerald-400/50 ring-1 ring-emerald-400/50',
        over && 'border-emerald-400/60 bg-emerald-400/5 ring-2 ring-emerald-400/60',
      )}
      aria-label={`Columna ${COLUMN_LABEL[status] ?? status}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-slate-800/60 px-3 py-2.5">
        <h3
          className={cn(
            'text-xs font-semibold uppercase tracking-wider',
            COLUMN_ACCENT[status] ?? 'text-slate-300',
          )}
        >
          {COLUMN_LABEL[status] ?? status}
        </h3>
        <span
          className={cn(
            'flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 font-mono text-[10px]',
            wipTone,
          )}
          title={`WIP real: ${tasks.length} tareas en esta columna`}
        >
          {tasks.length}
        </span>
      </header>

      {dragFrom && valid && (
        <p className="border-b border-emerald-400/20 bg-emerald-400/5 px-3 py-1.5 text-[10px] font-medium text-emerald-300">
          Soltar para mover a {COLUMN_LABEL[status] ?? status}
        </p>
      )}

      <div className="eec-scroll max-h-[calc(100vh-19rem)] min-h-24 flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-slate-600">
            {totalCount > 0 ? 'Sin tareas que coincidan con el filtro' : 'Sin tareas'}
          </p>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              dragging={dragTaskId === t.id}
              selected={selectedId === t.id}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              onToggleSelect={onToggleSelect}
            />
          ))
        )}
      </div>
    </section>
  )
})

// ---------- Diálogo nueva tarea ----------

function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const command = useEecStore((s) => s.command)
  const snapshot = useEecStore((s) => s.snapshot)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<string>('MEDIUM')
  const [risk, setRisk] = useState<string>('LOW')
  const [kind, setKind] = useState<string>('generic')
  const [assignee, setAssignee] = useState<string>('none')
  const [submitting, setSubmitting] = useState(false)

  const availableAgents = useMemo(
    () => (snapshot?.agents ?? []).filter((a) => a.state === 'IDLE' || a.state === 'WORKING'),
    [snapshot],
  )

  function reset() {
    setTitle('')
    setDescription('')
    setPriority('MEDIUM')
    setRisk('LOW')
    setKind('generic')
    setAssignee('none')
  }

  async function submit() {
    if (!title.trim() || submitting) return
    setSubmitting(true)
    try {
      const res = await command('task.create', {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        risk,
        kind,
        assigneeAgentId: assignee === 'none' ? undefined : assignee,
      })
      if (!res.ok) {
        toast.error(res.error ?? 'No se pudo crear la tarea')
        return
      }
      toast.success('Tarea creada y registrada en EEC STATE')
      onOpenChange(false)
      reset()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fallo de red al crear la tarea')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva tarea</DialogTitle>
          <DialogDescription className="text-slate-500">
            Se registra vía comando task.create y pasa por el pipeline de validación y política.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Título</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Qué debe ejecutarse"
              className="h-11 border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-600"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-desc">Descripción</Label>
            <Textarea
              id="task-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Contexto, criterios de aceptación, restricciones…"
              rows={3}
              className="border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-600"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Prioridad</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-11 w-full border-slate-700 bg-slate-900 text-slate-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Riesgo</Label>
              <Select value={risk} onValueChange={setRisk}>
                <SelectTrigger className="h-11 w-full border-slate-700 bg-slate-900 text-slate-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
                  {RISKS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="h-11 w-full border-slate-700 bg-slate-900 text-slate-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
                  {TASK_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Asignatario (agentes disponibles)</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger className="h-11 w-full border-slate-700 bg-slate-900 text-slate-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
                  <SelectItem value="none">Sin asignar</SelectItem>
                  {availableAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {availableAgents.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No hay agentes IDLE o WORKING ahora mismo; la tarea quedará sin asignar.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="h-11 border-slate-700 text-slate-300 hover:bg-slate-800"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            className="h-11 bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            disabled={!title.trim() || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Creando…' : 'Crear tarea'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Board ----------

export default function TaskBoard() {
  const snapshot = useEecStore((s) => s.snapshot)
  const command = useEecStore((s) => s.command)

  const [terminalOpen, setTerminalOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Estado de drag centralizado {id, from} — fix del Task 7 (la columna
  // destino no deriva el origen de su propia lista).
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dragFrom, setDragFrom] = useState<string | null>(null)

  // Selección: una tarjeta a la vez; el clic no interfiere con el drag.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const suppressClickRef = useRef(false)

  // Filtros v2
  const [query, setQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<string>(FILTER_ALL)
  const [assigneeFilter, setAssigneeFilter] = useState<string>(FILTER_ALL)
  const [projectFilter, setProjectFilter] = useState<string>(FILTER_ALL)
  const [onlyOverdue, setOnlyOverdue] = useState(false)

  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot])

  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot])

  const projects = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) if (t.project?.code) set.add(t.project.code)
    return [...set].sort()
  }, [tasks])

  const groupedAll = useMemo(() => groupByStatus(tasks), [tasks])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tasks.filter((t) => {
      if (q) {
        const hay = [t.code, t.title, t.description ?? '', t.assignee?.code ?? '', t.assignee?.name ?? '']
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (priorityFilter !== FILTER_ALL && t.priority !== priorityFilter) return false
      if (assigneeFilter === FILTER_UNASSIGNED) {
        if (t.assigneeAgentId) return false
      } else if (assigneeFilter !== FILTER_ALL && t.assigneeAgentId !== assigneeFilter) {
        return false
      }
      if (projectFilter !== FILTER_ALL && t.project?.code !== projectFilter) return false
      if (onlyOverdue && !isOverdue(t)) return false
      return true
    })
  }, [tasks, query, priorityFilter, assigneeFilter, projectFilter, onlyOverdue])

  const grouped = useMemo(() => groupByStatus(filtered), [filtered])

  const filtersActive =
    query.trim() !== '' ||
    priorityFilter !== FILTER_ALL ||
    assigneeFilter !== FILTER_ALL ||
    projectFilter !== FILTER_ALL ||
    onlyOverdue

  const total = tasks.length
  const visible = filtered.length
  const terminalCount = groupedAll.CANCELLED.length + groupedAll.FAILED.length

  const selectedTask = useMemo(
    () => (selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null),
    [tasks, selectedId],
  )

  const setDragTask = useCallback((t: { id: string; from: string } | null) => {
    setDragTaskId(t?.id ?? null)
    setDragFrom(t?.from ?? null)
  }, [])

  const handleCardDragStart = useCallback(
    (taskId: string, from: string) => {
      suppressClickRef.current = true
      setDragTask({ id: taskId, from })
    },
    [setDragTask],
  )

  const handleCardDragEnd = useCallback(() => {
    setDragTask(null)
    // El click posterior a un drag real se ignora (no debe seleccionar).
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 150)
  }, [setDragTask])

  const handleToggleSelect = useCallback((taskId: string) => {
    if (suppressClickRef.current) return
    setSelectedId((prev) => (prev === taskId ? null : taskId))
  }, [])

  // Suelta de una tarea en una columna: comando task.move (el pipeline valida).
  const handleDropTask = useCallback(
    async (taskId: string, from: string, to: string) => {
      if (from === to) return
      if (!canMoveUi(from, to)) {
        toast.error(
          `Transición no permitida: ${COLUMN_LABEL[from] ?? from} → ${COLUMN_LABEL[to] ?? to}`,
        )
        return
      }
      try {
        const res: CommandResult = await command('task.move', { taskId, to })
        if (!res.ok) {
          toast.error(res.error ?? 'El pipeline rechazó el movimiento')
          return
        }
        const code =
          useEecStore.getState().snapshot?.tasks.find((t) => t.id === taskId)?.code ?? 'Tarea'
        toast.success(`${code} → ${COLUMN_LABEL[to] ?? to}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Fallo de red al mover la tarea')
      }
    },
    [command],
  )

  const handleCardDrop = useCallback(
    (taskId: string, from: string, to: string) => {
      void handleDropTask(taskId, from, to)
    },
    [handleDropTask],
  )

  // Export CSV de las tareas FILTRADAS actuales (BOM para Excel).
  const handleExportCsv = useCallback(() => {
    if (filtered.length === 0) {
      toast.message('No hay tareas que coincidan con el filtro')
      return
    }
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
    const header = 'code,title,status,priority,risk,assignee,project,dueDate,updatedAt'
    const lines = filtered.map((t) =>
      [
        t.code,
        t.title,
        t.status,
        t.priority,
        t.risk,
        t.assignee?.code ?? '',
        t.project?.code ?? '',
        t.dueAt ?? '',
        t.updatedAt,
      ]
        .map(escape)
        .join(','),
    )
    const csv = `\uFEFF${[header, ...lines].join('\r\n')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    anchor.href = url
    anchor.download = `eec-tasks-${stamp}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success(`${filtered.length} tareas exportadas a CSV`)
  }, [filtered])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Tablero de tareas</h1>
          <p className="text-xs text-slate-500">
            {filtersActive
              ? `${visible} de ${total} tareas coinciden con el filtro · fuente: EEC STATE, solo runs reales.`
              : `${total} tareas en EEC STATE · el progreso mostrado proviene solo de runs reales.`}
          </p>
        </div>
        <Button
          className="h-11 bg-emerald-500 text-slate-950 hover:bg-emerald-400"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Nueva tarea
        </Button>
      </div>

      {/* Barra de herramientas sticky (bajo el header del shell, h-14) */}
      <div
        role="group"
        aria-label="Barra de herramientas del tablero"
        className="sticky top-14 z-30 flex flex-col gap-2 rounded-lg border border-slate-800/80 bg-slate-950/95 p-2 backdrop-blur sm:flex-row sm:flex-wrap sm:items-center"
      >
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar código, título, descripción, asignatario…"
            aria-label="Buscar tareas por código, título, descripción o asignatario"
            className="h-11 border-slate-700 bg-slate-900 pl-9 pr-11 text-slate-100 placeholder:text-slate-600"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Limpiar búsqueda"
              className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger
            aria-label="Filtrar por prioridad"
            className="h-11 w-full border-slate-700 bg-slate-900 text-slate-200 sm:w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
            <SelectItem value={FILTER_ALL}>Todas las prioridades</SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger
            aria-label="Filtrar por asignatario"
            className="h-11 w-full min-w-40 border-slate-700 bg-slate-900 text-slate-200 sm:w-44"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
            <SelectItem value={FILTER_ALL}>Todos los asignatarios</SelectItem>
            <SelectItem value={FILTER_UNASSIGNED}>Sin asignar</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      AGENT_STATE_STYLE[a.state]?.dot ?? 'bg-slate-600',
                    )}
                    aria-hidden
                  />
                  {a.code} · {a.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger
            aria-label="Filtrar por proyecto"
            className="h-11 w-full border-slate-700 bg-slate-900 text-slate-200 sm:w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-slate-800 bg-slate-900 text-slate-100">
            <SelectItem value={FILTER_ALL}>Todos los proyectos</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p} value={p}>
                <span className="font-mono">{p}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-slate-300">
          <Checkbox
            checked={onlyOverdue}
            onCheckedChange={(v) => setOnlyOverdue(v === true)}
            aria-label="Mostrar solo tareas vencidas"
            className="border-slate-600 data-[state=checked]:border-emerald-500 data-[state=checked]:bg-emerald-500"
          />
          Solo vencidas
        </label>

        <Button
          variant="outline"
          className="h-11 border-slate-700 text-slate-300 hover:bg-slate-800"
          onClick={handleExportCsv}
          aria-label="Exportar las tareas filtradas a CSV"
        >
          <Download className="h-4 w-4" aria-hidden />
          Exportar CSV
        </Button>

        {selectedTask && (
          <p
            role="status"
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-400 sm:w-full"
          >
            <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
              {selectedTask.code}
            </span>
            <span className="truncate">
              seleccionada — usa el menú ⋮ de la tarjeta para moverla
            </span>
          </p>
        )}
      </div>

      <div className="eec-scroll flex gap-3 overflow-x-auto pb-3">
        {MAIN_COLUMNS.map((col) => (
          <Column
            key={col}
            status={col}
            tasks={grouped[col] ?? []}
            totalCount={groupedAll[col]?.length ?? 0}
            dragFrom={dragFrom}
            dragTaskId={dragTaskId}
            selectedId={selectedId}
            onCardDragStart={handleCardDragStart}
            onCardDragEnd={handleCardDragEnd}
            onCardDrop={handleCardDrop}
            onToggleSelect={handleToggleSelect}
          />
        ))}

        {terminalOpen ? (
          <>
            {TERMINAL_COLUMNS.map((col) => (
              <Column
                key={col}
                status={col}
                tasks={grouped[col] ?? []}
                totalCount={groupedAll[col]?.length ?? 0}
                dragFrom={dragFrom}
                dragTaskId={dragTaskId}
                selectedId={selectedId}
                onCardDragStart={handleCardDragStart}
                onCardDragEnd={handleCardDragEnd}
                onCardDrop={handleCardDrop}
                onToggleSelect={handleToggleSelect}
              />
            ))}
            <button
              type="button"
              onClick={() => setTerminalOpen(false)}
              className="flex h-11 shrink-0 items-center gap-1 self-start rounded-md px-3 text-[11px] text-slate-500 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
            >
              Contraer terminal
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setTerminalOpen(true)}
            className="flex w-14 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-800 bg-slate-950/60 text-slate-500 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
            aria-label={`Expandir grupo terminal: ${terminalCount} tareas canceladas o fallidas`}
            title="CANCELLED / FAILED"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
            <span className="font-mono text-[11px] [writing-mode:vertical-rl]">
              TERMINAL ({terminalCount})
            </span>
          </button>
        )}
      </div>

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
