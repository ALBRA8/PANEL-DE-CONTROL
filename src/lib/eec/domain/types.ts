// ============================================================
// EEC — DOMAIN TYPES (única fuente de catálogos de estado)
// SQLite/Prisma no soporta enums: TODOS los estados se validan aquí.
// Separación estricta: STATE ≠ ACTIVITY ≠ LOCATION ≠ TASK.
// ============================================================

// ---------- AGENT OPERATIONAL STATES (spec §12) ----------
export const AGENT_STATES = [
  'OFFLINE', 'IDLE', 'WORKING', 'WAITING', 'BLOCKED',
  'REVIEW', 'IN_MEETING', 'ERROR', 'PAUSED', 'SUSPENDED',
] as const
export type AgentState = (typeof AGENT_STATES)[number]

// Transitorios (no destino de comandos directos)
export const AGENT_TRANSIENT_STATES = ['DONE', 'RECOVERY'] as const
export type AgentTransientState = (typeof AGENT_TRANSIENT_STATES)[number]

// Máquina de estados operacional — solo transiciones válidas.
// Las inválidas se rechazan y se auditan (event agent.state.rejected).
// Incluye estados transitorios (DONE/RECOVERY) como destinos intermedios.
type AnyAgentState = AgentState | AgentTransientState
export const AGENT_STATE_TRANSITIONS: Record<AnyAgentState, AnyAgentState[]> = {
  OFFLINE:   ['IDLE', 'ERROR'],
  IDLE:      ['WORKING', 'IN_MEETING', 'PAUSED', 'SUSPENDED', 'OFFLINE', 'ERROR', 'BLOCKED'],
  WORKING:   ['IDLE', 'WAITING', 'BLOCKED', 'REVIEW', 'IN_MEETING', 'PAUSED', 'SUSPENDED', 'ERROR'],
  WAITING:   ['WORKING', 'IDLE', 'BLOCKED', 'PAUSED', 'SUSPENDED', 'ERROR'],
  BLOCKED:   ['WORKING', 'IDLE', 'ERROR', 'SUSPENDED'],
  REVIEW:    ['WORKING', 'IDLE', 'ERROR', 'SUSPENDED'],
  IN_MEETING:['IDLE', 'WORKING', 'ERROR'],
  ERROR:     ['RECOVERY', 'OFFLINE', 'IDLE', 'SUSPENDED'],
  PAUSED:    ['IDLE', 'WORKING', 'SUSPENDED', 'OFFLINE', 'ERROR'],
  SUSPENDED: ['IDLE', 'OFFLINE', 'ERROR'],
  // transitorios
  DONE:      ['IDLE'],
  RECOVERY:  ['IDLE', 'ERROR', 'OFFLINE'],
}

export function canTransition(from: string, to: string): boolean {
  const valid = AGENT_STATE_TRANSITIONS[from as AgentState]
  return !!valid && valid.includes(to as AgentState)
}

// ---------- RUNTIME STATES (spec §8) ----------
export const RUNTIME_STATES = [
  'CREATED', 'STARTING', 'READY', 'RUNNING', 'IDLE', 'STOPPING',
  'STOPPED', 'ERROR', 'CRASHED', 'UNHEALTHY', 'RECOVERING',
] as const
export type RuntimeStatus = (typeof RUNTIME_STATES)[number]

export const RUNTIME_TRANSITIONS: Record<RuntimeStatus, RuntimeStatus[]> = {
  CREATED:    ['STARTING', 'STOPPED', 'ERROR'],
  STARTING:   ['READY', 'ERROR', 'CRASHED'],
  READY:      ['RUNNING', 'STOPPING', 'ERROR'],
  RUNNING:    ['IDLE', 'STOPPING', 'ERROR', 'CRASHED', 'UNHEALTHY'],
  IDLE:       ['RUNNING', 'STOPPING', 'UNHEALTHY', 'ERROR'],
  STOPPING:   ['STOPPED', 'ERROR'],
  STOPPED:    ['STARTING'],
  ERROR:      ['RECOVERING', 'STOPPED', 'CRASHED'],
  CRASHED:    ['RECOVERING', 'STOPPED'],
  UNHEALTHY:  ['RUNNING', 'CRASHED', 'RECOVERING'],
  RECOVERING: ['READY', 'RUNNING', 'ERROR', 'CRASHED'],
}

export function canRuntimeTransition(from: string, to: string): boolean {
  const valid = RUNTIME_TRANSITIONS[from as RuntimeStatus]
  return !!valid && valid.includes(to as RuntimeStatus)
}

