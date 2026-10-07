// ============================================================
// EEC — CAPABILITY GATEWAY (spec §17)
// AGENT → TOOL REQUEST → CAPABILITY CHECK → POLICY → PERMISSION →
// RISK CHECK → TOOL EXECUTION → RESULT → EVENT → AUDIT
// MCP u otro protocolo serían adapters; el EEC permanece protocol-neutral.
// ============================================================
import { db } from '../../../lib/db'
import { eventBus } from '../events/bus'
import { writeAudit } from './audit'
import { recordMetric, log } from './observability'
import { ToolInterface, providerRegistry } from '../domain/contracts'
import { requiresApproval } from '../domain/types'

export interface GatewayRequest {
  toolCode: string
  input: Record<string, unknown>
  agentId?: string | null
  taskId?: string | null
  runId?: string | null
  requesterType?: 'AGENT' | 'HUMAN' | 'SYSTEM'
  requesterId?: string
  /** id de aprobación ya concedida para esta invocación */
  approvedById?: string | null
  sim: boolean
}

export interface GatewayResult {
  ok: boolean
  status: 'SUCCEEDED' | 'DENIED' | 'APPROVAL_REQUIRED' | 'FAILED' | 'SUPPRESSED_SIM' | 'TIMEOUT'
  output?: Record<string, unknown>
  approvalId?: string
  error?: string
  invocationId: string
}

