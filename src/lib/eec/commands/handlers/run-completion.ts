// ============================================================
// EEC — RUN COMPLETION: RESULT → EVALUATION → PASS/FAIL/REVIEW (§29)
// Calidad: REVIEW → QUALITY_REVIEW → DONE (o intervención humana).
// Al completar la tarea, el workflow avanza (§21).
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { setAgentState, setAgentActivity, setTaskState } from '../../engine/state'
import { evaluateRunResult } from '../../engine/evaluation'
import { memoryService } from '../../engine/memory'
import { advanceWorkflowForTask } from './workflow-handlers'

export async function completeWithEvaluationInner(args: {
  runId: string; taskId: string; agentId: string; outputs: Record<string, unknown>;
  latencyMs: number; sim?: boolean;
}): Promise<{ verdict: string; taskStatus: string }> {
  const run = await db.run.findUnique({ where: { id: args.runId } })
  const task = await db.task.findUnique({ where: { id: args.taskId } })
  if (!run || !task) throw new Error('RUN_OR_TASK_NOT_FOUND')

  const cost = Number(JSON.parse(run.contextJson || '{}').estimatedCost ?? 0.02)
  const evaluation = await evaluateRunResult({
    runId: run.id, taskId: task.id, agentId: args.agentId,
    outputs: args.outputs, latencyMs: args.latencyMs, cost,
    mode: 'RULE_BASED', sim: args.sim,
  })

  await db.run.update({
    where: { id: run.id },
    data: {
      status: evaluation.verdict === 'FAIL' ? 'FAILED' : 'SUCCEEDED',
      outputsJson: JSON.stringify(args.outputs),
      progress: 100, completedAt: new Date(),
      error: evaluation.verdict === 'FAIL' ? evaluation.notes : null,
    },
  })
  await eventBus.publish({
    event_type: evaluation.verdict === 'FAIL' ? 'run.failed' : 'run.succeeded',
    source: 'eec.runs', subject: `run:${run.id}`,
    payload: { runId: run.id, taskId: task.id, verdict: evaluation.verdict, outputs: args.outputs },
    sim: args.sim,
  })

  // liberar agente
  await db.agent.updateMany({ where: { id: args.agentId, currentTaskId: task.id }, data: { currentTaskId: null } })
  const agent = await db.agent.findUnique({ where: { id: args.agentId } })
  if (agent && agent.state === 'WORKING') {
    await setAgentActivity(agent.id, 'Finalizando tarea…', args.sim)
    await setAgentState(agent.id, 'IDLE', 'run completado', { sim: args.sim, activity: 'Disponible' }).catch(() => undefined)
  }

  // memoria episódica con provenance (§18)
  await memoryService().write({
    agentId: args.agentId,
    scope: 'LONG_TERM_MEMORY',
    kind: 'SUMMARY',
    content: `Tarea ${task.code} "${task.title}" completada con veredicto ${evaluation.verdict}. Resumen: ${String(args.outputs.summary ?? '').slice(0, 180)}`,
    importance: evaluation.verdict === 'PASS' ? 7 : 8,
    provenance: { runId: run.id, taskId: task.id, evaluation: evaluation.mode },
    tags: ['task', task.code, evaluation.verdict],
  }).catch(() => undefined)

  // flujo de calidad
  let taskStatus = task.status
  if (evaluation.verdict === 'PASS') {
    await setTaskState(task.id, 'REVIEW', 'run PASS → revisión', args.sim)
    await setTaskState(task.id, 'QUALITY_REVIEW', 'auto quality gate', args.sim)
    if (evaluation.scores.quality >= 0.8 && evaluation.scores.completeness >= 0.5) {
      await setTaskState(task.id, 'DONE', 'quality gate PASS', args.sim, { resultJson: args.outputs })
      taskStatus = 'DONE'
      await eventBus.publish({
        event_type: 'task.completed', source: 'eec.quality', subject: `task:${task.id}`,
        payload: { taskId: task.id, code: task.code, by: 'quality_gate', runId: run.id },
        sim: args.sim,
      })
      await eventBus.publish({
        event_type: 'task.quality_review.passed', source: 'eec.quality', subject: `task:${task.id}`,
        payload: { taskId: task.id, runId: run.id }, sim: args.sim,
      })
      // el workflow avanza al completarse la tarea (§21)
      if (task.workflowId) {
        await advanceWorkflowForTask(task.workflowId, task.id, args.sim)
      }
    } else {
      taskStatus = 'QUALITY_REVIEW'
      await eventBus.publish({
        event_type: 'task.quality_review.requested', source: 'eec.quality', subject: `task:${task.id}`,
        payload: { taskId: task.id, runId: run.id, note: 'requiere revisión humana' }, sim: args.sim,
      })
    }
  } else if (evaluation.verdict === 'REVIEW') {
    await setTaskState(task.id, 'REVIEW', 'run REVIEW → humana', args.sim)
    taskStatus = 'REVIEW'
    await eventBus.publish({
      event_type: 'task.review.required', source: 'eec.quality', subject: `task:${task.id}`,
      payload: { taskId: task.id, runId: run.id }, sim: args.sim,
    })
  } else {
    await setTaskState(task.id, 'FAILED', 'evaluación FAIL', args.sim)
    taskStatus = 'FAILED'
    await eventBus.publish({
      event_type: 'task.failed', source: 'eec.quality', subject: `task:${task.id}`,
      payload: { taskId: task.id, runId: run.id, notes: evaluation.notes }, sim: args.sim,
    })
  }

  return { verdict: evaluation.verdict, taskStatus }
}
