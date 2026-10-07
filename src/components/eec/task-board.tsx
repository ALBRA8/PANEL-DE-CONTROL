'use client'

// ============================================================
// EEC — TABLERO KANBAN DE TAREAS (Task 7-a)
// Columnas INBOX → DONE + grupo terminal (CANCELLED/FAILED).
// Acciones reales vía comandos; progreso solo de runs reales.
// ============================================================

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, MoreVertical, Plus } from 'lucide-react'

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

type MainColumn = (typeof MAIN_COLUMNS)[number]
type TerminalColumn = (typeof TERMINAL_COLUMNS)[number]

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

// ---------- Acciones por estado ----------

interface TaskAction {
  label: string
  danger?: boolean
  run: () => Promise<void>
}

function isTerminal(status: string): boolean {
  return status === 'DONE' || status === 'CANCELLED' || status === 'FAILED'
}

function isOverdue(task: EecTask): boolean {
  if (!task.dueAt || isTerminal(task.status)) return false
  return new Date(task.dueAt).getTime() < Date.now()
}

// ---------- Card de tarea ----------

function TaskCard({ task }: { task: EecTask }) {
  const command = useEecStore((s) => s.command)
  const [menuOpen, setMenuOpen] = useState(false)

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
    const execFor = (type: string, payload: Record<string, unknown>, okMsg: string) => () =>
      exec(type, payload, okMsg)
    const move = (to: string, label: string): TaskAction => ({
      label,
      run: execFor('task.move', { taskId: task.id, to }, `${task.code} movida a ${COLUMN_LABEL[to] ?? to}`),
    })
    const cancelAction: TaskAction = {
      label: 'Cancelar tarea',
      danger: true,
      run: execFor('task.cancel', { taskId: task.id }, `${task.code} cancelada`),
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
    <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
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
              className="-mr-1.5 -mt-1.5 h-11 w-11 shrink-0 text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
              aria-label={`Acciones para ${task.code}`}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52 border-slate-800 bg-slate-900 text-slate-200"
          >
            {actions.length === 0 ? (
              <DropdownMenuItem disabled>Sin acciones disponibles</DropdownMenuItem>
            ) : (
              actions.map((a, idx) => (
                <div key={a.label}>
                  {idx > 0 && a.danger && <DropdownMenuSeparator className="bg-slate-800" />}
                  <DropdownMenuItem
                    onClick={() => void a.run()}
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
  )
}

// ---------- Columna ----------

function Column({
  status,
  tasks,
}: {
  status: string
  tasks: EecTask[]
}) {
  return (
    <section
      className="flex w-64 min-w-64 shrink-0 flex-col rounded-lg border border-slate-800/80 bg-slate-950/60"
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
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-800 px-1.5 font-mono text-[10px] text-slate-400">
          {tasks.length}
        </span>
      </header>
      <div className="eec-scroll max-h-[calc(100vh-19rem)] min-h-24 flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-slate-600">Sin tareas</p>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </section>
  )
}

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
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const grouped = useMemo(() => {
    const g: Record<string, EecTask[]> = {}
    for (const col of [...MAIN_COLUMNS, ...TERMINAL_COLUMNS]) g[col] = []
    for (const t of snapshot?.tasks ?? []) {
      if (g[t.status]) g[t.status].push(t)
    }
    return g
  }, [snapshot])

  const terminalCount =
    grouped.CANCELLED.length + grouped.FAILED.length
  const total = snapshot?.tasks.length ?? 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Tablero de tareas</h1>
          <p className="text-xs text-slate-500">
            {total} tareas en EEC STATE · el progreso mostrado proviene solo de runs reales.
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

      <div className="eec-scroll flex gap-3 overflow-x-auto pb-3">
        {MAIN_COLUMNS.map((col) => (
          <Column key={col} status={col} tasks={grouped[col] ?? []} />
        ))}

        {terminalOpen ? (
          <>
            {TERMINAL_COLUMNS.map((col) => (
              <Column key={col} status={col} tasks={grouped[col] ?? []} />
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
