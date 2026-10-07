// ============================================================
// EEC — CONTEXT ASSEMBLY (spec §20)
// TASK → IDENTITY → PERMISSIONS → PROJECT → MEMORY → KNOWLEDGE →
// CONVERSATION → TOOLS → POLICIES → CONTEXT PACKAGE → AGENT
// El contexto se ensambla deliberadamente antes de cada ejecución.
// ============================================================
import { db } from '../../../lib/db'
import type { ContextPackage } from '../domain/contracts'
import { memoryService, knowledgeService, agentClearance } from './memory'

export async function buildContextPackage(args: {
  agentId: string
  taskId?: string | null
  runId?: string | null
  extra?: Record<string, unknown>
}): Promise<ContextPackage> {
  const { agentId, taskId, runId } = args

  const agent = await db.agent.findUnique({
    where: { id: agentId },
    include: { department: true, office: true },
  })
  if (!agent) throw new Error(`AGENT_NOT_FOUND:${agentId}`)

  const task = taskId ? await db.task.findUnique({ where: { id: taskId }, include: { project: true } }) : null

  const [permissions, memoryHits, tools, policies] = await Promise.all([
    db.permission.findMany({ where: { agentId, effect: 'ALLOW' }, take: 50 }),
    memoryService().query({ agentId, scopes: ['WORKING_CONTEXT', 'LONG_TERM_MEMORY'], limit: 8 }),
    db.tool.findMany({ where: { status: 'AVAILABLE' }, take: 50 }),
    db.policy.findMany({ where: { enabled: true }, take: 50 }),
  ])

  const clearance = await agentClearance(agentId)
  const knowledgeHits = task
    ? await knowledgeService().retrieve({ text: `${task.title} ${task.description ?? ''}`, limit: 5 }, clearance)
    : []

  const conversation = await db.conversation.findFirst({
    where: { OR: [{ agentId }, ...(taskId ? [{ taskId }] : [])], status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { messages: true } } },
  })

  return {
    identity: { agentId, code: agent.code, role: agent.role, provider: agent.provider },
    permissions: permissions.map(p => ({ capability: p.capability, resource: p.resource, action: p.action, effect: p.effect })),
    project: task?.project ? { id: task.project.id, code: task.project.code, name: task.project.name, objective: task.project.objective } : null,
    memory: memoryHits.map(m => ({ id: m.id, scope: m.scope, content: m.content, importance: m.importance })),
    knowledge: knowledgeHits.map(k => ({ id: k.id, title: k.title, sourceType: k.sourceType, excerpt: k.excerpt, classification: k.classification })),
    conversation: conversation ? { id: conversation.id, title: conversation.title, messageCount: conversation._count.messages } : null,
    tools: tools.map(t => ({ code: t.code, name: t.name, capability: t.capability, risk: t.risk })),
    policies: policies.map(p => ({ code: p.code, type: p.type, effect: p.effect })),
    assembledAt: new Date().toISOString(),
    traceId: null,
    ...(args.extra ?? {}),
    ...(task ? { task: { id: task.id, code: task.code, title: task.title, description: task.description, risk: task.risk, kind: (task.tagsJson ? safeTags(task.tagsJson).kind : 'generic') } } : {}),
  } as ContextPackage
}

function safeTags(tagsJson: string): Record<string, string> {
  try {
    const arr = JSON.parse(tagsJson)
    const out: Record<string, string> = {}
    for (const t of arr) {
      const [k, v] = String(t).split(':')
      if (k && v) out[k] = v
    }
    return out
  } catch { return {} }
}
