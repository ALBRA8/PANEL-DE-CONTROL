// ============================================================
// EEC — COMMAND PIPELINE (spec §13, §23, §36, §46)
// VALIDACIÓN → AUTORIZACIÓN → POLÍTICA → DISPATCH
// Comando = "DO THIS". Idempotencia por idempotencyKey (§46).
// Comandos de riesgo HIGH/CRITICAL requieren aprobación humana (§24).
// ============================================================
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db } from '../../../lib/db'
import { COMMAND_RISK, requiresApproval } from '../domain/types'
import { eventBus } from '../events/bus'
import { eecAls, newTrace, withTrace, currentTrace, log, recordMetric } from '../engine/observability'
import { writeAudit } from '../engine/audit'
import { getCommandSchema, isKnownCommand } from './registry'

export interface CommandInput {
  type: string
  payload?: Record<string, unknown>
  requesterId?: string
  requesterType?: 'HUMAN' | 'AGENT' | 'SYSTEM'
  idempotencyKey?: string
  /** usado internamente al reanudar tras aprobación */
  skipApprovalOnce?: boolean
  approvalId?: string
}

export interface CommandResult {
  commandId: string
  status: string
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  approvalId?: string
  duplicate?: boolean
  traceId?: string
}

type Handler = (args: {
  payload: Record<string, unknown>
  commandId: string
  requesterId?: string
  requesterType: string
  sim: boolean
  traceId: string | null
}) => Promise<Record<string, unknown>>

const globalForHandlers = globalThis as unknown as { __eecCommandHandlers?: Map<string, Handler> }
const handlers: Map<string, Handler> = globalForHandlers.__eecCommandHandlers ?? new Map()
globalForHandlers.__eecCommandHandlers = handlers

export function registerCommandHandler(type: string, handler: Handler): void {
  handlers.set(type, handler)
}

export function hasHandler(type: string): boolean {
  return handlers.has(type)
}

/** Flag global de simulación (persistido en memoria organizacional, cacheado). */
const globalForSim = globalThis as unknown as { __eecSimMode?: boolean }
export function isSimulationMode(): boolean {
  if (globalForSim.__eecSimMode !== undefined) return globalForSim.__eecSimMode
  return process.env.EEC_SIMULATION_MODE === '1'
}
export function setSimulationMode(v: boolean): void {
  globalForSim.__eecSimMode = v
}

async function readSimFlagFromDb(): Promise<void> {
  try {
    const rec = await db.memoryRecord.findFirst({
      where: { scope: 'ORGANIZATIONAL_MEMORY', tagsJson: { contains: 'system:sim_mode' } },
      orderBy: { createdAt: 'desc' },
    })
    if (rec) globalForSim.__eecSimMode = JSON.parse(rec.content).enabled === true
  } catch { /* primera ejecución */ }
}

/** Evalúa políticas activas aplicables al comando (con condiciones). */
async function evaluatePolicies(type: string, risk: string, requesterType: string, payload: Record<string, unknown>): Promise<{
  deniedBy?: string
  forcedApproval?: string
  effectiveRisk: string
}> {
  const policies = await db.policy.findMany({ where: { enabled: true, type: { in: ['RISK', 'APPROVAL', 'PERMISSION'] } } })
  let effectiveRisk = risk
  let deniedBy: string | undefined
  let forcedApproval: string | undefined
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as Record<string, number>
  for (const p of policies) {
    const actions = safeParse<string[]>(p.actionJson, [])
    const subjects = safeParse<Record<string, unknown>>(p.subjectJson, {})
    const appliesType = actions.length === 0 || actions.includes(type) || actions.includes('*')
    const appliesSubject = !subjects.requesterType || subjects.requesterType === requesterType
    if (!appliesType || !appliesSubject) continue
    const cond = safeParse<Record<string, unknown>>(p.conditionsJson, {})

    if (p.effect === 'DENY') {
      // condiciones soportadas: classification (coincide con payload.classification)
      if (typeof cond.classification === 'string' && payload?.classification !== cond.classification) continue
      deniedBy = p.code
      break
    }
    if (p.effect === 'REQUIRE_APPROVAL') {
      if (p.type === 'RISK') {
        // umbral de riesgo: gatea solo a AGENTES (humanos tienen autoridad implícita; SYSTEM es motor interno)
        if (requesterType === 'AGENT') {
          const minRank = typeof cond.minRiskRank === 'number' ? cond.minRiskRank : 2
          if ((rank[effectiveRisk] ?? 0) >= minRank) forcedApproval = p.code
        }
      } else {
        // política APPROVAL explícita: gatea humanos y agentes (nunca SYSTEM interno)
        if (requesterType !== 'SYSTEM') forcedApproval = p.code
      }
    }
  }
  return { deniedBy, forcedApproval, effectiveRisk }
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try { return JSON.parse(json || '') as T } catch { return fallback }
}

