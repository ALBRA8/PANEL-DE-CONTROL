// ============================================================
// EEC — CLIENT API (navegador)
// Tipos del snapshot + helpers de fetch + paleta de estados.
// La UI SOLO lee estado de aquí y ejecuta comandos — nunca es source of truth.
// ============================================================

export interface EecRuntime {
  id: string
  agentId: string
  provider: string
  status: string
  health: string
  restarts: number
  lastHeartbeatAt: string | null
  startedAt: string | null
}

export interface EecAgent {
  id: string
  code: string
  name: string
  role: string
  description?: string | null
  provider: string
  state: string
  activity: string | null
  locationId: string | null
  officeId: string | null
  departmentId: string | null
  currentTaskId: string | null
  healthStatus: string
  lastHeartbeatAt: string | null
  department?: { id: string; code: string; name: string } | null
  office?: { id: string; code: string; name: string; x: number; y: number } | null
  location?: { id: string; code: string; name: string; type: string; x: number; y: number } | null
  runtimes: EecRuntime[]
}

export interface EecLocation {
  id: string
  code: string
  name: string
  type: string
  x: number
  y: number
  capacity: number
  departmentId: string | null
}

export interface EecTask {
  id: string
  code: string
  title: string
  description: string | null
  status: string
  priority: string
  risk: string
  assigneeAgentId: string | null
  assignee?: { id: string; code: string; name: string; state: string } | null
  project?: { code: string; name: string } | null
  dueAt: string | null
  createdAt: string
  updatedAt: string
}

export interface EecRun {
  id: string
  status: string
  progress: number
  currentNode: string | null
  taskId: string | null
  workflowId: string | null
  agentId: string | null
  startedAt: string | null
  completedAt: string | null
  error: string | null
  task?: { code: string; title: string } | null
  workflow?: { code: string; name: string } | null
  agent?: { code: string; name: string } | null
}

export interface EecMeetingParticipant {
  id: string
  agentId: string | null
  agent?: { id: string; code: string; name: string; state: string } | null
  role: string
  response: string
}

export interface EecMeeting {
  id: string
  code: string
  title: string
  objective: string | null
  status: string
  scheduledStartAt: string
  scheduledEndAt: string | null
  startedAt: string | null
  endedAt: string | null
  location?: { id: string; code: string; name: string } | null
  participants: EecMeetingParticipant[]
}

export interface EecApproval {
  id: string
  requestType: string
  subjectType: string | null
  subjectId: string | null
  title: string
  description: string | null
  risk: string
  status: string
  createdAt: string
  expiresAt: string | null
  decidedAt: string | null
  decisionNote: string | null
}

export interface EecNotification {
  id: string
  type: string
  severity: string
  title: string
  body: string | null
  readAt: string | null
  createdAt: string
}

export interface EecTool {
  id: string
  code: string
  name: string
  capability: string
  provider: string
  risk: string
  status: string
  description: string | null
}

export interface EecHealth {
  agentsTotal: number
  agentsByState: Record<string, number>
  runtimesRunning: number
  tasksByStatus: Record<string, number>
  runsActive: number
  approvalsPending: number
  meetingsActive: number
  blockedTasks: number
}

export interface EecSnapshot {
  generatedAt: string
  simulationMode: boolean
  health: EecHealth
  agents: EecAgent[]
  locations: EecLocation[]
  departments: Array<{ id: string; code: string; name: string; description: string | null }>
  tasks: EecTask[]
  runs: EecRun[]
  meetings: EecMeeting[]
  approvals: EecApproval[]
  notifications: EecNotification[]
  tools: EecTool[]
}

export interface EecEventItem {
  seq: number
  id: string
  event_type: string
  subject: string
  timestamp: string
  payload: Record<string, unknown>
  sim: boolean
}

export interface CommandResult {
  commandId: string
  status: string
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  approvalId?: string
  duplicate?: boolean
}

export async function fetchState(): Promise<EecSnapshot> {
  const res = await fetch('/api/eec/state', { cache: 'no-store' })
  if (!res.ok) throw new Error(`state ${res.status}`)
  return res.json()
}

export async function dispatchCommand(
  type: string,
  payload: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<CommandResult> {
  const res = await fetch('/api/eec/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload, requesterType: 'HUMAN', requesterId: 'operator', idempotencyKey }),
    cache: 'no-store',
  })
  return res.json()
}

// ---------- Paleta operacional (sin azul/índigo) ----------
export const AGENT_STATE_STYLE: Record<string, { label: string; dot: string; chip: string }> = {
  OFFLINE: { label: 'OFFLINE', dot: 'bg-slate-500', chip: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  IDLE: { label: 'IDLE', dot: 'bg-teal-400', chip: 'bg-teal-400/10 text-teal-300 border-teal-400/30' },
  WORKING: { label: 'WORKING', dot: 'bg-emerald-400 animate-pulse', chip: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30' },
  WAITING: { label: 'WAITING', dot: 'bg-amber-400', chip: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  BLOCKED: { label: 'BLOCKED', dot: 'bg-rose-500', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
  REVIEW: { label: 'REVIEW', dot: 'bg-violet-400', chip: 'bg-violet-400/10 text-violet-300 border-violet-400/30' },
  IN_MEETING: { label: 'IN MEETING', dot: 'bg-fuchsia-400 animate-pulse', chip: 'bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30' },
  ERROR: { label: 'ERROR', dot: 'bg-rose-600 animate-pulse', chip: 'bg-rose-600/15 text-rose-300 border-rose-600/40' },
  PAUSED: { label: 'PAUSED', dot: 'bg-amber-500', chip: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  SUSPENDED: { label: 'SUSPENDED', dot: 'bg-slate-600', chip: 'bg-slate-600/20 text-slate-400 border-slate-600/40' },
  DONE: { label: 'DONE', dot: 'bg-emerald-300', chip: 'bg-emerald-300/10 text-emerald-200 border-emerald-300/30' },
  RECOVERY: { label: 'RECOVERY', dot: 'bg-amber-300 animate-pulse', chip: 'bg-amber-300/10 text-amber-200 border-amber-300/30' },
}

export const TASK_STATE_STYLE: Record<string, string> = {
  INBOX: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  BACKLOG: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  TODO: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  IN_PROGRESS: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  REVIEW: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  QUALITY_REVIEW: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  DONE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  BLOCKED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
  FAILED: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
}

export const RISK_STYLE: Record<string, string> = {
  LOW: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  MEDIUM: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  HIGH: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  CRITICAL: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
}

export const SEVERITY_STYLE: Record<string, string> = {
  INFO: 'text-teal-300',
  WARNING: 'text-amber-300',
  ERROR: 'text-rose-400',
  CRITICAL: 'text-rose-500 font-semibold',
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })
}
