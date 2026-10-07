// ============================================================
// EEC — COMMAND REGISTRY (spec §13)
// Catálogo de comandos con esquemas zod. Comando = "DO THIS".
// Evento = "THIS HAPPENED". Nunca se mezclan.
// ============================================================
import { z } from 'zod'

const id = z.string().min(1)

export const COMMAND_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // ---- agentes ----
  'agent.register': z.object({
    code: z.string().min(2).max(40),
    name: z.string().min(2),
    role: z.string().min(2),
    description: z.string().optional(),
    provider: z.string().default('local-sim'),
    endpoint: z.string().optional(),
    departmentCode: z.string().optional(),
    officeCode: z.string().optional(),
    capabilities: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    clearance: z.string().default('INTERNAL'),
  }),
  'agent.start': z.object({ agentId: id.optional(), code: z.string().optional() }).refine(a => a.agentId || a.code, 'agentId o code requerido'),
  'agent.pause': z.object({ agentId: id }),
  'agent.resume': z.object({ agentId: id }),
  'agent.stop': z.object({ agentId: id, reason: z.string().optional() }),
  'agent.suspend': z.object({ agentId: id, reason: z.string().optional() }),
  'agent.wake': z.object({ agentId: id }),
  'agent.assign_office': z.object({ agentId: id, officeCode: z.string() }),

  // ---- tareas ----
  'task.create': z.object({
    title: z.string().min(3),
    description: z.string().optional(),
    projectCode: z.string().optional(),
    assigneeAgentId: id.optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('LOW'),
    dueAt: z.string().datetime().optional(),
    tags: z.array(z.string()).default([]),
    kind: z.string().default('generic'),
  }),
  'task.assign': z.object({ taskId: id, agentId: id }),
  'task.start': z.object({ taskId: id }),
  'task.pause': z.object({ taskId: id, reason: z.string().optional() }),
  'task.resume': z.object({ taskId: id }),
  'task.cancel': z.object({ taskId: id, reason: z.string().optional() }),
  'task.retry': z.object({ taskId: id }),
  'task.complete': z.object({ taskId: id, result: z.record(z.string(), z.unknown()).default({}) }),
  'task.move': z.object({ taskId: id, to: z.string() }),

  // ---- workflows ----
  'workflow.start': z.object({ workflowId: id.optional(), code: z.string().optional(), context: z.record(z.string(), z.unknown()).default({}) }),
  'workflow.pause': z.object({ runId: id }),
  'workflow.resume': z.object({ runId: id }),
  'workflow.cancel': z.object({ runId: id, reason: z.string().optional() }),
  'workflow.retry': z.object({ runId: id }),

  // ---- meetings ----
  'meeting.create': z.object({
    title: z.string().min(3),
    objective: z.string().optional(),
    agenda: z.array(z.string()).default([]),
    locationCode: z.string().optional(),
    organizerAgentId: id.optional(),
    scheduledStartAt: z.string().datetime(),
    durationMinutes: z.number().int().positive().default(30),
    participantAgentIds: z.array(id).default([]),
  }),
  'meeting.invite': z.object({ meetingId: id, agentIds: z.array(id).default([]) }),
  'meeting.start': z.object({ meetingId: id }),
  'meeting.end': z.object({
    meetingId: id,
    decisions: z.array(z.string()).default([]),
    actionItems: z.array(z.object({ title: z.string(), assigneeAgentId: id.optional(), priority: z.string().default('MEDIUM') })).default([]),
    result: z.string().optional(),
  }),

  // ---- approvals / intervención humana ----
  'approval.request': z.object({
    requestType: z.string().min(3),
    title: z.string().min(3),
    description: z.string().optional(),
    subjectType: z.string().optional(),
    subjectId: z.string().optional(),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
    payload: z.record(z.string(), z.unknown()).default({}),
    ttlMinutes: z.number().int().positive().default(1440),
    requestedById: z.string().optional(),
    // comando pendiente que se reanudará al aprobar
    resumeCommandId: z.string().optional(),
  }),
  'approval.approve': z.object({ approvalId: id, note: z.string().optional() }),
  'approval.reject': z.object({ approvalId: id, note: z.string().optional() }),
  'approval.cancel': z.object({ approvalId: id, note: z.string().optional() }),
  'intervention.request': z.object({
    agentId: id.optional(),
    taskId: id.optional(),
    reason: z.string().min(3),
    urgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  }),

  // ---- runtime ----
  'runtime.start': z.object({ runtimeId: id }),
  'runtime.stop': z.object({ runtimeId: id }),
  'runtime.restart': z.object({ runtimeId: id }),
  'runtime.recover': z.object({ runtimeId: id }),

  // ---- CRM ----
  'client.create': z.object({
    name: z.string().min(2), segment: z.string().optional(),
    contactName: z.string().optional(), contactEmail: z.string().email().optional(),
    notes: z.string().optional(), ownerAgentId: id.optional(), tags: z.array(z.string()).default([]),
  }),
  'client.update_stage': z.object({ clientId: id, stage: z.string(), note: z.string().optional() }),
  'opportunity.create': z.object({
    clientId: id, name: z.string().min(2), stage: z.string().default('PROSPECT'),
    value: z.number().nonnegative().default(0), currency: z.string().default('USD'),
    probability: z.number().int().min(0).max(100).default(20), ownerAgentId: id.optional(),
    expectedCloseAt: z.string().datetime().optional(), notes: z.string().optional(),
  }),
  'opportunity.update_stage': z.object({ opportunityId: id, stage: z.string(), note: z.string().optional() }),
  'interaction.log': z.object({
    clientId: id.optional(), opportunityId: id.optional(), agentId: id.optional(),
    channel: z.enum(['EMAIL', 'CALL', 'MEETING', 'CHAT', 'WEBHOOK']),
    summary: z.string().min(3),
  }),

  // ---- calendario / scheduler ----
  'calendar.create': z.object({
    title: z.string().min(2),
    type: z.enum(['MEETING', 'DEADLINE', 'SCHEDULED_RUN', 'REMINDER', 'FOCUS_BLOCK']),
    startAt: z.string().datetime(),
    endAt: z.string().datetime().optional(),
    timezone: z.string().default('UTC'),
    locationCode: z.string().optional(),
    relatedType: z.string().optional(),
    relatedId: z.string().optional(),
    commandType: z.string().optional(),
    commandPayload: z.record(z.string(), z.unknown()).optional(),
    recurrenceCron: z.string().optional(),
    reminderMinutes: z.number().int().optional(),
  }),
  'schedule.create': z.object({
    name: z.string().min(2),
    kind: z.enum(['ONE_TIME', 'RECURRING', 'EVENT_TRIGGERED', 'DEPENDENCY_TRIGGERED', 'DEADLINE_TRIGGERED']),
    expression: z.string().min(1),
    timezone: z.string().default('UTC'),
    commandType: z.string().min(3),
    commandPayload: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  }),
  'schedule.toggle': z.object({ scheduleId: id, enabled: z.boolean() }),

  // ---- memoria / conocimiento / tools ----
  'memory.write': z.object({
    agentId: id.optional(),
    scope: z.enum(['SHORT_TERM_CONTEXT', 'WORKING_CONTEXT', 'LONG_TERM_MEMORY', 'ORGANIZATIONAL_MEMORY']),
    kind: z.string().default('OBSERVATION'),
    content: z.string().min(3),
    importance: z.number().int().min(1).max(10).default(5),
    classification: z.string().default('INTERNAL'),
    tags: z.array(z.string()).default([]),
    provenance: z.record(z.string(), z.unknown()).default({}),
    ttlMinutes: z.number().int().optional(),
  }),
  'knowledge.publish': z.object({
    title: z.string().min(3),
    sourceType: z.enum(['DOCUMENT', 'DATABASE', 'WEB', 'INTERNAL_SYSTEM', 'CLIENT_DATA', 'DOMAIN']),
    content: z.string().min(10),
    sourceRef: z.string().optional(),
    classification: z.string().default('INTERNAL'),
    tags: z.array(z.string()).default([]),
  }),
  'tool.invoke': z.object({
    toolCode: z.string().min(2),
    input: z.record(z.string(), z.unknown()).default({}),
    agentId: id.optional(),
    taskId: id.optional(),
    runId: id.optional(),
  }),

  // ---- sistema ----
  'notification.read': z.object({ notificationId: id }),
  'audit.correct': z.object({
    prevAuditId: id,
    action: z.string(),
    entityType: z.string(), entityId: z.string(),
    why: z.string().min(3),
    output: z.record(z.string(), z.unknown()).default({}),
    result: z.string().optional(),
  }),
  'system.simulation.toggle': z.object({ enabled: z.boolean() }),
  'system.chaos.runtime_crash': z.object({ runtimeId: id, reason: z.string().default('chaos: simulated crash') }),
  'system.deadletter.retry': z.object({ limit: z.number().int().positive().max(500).default(50) }),
}

export function getCommandSchema(type: string): z.ZodTypeAny | null {
  return COMMAND_SCHEMAS[type] ?? null
}

export function isKnownCommand(type: string): boolean {
  return !!COMMAND_SCHEMAS[type]
}