export async function invokeTool(req: GatewayRequest): Promise<GatewayResult> {
  const tool = await db.tool.findUnique({ where: { code: req.toolCode } })
  if (!tool) {
    return { ok: false, status: 'DENIED', error: `tool_not_found:${req.toolCode}`, invocationId: '' }
  }

  const inv = await db.toolInvocation.create({
    data: {
      toolId: tool.id, toolCode: tool.code,
      agentId: req.agentId ?? null, taskId: req.taskId ?? null, runId: req.runId ?? null,
      status: 'CHECKING',
      inputJson: JSON.stringify(req.input ?? {}),
      sim: req.sim,
    },
  })

  // ---------- 1. CAPABILITY CHECK ----------
  if (tool.status !== 'AVAILABLE') {
    await finish(inv.id, 'DENIED', { error: `tool_disabled:${tool.code}` })
    return { ok: false, status: 'DENIED', error: `tool_disabled:${tool.code}`, invocationId: inv.id }
  }

  // ---------- 2. POLICY ----------
  const denyPolicy = await db.policy.findFirst({
    where: { enabled: true, type: 'PERMISSION', effect: 'DENY', actionJson: { contains: tool.code } },
  })
  if (denyPolicy && req.requesterType !== 'HUMAN') {
    await finish(inv.id, 'DENIED', { error: `policy_denied:${denyPolicy.code}` })
    await publishDenied(inv.id, tool.code, req, `policy_denied:${denyPolicy.code}`)
    return { ok: false, status: 'DENIED', error: `policy_denied:${denyPolicy.code}`, invocationId: inv.id }
  }

  // ---------- 3. PERMISSION ----------
  if (req.agentId && req.requesterType !== 'HUMAN') {
    const perm = await db.permission.findFirst({
      where: { agentId: req.agentId, effect: 'ALLOW', capability: { contains: `tool.${tool.code}` } },
    })
    const toolPerms = safeArr(tool.permissionsJson)
    const needsPerm = toolPerms.length > 0
    if (needsPerm && !perm) {
      await finish(inv.id, 'DENIED', { error: 'permission_denied' })
      await publishDenied(inv.id, tool.code, req, 'permission_denied')
      return { ok: false, status: 'DENIED', error: 'permission_denied', invocationId: inv.id }
    }
  }

  // ---------- 4. RISK CHECK ----------
  const riskOverride = await db.policy.findFirst({
    where: { enabled: true, type: 'RISK', effect: 'REQUIRE_APPROVAL', actionJson: { contains: tool.code } },
  })
  const effectiveRisk = riskOverride ? 'HIGH' : tool.risk
  if (requiresApproval(effectiveRisk) && !req.approvedById && req.requesterType !== 'HUMAN') {
    const { dispatchCommand } = await import('../commands/pipeline')
    const res = await dispatchCommand({
      type: 'approval.request',
      requesterType: 'SYSTEM',
      requesterId: 'eec:capability-gateway',
      payload: {
        requestType: 'TOOL_INVOCATION',
        title: `Tool de riesgo ${effectiveRisk}: ${tool.code}`,
        description: `Invocación de ${tool.code} requiere aprobación humana (riesgo ${effectiveRisk}).`,
        subjectType: 'TOOL_INVOCATION',
        subjectId: inv.id,
        risk: effectiveRisk,
        payload: { toolCode: tool.code, input: req.input, agentId: req.agentId, runId: req.runId },
      },
      idempotencyKey: `tool-approval:${inv.id}`,
    })
    await db.toolInvocation.update({ where: { id: inv.id }, data: { status: 'CHECKS_FAILED' } }).catch(() => undefined)
    // el estado queda en REQUESTED→ la ToolInvocation queda pausada; al aprobar se re-invoca con approvedById
    await db.toolInvocation.update({ where: { id: inv.id }, data: { status: 'REQUESTED' } }).catch(() => undefined)
    return { ok: false, status: 'APPROVAL_REQUIRED', approvalId: res.approvalId, invocationId: inv.id }
  }

  // ---------- 5. EXECUTION ----------
  await db.toolInvocation.update({ where: { id: inv.id }, data: { status: 'EXECUTING' } })
  const started = Date.now()
  let adapter: ToolInterface
  try {
    adapter = providerRegistry.get<ToolInterface>('TOOL', tool.provider)
  } catch {
    adapter = providerRegistry.get<ToolInterface>('TOOL', 'builtin')
  }

  let output: Record<string, unknown>
  let ok = true
  let simulated = false
  try {
    const res = await Promise.race([
      adapter.execute(req.input ?? {}, {
        toolCode: tool.code, agentId: req.agentId, runId: req.runId, taskId: req.taskId,
        simulation: req.sim, traceId: null,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tool_timeout')), tool.timeoutMs)),
    ])
    output = res.output
    ok = res.ok
    simulated = !!res.simulated
    if (res.error) ok = false
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latency = Date.now() - started
    const status = msg === 'tool_timeout' ? 'TIMEOUT' : 'FAILED'
    await finish(inv.id, status, { error: msg, latencyMs: latency })
    await eventBus.publish({
      event_type: 'tool.failed',
      source: 'eec.gateway',
      subject: `tool:${tool.code}`,
      payload: { invocationId: inv.id, toolCode: tool.code, error: msg, agentId: req.agentId },
      sim: req.sim,
    })
    await writeAudit({
      actorId: req.agentId ?? req.requesterId ?? 'system', actorType: (req.requesterType as 'AGENT' | 'HUMAN' | 'SYSTEM') ?? 'SYSTEM',
      action: `tool.${tool.code}.failed`, entityType: 'TOOL_INVOCATION', entityId: inv.id,
      input: req.input, result: status, tools: [tool.code], why: msg,
    })
    return { ok: false, status: status as 'TIMEOUT' | 'FAILED', error: msg, invocationId: inv.id }
  }

  const latencyMs = Date.now() - started
  const finalStatus = ok ? (simulated ? 'SUPPRESSED_SIM' : 'SUCCEEDED') : 'FAILED'
  await db.toolInvocation.update({
    where: { id: inv.id },
    data: {
      status: finalStatus,
      outputJson: JSON.stringify(output ?? {}),
      latencyMs, cost: tool.costEstimate,
      completedAt: new Date(), approvedById: req.approvedById ?? null,
    },
  })

  // ---------- 6. EVENT ----------
  await eventBus.publish({
    event_type: ok ? 'tool.executed' : 'tool.failed',
    source: 'eec.gateway',
    subject: `tool:${tool.code}`,
    payload: { invocationId: inv.id, toolCode: tool.code, agentId: req.agentId, runId: req.runId, taskId: req.taskId, ok, simulated, latencyMs, output },
    sim: req.sim || simulated,
  })

  // ---------- 7. AUDIT ----------
  await writeAudit({
    actorId: req.agentId ?? req.requesterId ?? 'system',
    actorType: (req.requesterType as 'AGENT' | 'HUMAN' | 'SYSTEM') ?? 'SYSTEM',
    action: `tool.${tool.code}.${ok ? 'executed' : 'failed'}`,
    entityType: 'TOOL_INVOCATION', entityId: inv.id,
    input: req.input, output, tools: [tool.code],
    permissions: [{ tool: tool.code, risk: tool.risk, approved: !!req.approvedById }],
    result: finalStatus, cost: tool.costEstimate,
  })
  await recordMetric('eec.tool.latency_ms', latencyMs, { tool: tool.code }, 'ms')

  return { ok, status: finalStatus as GatewayResult['status'], output, invocationId: inv.id }
}

async function finish(invocationId: string, status: string, extra?: { error?: string; latencyMs?: number }): Promise<void> {
  await db.toolInvocation.update({
    where: { id: invocationId },
    data: { status, ...(extra?.error ? { error: extra.error } : {}), ...(extra?.latencyMs ? { latencyMs: extra.latencyMs } : {}), completedAt: new Date() },
  }).catch(() => undefined)
}

async function publishDenied(invocationId: string, toolCode: string, req: GatewayRequest, reason: string): Promise<void> {
  await eventBus.publish({
    event_type: 'tool.denied',
    source: 'eec.gateway',
    subject: `tool:${toolCode}`,
    payload: { invocationId, toolCode, agentId: req.agentId, reason },
    sim: req.sim,
  })
  await log('WARN', `tool ${toolCode} denied: ${reason}`, { invocationId })
}

function safeArr(json: string): string[] {
  try { return JSON.parse(json) } catch { return [] }
}