// ---------- SESSION (spec §9) ----------
export const SESSION_STATES = [
  'CREATED', 'INITIALIZING', 'ACTIVE', 'PAUSED', 'RESUMED',
  'COMPLETED', 'INTERRUPTED', 'FAILED',
] as const
export type SessionStatus = (typeof SESSION_STATES)[number]

// ---------- RUN (spec §10) ----------
export const RUN_STATES = [
  'PENDING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED',
  'CANCELLED', 'TIMED_OUT',
] as const
export type RunStatus = (typeof RUN_STATES)[number]

// ---------- TASK (spec §11) ----------
export const TASK_STATES = [
  'INBOX', 'BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW',
  'QUALITY_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED', 'FAILED',
] as const
export type TaskStatus = (typeof TASK_STATES)[number]

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  INBOX:          ['BACKLOG', 'TODO', 'CANCELLED'],
  BACKLOG:        ['TODO', 'INBOX', 'CANCELLED'],
  TODO:           ['IN_PROGRESS', 'BACKLOG', 'CANCELLED', 'BLOCKED'],
  IN_PROGRESS:    ['REVIEW', 'BLOCKED', 'CANCELLED', 'FAILED', 'DONE'],
  REVIEW:         ['QUALITY_REVIEW', 'IN_PROGRESS', 'DONE', 'CANCELLED'],
  QUALITY_REVIEW: ['DONE', 'IN_PROGRESS', 'FAILED'],
  DONE:           [],
  BLOCKED:        ['TODO', 'IN_PROGRESS', 'CANCELLED'],
  CANCELLED:      [],
  FAILED:         ['TODO', 'BACKLOG', 'CANCELLED'],
}

export function canTaskTransition(from: string, to: string): boolean {
  const valid = TASK_TRANSITIONS[from as TaskStatus]
  return !!valid && valid.includes(to as TaskStatus)
}

