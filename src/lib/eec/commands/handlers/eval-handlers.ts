// ============================================================
// EEC — HANDLERS: eval.* (P2-1 · doc 07 matriz #13)
// eval.run: ejecuta una rúbrica determinística sobre una salida y
// registra el veredicto en la escritura pública (evento + auditoría
// sellada en la cadena hash). El runner es puro regex/aritmética —
// sin LLM en el lazo de verificación.
// ============================================================
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { writeAudit } from '../../engine/audit'
import { runRubric, validateRubric, type Rubric, type RubricResult } from '../../eval/rubrics'

export function registerEvalHandlers(): void {
  registerCommandHandler('eval.run', async ({ payload, sim, requesterId, requesterType }) => {
    const p = payload as {
      label?: string
      rubric: Rubric
      output: { text: string }
    }
    const invalid = validateRubric(p.rubric)
    if (invalid) throw new Error(`EVAL_RUBRIC_INVALID:${invalid}`)

    const result: RubricResult = runRubric(p.rubric, { text: String(p.output?.text ?? '') })

    await eventBus.publish({
      event_type: 'eval.completed', source: 'eec.eval', subject: `rubric:${p.rubric.name}`,
      payload: {
        rubric: p.rubric.name, label: p.label ?? null, verdict: result.verdict,
        score: result.score, failedEssential: result.failedEssential, hitForbidden: result.hitForbidden,
        bonusEarned: result.bonusEarned, bonusMax: result.bonusMax,
      },
      sim,
    })
    await writeAudit({
      actorId: requesterId ?? 'eec:eval',
      actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      action: 'eval.run', entityType: 'EVAL', entityId: p.label ?? p.rubric.name,
      why: `Rúbrica ${p.rubric.name} → ${result.verdict} (${result.score}/100)`,
      input: {
        rubric: p.rubric.name, textLen: String(p.output?.text ?? '').length,
        essential: p.rubric.essential?.length ?? 0, forbidden: p.rubric.forbidden?.length ?? 0, bonus: p.rubric.bonus?.length ?? 0,
      },
      output: { verdict: result.verdict, score: result.score, failedEssential: result.failedEssential, hitForbidden: result.hitForbidden },
      result: result.verdict, sim,
    })
    return {
      rubric: result.rubric, verdict: result.verdict, score: result.score,
      failedEssential: result.failedEssential, hitForbidden: result.hitForbidden,
      bonusEarned: result.bonusEarned, bonusMax: result.bonusMax,
      checks: result.checks,
    }
  })
}
