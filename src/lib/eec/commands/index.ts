// ============================================================
// EEC — COMMANDS ENTRYPOINT
// Importar este módulo registra TODOS los handlers en el pipeline.
// ============================================================
import { registerAgentHandlers } from './handlers/agent-handlers'
import { registerTaskHandlers } from './handlers/task-handlers'
import { registerWorkflowHandlers } from './handlers/workflow-handlers'
import { registerCollabHandlers } from './handlers/collab-handlers'
import { registerBizHandlers } from './handlers/biz-handlers'

const globalForReg = globalThis as unknown as { __eecHandlersRegistered?: boolean }

export function ensureHandlersRegistered(): void {
  if (globalForReg.__eecHandlersRegistered) return
  registerAgentHandlers()
  registerTaskHandlers()
  registerWorkflowHandlers()
  registerCollabHandlers()
  registerBizHandlers()
  globalForReg.__eecHandlersRegistered = true
}

ensureHandlersRegistered()

export { dispatchCommand, isSimulationMode, setSimulationMode } from './pipeline'
export { COMMAND_SCHEMAS, isKnownCommand } from './registry'
