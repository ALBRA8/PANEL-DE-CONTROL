// ============================================================
// EEC — LOCAL SIM ADAPTERS (spec §3, §15, §16, §17, §43)
//
// Adaptadores por defecto del modo simulación:
//   AGENT        → LocalSimAgentAdapter    (tick determinista, sin LLM)
//   ORCHESTRATOR → LocalOrchestratorAdapter (submit/status herméticos)
//   RUNTIME      → LocalRuntimeAdapter
//   TOOL         → BuiltinToolsAdapter      (tools builtin, sin efectos reales)
//
// Honestidad de simulación: nada de esto fabrica actividad real.
// El progreso avanza de forma determinista, los nodos se derivan del
// progreso real del run, las tools marcan simulated:true y email.send
// queda SUPPRESSED_SIM (nunca sale un correo real).
// ============================================================
import type {
  AgentInterface, AgentTickContext, AgentTickResult,
  OrchestrationInterface, OrchestrationSpec,
  RuntimeInterface,
  ToolInterface, ToolExecutionContext, ToolExecutionOutput,
} from '../../domain/contracts'

// ---------------- AGENT: tick determinista ----------------
// Tramos de avance por tick: arranque rápido → meseta → cierre fino.
const STEP_START = 18 // progreso < 45
const STEP_MID = 9 // 45 ≤ progreso < 80
const STEP_END = 7 // progreso ≥ 80

/** Nodo derivado del progreso REAL del run (nunca inventado). */
function nextNode(progress: number): string {
  if (progress < 20) return 'INTAKE'
  if (progress < 50) return 'PLAN'
  if (progress < 80) return 'EXECUTE'
  if (progress < 95) return 'VERIFY'
  return 'REPORT'
}

const NODE_VERB: Record<string, string> = {
  INTAKE: 'Procesando entrada',
  PLAN: 'Planificando enfoque',
  EXECUTE: 'Ejecutando trabajo',
  VERIFY: 'Verificando resultados',
  REPORT: 'Redactando reporte final',
}

export class LocalSimAgentAdapter implements AgentInterface {
  readonly providerKey = 'local-sim'

  async tick(ctx: AgentTickContext): Promise<AgentTickResult> {
    const prev = Math.max(0, Math.min(100, Number(ctx.progress) || 0))
    const step = prev < 45 ? STEP_START : prev < 80 ? STEP_MID : STEP_END
    const progress = prev >= 100 ? 100 : Math.min(100, prev + step)
    const node = nextNode(progress)
    const done = progress >= 100

    // ---- cruce del 50%: única invocación de tool LOW-risk ----
    // Determinista y sin estado: dispara solo en el tick que cruza 50
    // (prev < 50 ∧ nuevo ≥ 50), pasando por el Capability Gateway
    // completo (capability → policy → risk → tool). Import dinámico
    // para evitar el ciclo adapter → gateway en tiempo de carga.
    let toolNote: string | null = null
    if (prev < 50 && progress >= 50) {
      try {
        const { invokeTool } = await import('../../engine/gateway')
        const res = await invokeTool({
          toolCode: 'web.search',
          input: { query: `${ctx.agentCode}: referencias para la tarea en curso` },
          agentId: ctx.agentId, runId: ctx.runId, taskId: ctx.taskId ?? null,
          requesterType: 'AGENT', requesterId: ctx.agentId,
          sim: ctx.simulation,
        })
        toolNote = `web.search@50%:${res.status}`
      } catch {
        // Honesto: el intento ya quedó registrado en ToolInvocation/auditoría.
        toolNote = 'web.search@50%:ERROR'
      }
    }

    const outputs: Record<string, unknown> = {}
    if (toolNote) outputs.toolAt50 = toolNote
    if (done) outputs.report = 'Entregable generado por LocalSimAgentAdapter (simulación determinista)'

    return {
      done,
      progress,
      currentNode: node,
      activity: done
        ? 'Completado — entregable listo'
        : `${NODE_VERB[node] ?? 'Trabajando'} (${progress}%)`,
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
    }
  }

  async health(agentId: string): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: `local-sim:${agentId}:ok` }
  }
}