/**
 * Punto de entrada ÚNICO para ejecutar comandos en el EEC.
 */
export async function dispatchCommand(input: CommandInput): Promise<CommandResult> {
  await readSimFlagFromDb()
  const sim = isSimulationMode()
  const requesterType = input.requesterType ?? 'HUMAN'
  const requesterId = input.requesterId ?? (requesterType === 'HUMAN' ? 'operator' : requesterType === 'SYSTEM' ? 'eec:system' : 'unknown')
  const trace = newTrace({ sim })
  const correlationId = trace.correlationId

  // ---------- IDEMPOTENCIA (§46) ----------
  if (input.idempotencyKey) {
    const dup = await db.commandRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
    if (dup && (dup.status === 'EXECUTED' || dup.status === 'DISPATCHED' || dup.status === 'REJECTED')) {
      return {
        commandId: dup.id, status: 'DUPLICATE', ok: dup.status === 'EXECUTED',
        result: safeParse(dup.resultJson ?? undefined, {} as Record<string, unknown>),
        error: dup.rejectionReason ?? undefined, duplicate: true,
        traceId: dup.traceId ?? undefined,
      }
    }
  }

  const cmd = await db.commandRecord.create({
    data: {
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      requesterId, requesterType,
      idempotencyKey: input.idempotencyKey,
      correlationId,
      traceId: trace.traceId,
      status: 'RECEIVED',
    },
  })

  try {
    return await withTrace({ ...trace, correlationId }, async () => {
      // ---------- 1. VALIDACIÓN ----------
      if (!isKnownCommand(input.type)) {
        return reject(cmd.id, `unknown_command:${input.type}`, cmd)
      }
      const schema = getCommandSchema(input.type) as z.ZodTypeAny
      let payload: Record<string, unknown>
      try {
        payload = schema.parse(input.payload ?? {}) as Record<string, unknown>
      } catch (err) {
        const msg = err instanceof z.ZodError ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err)
        return reject(cmd.id, `validation_failed: ${msg}`, cmd)
      }
      await db.commandRecord.update({ where: { id: cmd.id }, data: { status: 'VALIDATED' } })

      // ---------- 2. AUTORIZACIÓN (§23, §25) ----------
      if (requesterType === 'AGENT') {
        const perm = await db.permission.findFirst({
          where: { agentId: requesterId, capability: `command.${input.type}`, effect: 'ALLOW' },
        })
        const denies = await db.policy.count({ where: { enabled: true, type: 'PERMISSION', effect: 'DENY', actionJson: { contains: input.type } } })
        if (!perm || denies > 0) {
          await eventBus.publish({
            event_type: 'system.permission.denied',
            source: 'eec.pipeline',
            subject: `agent:${requesterId}`,
            payload: { commandType: input.type, requesterId, reason: 'no_permission' },
            sim,
          })
          await writeAudit({
            actorId: requesterId, actorType: 'AGENT', action: `command.${input.type}.denied`,
            entityType: 'COMMAND', entityId: cmd.id, input: payload, result: 'DENIED',
            why: 'el agente carece del permiso command.' + input.type,
          })
          return reject(cmd.id, 'permission_denied', cmd, true)
        }
      }
      await db.commandRecord.update({ where: { id: cmd.id }, data: { status: 'AUTHORIZED' } })

      // ---------- 3. POLÍTICA + RIESGO (§26) ----------
      const catalogRisk = COMMAND_RISK[input.type] ?? 'MEDIUM'
      const { deniedBy, forcedApproval, effectiveRisk } = await evaluatePolicies(input.type, catalogRisk, requesterType, payload)
      if (deniedBy) {
        await eventBus.publish({
          event_type: 'system.policy.denied',
          source: 'eec.pipeline',
          subject: `command:${cmd.id}`,
          payload: { commandType: input.type, policy: deniedBy, requesterId },
          sim,
        })
        return reject(cmd.id, `policy_denied:${deniedBy}`, cmd, true)
      }
      const needsApproval = !input.skipApprovalOnce && requesterType !== 'SYSTEM' &&
        (forcedApproval !== undefined || (requiresApproval(effectiveRisk) && requesterType !== 'HUMAN'))
      await db.commandRecord.update({
        where: { id: cmd.id },
        data: { status: 'POLICY_CHECKED', risk: effectiveRisk },
      })

      // ---------- GATE DE APROBACIÓN HUMANA (§24) ----------
      if (needsApproval) {
        const approval = await db.approval.create({
          data: {
            requestType: 'COMMAND_APPROVAL',
            subjectType: 'COMMAND',
            subjectId: cmd.id,
            title: `Aprobación requerida: ${input.type}`,
            description: `El comando ${input.type} (riesgo ${effectiveRisk}) requiere aprobación humana.`,
            risk: effectiveRisk,
            payloadJson: JSON.stringify({ commandType: input.type, payload, effectiveRisk }),
            requestedById: requesterId,
            expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
          },
        })
        await db.commandRecord.update({
          where: { id: cmd.id },
          data: { requiredApprovalId: approval.id },
        })
        await eventBus.publish({
          event_type: 'approval.requested',
          source: 'eec.pipeline',
          subject: `approval:${approval.id}`,
          payload: { approvalId: approval.id, commandType: input.type, risk: effectiveRisk, commandId: cmd.id, title: approval.title },
          sim,
        })
        await recordMetric('eec.approvals.requested', 1, { command: input.type })
        return { commandId: cmd.id, status: 'POLICY_CHECKED', ok: false, approvalId: approval.id, error: 'approval_required', traceId: trace.traceId }
      }

      // ---------- 4. DISPATCH ----------
      return executeCommand(cmd.id, input.type, payload, requesterId, requesterType, sim, cmd, input.approvalId)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.commandRecord.update({
      where: { id: cmd.id }, data: { status: 'FAILED', rejectionReason: msg.slice(0, 500) },
    }).catch(() => undefined)
    return { commandId: cmd.id, status: 'FAILED', ok: false, error: msg, traceId: trace.traceId }
  }
}

/** Ejecuta el handler del comando (fase DISPATCH). */
async function executeCommand(
  commandId: string, type: string, payload: Record<string, unknown>,
  requesterId: string, requesterType: string, sim: boolean,
  cmdRow?: { traceId: string | null }, approvalId?: string,
): Promise<CommandResult> {
  await db.commandRecord.update({ where: { id: commandId }, data: { status: 'DISPATCHED' } })
  const handler = handlers.get(type)
  if (!handler) {
    return reject(commandId, `no_handler:${type}`, undefined, true)
  }
  try {
    const result = await handler({ payload, commandId, requesterId, requesterType, sim, traceId: cmdRow?.traceId ?? null })
    await db.commandRecord.update({
      where: { id: commandId },
      data: { status: 'EXECUTED', resultJson: JSON.stringify(result ?? {}), executedAt: new Date(), sim },
    })
    await eventBus.publish({
      event_type: 'system.command.executed',
      source: 'eec.pipeline',
      subject: `command:${commandId}`,
      payload: { commandType: type, requesterId, requesterType, approvalId, result },
      sim,
    })
    await recordMetric('eec.commands.executed', 1, { type })
    return { commandId, status: 'EXECUTED', ok: true, result, traceId: cmdRow?.traceId ?? undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.commandRecord.update({
      where: { id: commandId }, data: { status: 'FAILED', rejectionReason: msg.slice(0, 500), executedAt: new Date() },
    }).catch(() => undefined)
    await eventBus.publish({
      event_type: 'system.command.failed',
      source: 'eec.pipeline',
      subject: `command:${commandId}`,
      payload: { commandType: type, error: msg },
      sim,
    })
    await log('ERROR', `command ${type} failed: ${msg}`, { commandId, type })
    return { commandId, status: 'FAILED', ok: false, error: msg }
  }
}

async function reject(commandId: string, reason: string, cmdRow?: { traceId: string | null }, audited = false): Promise<CommandResult> {
  await db.commandRecord.update({
    where: { id: commandId }, data: { status: 'REJECTED', rejectionReason: reason.slice(0, 500), executedAt: new Date() },
  }).catch(() => undefined)
  if (audited) {
    await writeAudit({
      actorId: 'eec:pipeline', actorType: 'COMMAND_PIPELINE', action: 'command.rejected',
      entityType: 'COMMAND', entityId: commandId, result: 'REJECTED', why: reason,
    })
  }
  return { commandId, status: 'REJECTED', ok: false, error: reason, traceId: cmdRow?.traceId ?? undefined }
}

/**
 * Reanuda un comando que estaba pendiente de aprobación (skipApprovalOnce).
 * Llamado por approval.approve.
 */
export async function resumeApprovedCommand(commandId: string, approvalId: string): Promise<CommandResult> {
  const cmd = await db.commandRecord.findUnique({ where: { id: commandId } })
  if (!cmd) return { commandId, status: 'FAILED', ok: false, error: 'command_not_found' }
  const payload = JSON.parse(cmd.payloadJson || '{}')
  return withTrace(newTrace({ sim: isSimulationMode(), correlationId: cmd.correlationId ?? undefined, traceId: cmd.traceId ?? undefined }), () =>
    executeCommand(cmd.id, cmd.type, payload, cmd.requesterId ?? 'operator', cmd.requesterType, cmd.sim, { traceId: cmd.traceId }, approvalId),
  )
}

/** Contexto de traza para handlers que desean propagar correlación. */
export function commandTrace() {
  return currentTrace()
}