// ---------- APPROVAL (spec §24) ----------
export const APPROVAL_STATES = ['REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
export type ApprovalStatus = (typeof APPROVAL_STATES)[number]

// ---------- RIESGO (spec §26) ----------
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

// ---------- CLASIFICACIÓN DE DATOS (spec §25) ----------
export const DATA_CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'] as const
export type DataClass = (typeof DATA_CLASSES)[number]

// ---------- CRM PIPELINE (spec §32) ----------
export const CRM_STAGES = [
  'PROSPECT', 'CONTACTED', 'QUALIFIED', 'OPPORTUNITY',
  'NEGOTIATION', 'CLIENT', 'RETENTION',
] as const
export type CrmStage = (typeof CRM_STAGES)[number]

export const OPPORTUNITY_STAGES = ['PROSPECT', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST'] as const

// ---------- MEMORIA (spec §18) ----------
export const MEMORY_SCOPES = [
  'SHORT_TERM_CONTEXT', 'WORKING_CONTEXT', 'LONG_TERM_MEMORY', 'ORGANIZATIONAL_MEMORY',
] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

// ---------- PROVIDER TYPES (spec §43) ----------
export const PROVIDER_TYPES = [
  'AGENT', 'ORCHESTRATOR', 'RUNTIME', 'MODEL', 'TOOL',
  'MEMORY', 'KNOWLEDGE', 'NOTIFICATION', 'STORAGE',
] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

// ---------- COMANDOS (spec §13) ----------
export const COMMAND_TYPES = [
  'agent.register', 'agent.start', 'agent.pause', 'agent.resume', 'agent.stop',
  'agent.suspend', 'agent.wake', 'agent.assign_office',
  'task.create', 'task.assign', 'task.start', 'task.pause', 'task.resume',
  'task.cancel', 'task.retry', 'task.complete', 'task.move',
  'workflow.start', 'workflow.pause', 'workflow.resume', 'workflow.cancel', 'workflow.retry',
  'meeting.create', 'meeting.invite', 'meeting.start', 'meeting.end',
  'approval.request', 'approval.approve', 'approval.reject', 'approval.cancel',
  'intervention.request',
  'runtime.start', 'runtime.stop', 'runtime.restart', 'runtime.recover',
  'client.create', 'client.update_stage', 'opportunity.create', 'opportunity.update_stage',
  'interaction.log', 'calendar.create', 'schedule.create', 'schedule.toggle',
  'memory.write', 'knowledge.publish', 'tool.invoke',
  'notification.read', 'audit.correct',
  'system.simulation.toggle', 'system.chaos.runtime_crash', 'system.deadletter.retry',
] as const
export type CommandType = (typeof COMMAND_TYPES)[number]

// Riesgo por comando (política-driven por defecto, catálogo como base)
export const COMMAND_RISK: Record<string, RiskLevel> = {
  'agent.register': 'LOW', 'agent.start': 'LOW', 'agent.pause': 'LOW', 'agent.resume': 'LOW',
  'agent.stop': 'MEDIUM', 'agent.suspend': 'MEDIUM', 'agent.wake': 'LOW', 'agent.assign_office': 'LOW',
  'task.create': 'LOW', 'task.assign': 'LOW', 'task.start': 'LOW', 'task.pause': 'LOW',
  'task.resume': 'LOW', 'task.cancel': 'MEDIUM', 'task.retry': 'LOW', 'task.complete': 'LOW',
  'task.move': 'LOW',
  'workflow.start': 'MEDIUM', 'workflow.pause': 'LOW', 'workflow.resume': 'LOW',
  'workflow.cancel': 'MEDIUM', 'workflow.retry': 'LOW',
  'meeting.create': 'LOW', 'meeting.invite': 'LOW', 'meeting.start': 'LOW', 'meeting.end': 'LOW',
  'approval.request': 'LOW', 'approval.approve': 'HIGH', 'approval.reject': 'HIGH', 'approval.cancel': 'LOW',
  'intervention.request': 'LOW',
  'runtime.start': 'LOW', 'runtime.stop': 'MEDIUM', 'runtime.restart': 'MEDIUM', 'runtime.recover': 'MEDIUM',
  'client.create': 'LOW', 'client.update_stage': 'MEDIUM', 'opportunity.create': 'LOW',
  'opportunity.update_stage': 'MEDIUM', 'interaction.log': 'LOW',
  'calendar.create': 'LOW', 'schedule.create': 'MEDIUM', 'schedule.toggle': 'MEDIUM',
  'memory.write': 'LOW', 'knowledge.publish': 'MEDIUM', 'tool.invoke': 'MEDIUM',
  'notification.read': 'LOW', 'audit.correct': 'HIGH',
  'system.simulation.toggle': 'HIGH', 'system.chaos.runtime_crash': 'HIGH',
  'system.deadletter.retry': 'MEDIUM',
}

// ---------- EVENTOS (spec §14) ----------
export const EVENT_NAMESPACES = [
  'agent', 'task', 'workflow', 'run', 'runtime', 'meeting', 'user',
  'client', 'memory', 'tool', 'approval', 'system',
] as const
export type EventNamespace = (typeof EVENT_NAMESPACES)[number]

export interface EventEnvelope {
  event_id: string
  event_type: string
  version: string
  timestamp: string
  source: string
  subject: string
  correlation_id?: string | null
  causation_id?: string | null
  trace_id?: string | null
  span_id?: string | null
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  seq?: number
  sim?: boolean
}

// ---------- CAPACIDADES / HUMAN CONTROLS (spec §24) ----------
export const HUMAN_CONTROLS = [
  'ASSIGN', 'CALL', 'PAUSE', 'WAKE', 'APPROVE', 'REJECT',
  'REDIRECT', 'INSPECT', 'ENTER', 'STOP', 'RESUME', 'SUSPEND', 'RETRY',
] as const

// ---------- EVALUACIÓN (spec §29) ----------
export const EVALUATION_MODES = ['RULE_BASED', 'MODEL_BASED', 'HUMAN', 'HYBRID'] as const
export type EvaluationMode = (typeof EVALUATION_MODES)[number]
export const EVALUATION_DIMENSIONS = [
  'quality', 'accuracy', 'completeness', 'compliance', 'consistency', 'latency', 'cost',
] as const
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number]
export type EvaluationVerdict = 'PASS' | 'FAIL' | 'REVIEW'

// ---------- SCHEDULER (spec §22) ----------
export const SCHEDULE_KINDS = [
  'ONE_TIME', 'RECURRING', 'EVENT_TRIGGERED', 'DEPENDENCY_TRIGGERED', 'DEADLINE_TRIGGERED',
] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

// ---------- HELPERS ----------
export function isRiskLevel(v: string): v is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(v)
}

export function riskRank(r: string): number {
  return ({ LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as Record<string, number>)[r] ?? 0
}

export const RISK_APPROVAL_THRESHOLD: RiskLevel = 'HIGH'
export function requiresApproval(risk: string): boolean {
  return riskRank(risk) >= riskRank(RISK_APPROVAL_THRESHOLD)
}

export function isDataClass(v: string): v is DataClass {
  return (DATA_CLASSES as readonly string[]).includes(v)
}

export function dataClassRank(c: string): number {
  return ({ PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, SECRET: 4 } as Record<string, number>)[c] ?? 1
}