// ---------------- ORCHESTRATOR: hermético local ----------------
// El ciclo de vida real de un run lo gobiernan los comandos run.* del
// EEC; el orquestador local solo sella la delegación.
export class LocalOrchestratorAdapter implements OrchestrationInterface {
  readonly providerKey = 'local'

  async submit(spec: OrchestrationSpec): Promise<{ orchestrationId: string }> {
    return { orchestrationId: `orch-local:${spec.runId}` }
  }

  async status(orchestrationId: string): Promise<{ state: string; detail?: Record<string, unknown> }> {
    return {
      state: 'DELEGATED_TO_EEC',
      detail: { orchestrationId, note: 'orquestación delegada al runtime loop del EEC' },
    }
  }

  async cancel(): Promise<void> { /* comandos run.cancel gobiernan el ciclo real */ }
  async pause(): Promise<void> { /* comandos run.pause */ }
  async resume(): Promise<void> { /* comandos run.resume */ }
  async retry(): Promise<void> { /* comandos run.retry */ }
  async result(): Promise<Record<string, unknown> | null> { return null }
}

// ---------------- RUNTIME: local ----------------
// El estado persistente del runtime lo manejan los comandos runtime.*
// (transiciones STARTING→RUNNING→…); el adapter representa la acción
// del proveedor en sí. Aquí es local: registrar y responder.
export class LocalRuntimeAdapter implements RuntimeInterface {
  readonly providerKey = 'local'

  async start(runtimeId: string): Promise<void> {
    console.log(`[EEC:RUNTIME-ADAPTER] start ${runtimeId} (local)`)
  }
  async stop(runtimeId: string): Promise<void> {
    console.log(`[EEC:RUNTIME-ADAPTER] stop ${runtimeId} (local)`)
  }
  async restart(runtimeId: string): Promise<void> {
    console.log(`[EEC:RUNTIME-ADAPTER] restart ${runtimeId} (local)`)
  }
  async recover(runtimeId: string): Promise<void> {
    console.log(`[EEC:RUNTIME-ADAPTER] recover ${runtimeId} (local)`)
  }
}

// ---------------- TOOL: builtin simuladas ----------------
// Herramientas por defecto sin efectos externos reales. Cada salida es
// determinista y está marcada simulated:true. email.send queda siempre
// suprimido: la simulación honesta nunca envía comunicaciones reales.
export class BuiltinToolsAdapter implements ToolInterface {
  readonly providerKey = 'builtin'

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionOutput> {
    switch (ctx.toolCode) {
      case 'web.search': {
        const q = String(input.query ?? '')
        return {
          ok: true,
          simulated: true,
          output: {
            query: q,
            results: [
              { title: `Referencia A — ${q}`, url: 'https://example.com/a', snippet: 'Resultado simulado (sin acceso a red real).' },
              { title: `Referencia B — ${q}`, url: 'https://example.com/b', snippet: 'Resultado simulado (sin acceso a red real).' },
              { title: `Referencia C — ${q}`, url: 'https://example.com/c', snippet: 'Resultado simulado (sin acceso a red real).' },
            ],
          },
        }
      }
      case 'report.generate':
        return {
          ok: true,
          simulated: true,
          output: {
            reportId: `rep-${ctx.runId ?? 'adhoc'}`,
            format: 'markdown',
            sections: ['Resumen', 'Hallazgos', 'Siguientes pasos'],
          },
        }
      case 'email.send':
        // SUPPRESSED_SIM — el modo simulación nunca envía correos reales.
        return {
          ok: true,
          simulated: true,
          output: {
            suppressed: true,
            reason: 'SUPPRESSED_SIM — modo simulación: no se envía correo real',
            to: input.to ?? null,
            subject: input.subject ?? null,
          },
        }
      case 'crm.update':
        return {
          ok: true,
          simulated: true,
          output: {
            entity: input.entity ?? 'contact',
            updated: true,
            fields: Object.keys(input).filter(k => k !== 'entity'),
          },
        }
      case 'calendar.check':
        return {
          ok: true,
          simulated: true,
          output: { slots: ['mañana 10:00', 'mañana 15:30', 'pasado mañana 09:00'], timezone: 'UTC' },
        }
      default:
        return { ok: false, output: {}, error: `unknown_tool:${ctx.toolCode}` }
    }
  }
}
