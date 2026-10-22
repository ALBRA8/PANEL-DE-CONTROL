// ============================================================
// EEC — BOOT: registro de providers y arranque de workers.
// Idempotente (guard global) — sobrevive HMR del dev server.
// ============================================================
import { providerRegistry } from './domain/contracts'
import { LocalSimAgentAdapter, LocalOrchestratorAdapter, LocalRuntimeAdapter, BuiltinToolsAdapter } from './providers/adapters/local-sim'
import { LocalProcessAgentAdapter, reconcileProcessesAfterBoot } from './providers/adapters/local-process'
import { HttpAgentAdapter } from './providers/adapters/http-agent'
import { HttpInstaladorAdapter, UnavailableInstaladorAdapter } from './providers/adapters/instalador'
import { ensureHandlersRegistered, setSimulationMode } from './commands'
import { startWorkers } from './engine/workers'
import { db } from '../db'

const globalForBoot = globalThis as unknown as { __eecBooted?: boolean }

export async function bootEEC(): Promise<void> {
  if (globalForBoot.__eecBooted) return
  globalForBoot.__eecBooted = true

  // ---------- PROVIDER REGISTRY (§43) — adapters por defecto ----------
  if (providerRegistry.list('AGENT').length === 0) {
    providerRegistry.register('AGENT', 'local-sim', new LocalSimAgentAdapter(), { isDefault: true, adapter: 'LocalSimAgentAdapter' })
  }
  if (providerRegistry.list('ORCHESTRATOR').length === 0) {
    providerRegistry.register('ORCHESTRATOR', 'local', new LocalOrchestratorAdapter(), { isDefault: true, adapter: 'LocalOrchestratorAdapter' })
  }
  if (providerRegistry.list('RUNTIME').length === 0) {
    providerRegistry.register('RUNTIME', 'local', new LocalRuntimeAdapter(), { isDefault: true, adapter: 'LocalRuntimeAdapter' })
  }
  if (providerRegistry.list('TOOL').length === 0) {
    providerRegistry.register('TOOL', 'builtin', new BuiltinToolsAdapter(), { isDefault: true, adapter: 'BuiltinToolsAdapter' })
  }
  // ---------- RUNTIMES REALES (EEC V2 §4) — NO default: requieren manifiesto
  // válido y credenciales; jamás sustituyen silenciosamente a la simulación ----------
  if (!providerRegistry.list('AGENT').some(p => p.key === 'local-process')) {
    providerRegistry.register('AGENT', 'local-process', new LocalProcessAgentAdapter(), { adapter: 'LocalProcessAgentAdapter' })
  }
  if (!providerRegistry.list('AGENT').some(p => p.key === 'http-agent')) {
    providerRegistry.register('AGENT', 'http-agent', new HttpAgentAdapter(), { adapter: 'HttpAgentAdapter' })
  }
  // ---------- FRONTERA INSTALADOR (EEC V2 §7) — honesta por defecto ----------
  if (providerRegistry.list('LIFECYCLE').length === 0) {
    if (process.env.EEC_INSTALLADOR_URL) {
      providerRegistry.register('LIFECYCLE', 'instalador-http', new HttpInstaladorAdapter(), { isDefault: true, adapter: 'HttpInstaladorAdapter' })
    } else {
      providerRegistry.register('LIFECYCLE', 'instalador-unavailable', new UnavailableInstaladorAdapter(), { isDefault: true, adapter: 'UnavailableInstaladorAdapter' })
    }
  }
  // MODEL / MEMORY / KNOWLEDGE / NOTIFICATION / STORAGE: defaults embebidos se
  // resuelven en sus servicios; providers reales se registran aquí vía adapters.

  // ---------- comandos ----------
  ensureHandlersRegistered()

  // ---------- modo simulación persistido ----------
  try {
    const rec = await db.memoryRecord.findFirst({
      where: { scope: 'ORGANIZATIONAL_MEMORY', tagsJson: { contains: 'system:sim_mode' } },
      orderBy: { createdAt: 'desc' },
    })
    if (rec) {
      setSimulationMode(JSON.parse(rec.content).enabled === true)
    } else {
      setSimulationMode(process.env.EEC_SIMULATION_MODE !== '0')
    }
  } catch {
    setSimulationMode(process.env.EEC_SIMULATION_MODE !== '0')
  }

  // ---------- workers (heartbeat, scheduler, runtime loop…) ----------
  startWorkers()

  // ---------- reconciliación de ejecuciones reales tras reinicio (EEC V2 §5.12) ----------
  // Los runs de adaptadores reales que sobrevivieron a un reinicio sin resultado
  // validado quedan UNRECONCILED (nunca "completado" inventado).
  try {
    const rec = await reconcileProcessesAfterBoot()
    if (rec.reattached || rec.unreconciled) {
      console.log(`[EEC] reconciliación post-boot: ${rec.reattached} re-adjuntado(s), ${rec.unreconciled} UNRECONCILED`)
    }
  } catch { /* la BD puede aún no tener la tabla en primeros arranques */ }

  // ---------- registro de providers en DB para observabilidad (§43) ----------
  for (const p of providerRegistry.list()) {
    await db.provider.upsert({
      where: { key: `${p.type}:${p.key}` },
      create: {
        key: `${p.type}:${p.key}`, name: `${p.type}:${p.key}`, type: p.type,
        adapter: p.adapter, status: 'AVAILABLE', isDefault: p.isDefault,
        configJson: '{}',
      },
      update: { status: 'AVAILABLE', adapter: p.adapter },
    }).catch(() => undefined)
  }

  console.log('[EEC] boot completo — control plane operativo')
}

export async function ensureBoot(): Promise<void> {
  await bootEEC()
}
