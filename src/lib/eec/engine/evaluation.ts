// ============================================================
// EEC — EVALUATION & QUALITY (spec §29)
// RESULT → EVALUATION → PASS / FAIL / REVIEW
// Modos: RULE_BASED | MODEL_BASED | HUMAN | HYBRID
// Dimensiones: quality accuracy completeness compliance consistency latency cost
// ============================================================
import { eventBus } from '../events/bus'
import { writeAudit } from './audit'
import type { EvaluationVerdict } from '../domain/types'

export interface EvaluationResult {
  verdict: EvaluationVerdict
  mode: string
  scores: Record<string, number>
  notes: string
}

export async function evaluateRunResult(args: {
  runId: string
  taskId?: string | null
  agentId?: string | null
  outputs: Record<string, unknown>
  latencyMs?: number
  cost?: number
  mode?: string
  sim?: boolean
}): Promise<EvaluationResult> {
  const mode = args.mode ?? 'RULE_BASED'
  const scores: Record<string, number> = {}

  // ---- RULE_BASED: reglas objetivas ----
  const outStr = JSON.stringify(args.outputs ?? {})
  scores.completeness = Object.keys(args.outputs ?? {}).length === 0 ? 0 : Math.min(1, Object.keys(args.outputs ?? {}).length / 3)
  scores.quality = outStr.length > 200 ? 0.9 : outStr.length > 60 ? 0.7 : 0.4
  scores.accuracy = hasFailureKeys(args.outputs) ? 0.2 : 0.85
  scores.compliance = args.sim ? 1 : 0.9
  scores.consistency = 0.85
  scores.latency = args.latencyMs ? (args.latencyMs < 60_000 ? 1 : args.latencyMs < 300_000 ? 0.6 : 0.2) : 0.8
  scores.cost = (args.cost ?? 0) < 1 ? 1 : 0.6

  // ---- MODEL_BASED (heuristic local; un LLM real entra por ModelInterface) ----
  if (mode === 'MODEL_BASED' || mode === 'HYBRID') {
    const summary = String((args.outputs as { summary?: string }).summary ?? outStr)
    const words = summary.split(/\s+/).length
    scores.model_coherence = words > 40 ? 0.9 : words > 12 ? 0.7 : 0.35
  }

  const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(scores).length)
  let verdict: EvaluationVerdict = avg >= 0.7 ? 'PASS' : avg >= 0.5 ? 'REVIEW' : 'FAIL'

  // regla dura: outputs vacíos nunca PASS
  if (Object.keys(args.outputs ?? {}).length === 0) verdict = 'FAIL'

  // El veredicto se registra en evento + audit (reconstruible), no en tabla separada.
  await eventBus.publish({
    event_type: 'run.evaluated',
    source: 'eec.evaluation',
    subject: `run:${args.runId}`,
    payload: { runId: args.runId, taskId: args.taskId, verdict, mode, scores, average: Number(avg.toFixed(3)) },
    sim: args.sim,
  })
  await writeAudit({
    actorId: 'eec:evaluation', actorType: 'SYSTEM',
    action: 'run.evaluated', entityType: 'RUN', entityId: args.runId,
    input: { mode }, output: { verdict, scores },
    result: verdict, why: `evaluación ${mode}: media ${(avg).toFixed(2)}`,
  })

  return { verdict, mode, scores, notes: `avg=${avg.toFixed(2)}` }
}

function hasFailureKeys(outputs: Record<string, unknown>): boolean {
  return Object.entries(outputs ?? {}).some(([k, v]) => /error|failed/i.test(k) && v)
}

/** Quality review humano o por agente revisor (task QUALITY_REVIEW). */
export async function requestQualityReview(args: { runId: string; taskId: string; sim?: boolean }): Promise<void> {
  await eventBus.publish({
    event_type: 'task.quality_review.requested',
    source: 'eec.evaluation',
    subject: `task:${args.taskId}`,
    payload: { runId: args.runId, taskId: args.taskId },
    sim: args.sim,
  })
}
