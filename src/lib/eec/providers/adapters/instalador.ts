// ============================================================
// EEC — ADAPTADORES DE LA FRONTERA INSTALADOR (§7)
//
// HttpInstaladorAdapter: cliente del INSTALADOR sobre el CONTRATO REAL
//   del puente (src/lib/albra-bridge/ops-client → POST /api/ops con
//   Bearer ALBRA_OPS_TOKEN, catálogo /api/catalog, runs /api/runs/{id}).
//   Un solo contrato entre PANEL e INSTALADOR: el lifecycle del EEC es
//   una vista del contrato EEC ops, no una segunda frontera paralela.
// UnavailableInstaladorAdapter (DEFAULT): frontera HONESTA — informa
//   "no disponible/not_configured"; nunca simula una operación.
//
// REGLA DE HONESTIDAD (contracts/lifecycle.ts): aceptar NO es ejecutar.
// verified=true SOLO cuando la respuesta del INSTALADOR incluye un
// resultado concluyente (estado final o health completo); un runId de
// operación asíncrona queda verified=false hasta que el polling del run
// (syncManagedOpRun) confirme estado terminal.
// ============================================================
import type {
  InstaladorInterface, LifecycleOperation, LifecycleOperationResult,
  LifecycleStatus, LifecycleUnavailable, ManagedRef,
} from '../../contracts/lifecycle'
import { LIFECYCLE_CONTRACT_VERSION } from '../../contracts/lifecycle'
import { executeAlbraOp, fetchAlbraGet, albraOpsUrl, type AlbraOperation } from '../../../albra-bridge/ops-client'

const LIFECYCLE_TO_OPS: Record<LifecycleOperation, AlbraOperation> = {
  install: 'INSTALL',
  configure: 'UPDATE',
  start: 'START',
  stop: 'STOP',
  restart: 'RESTART',
  upgrade: 'UPDATE',
  repair: 'DIAGNOSTICS',
  backup: 'BACKUP',
  rollback: 'ROLLBACK',
  status: 'STATUS',
}

/** Resultados del contrato ops que ya traen conclusión verificable. */
function resultIsConclusive(op: AlbraOperation, result: Record<string, unknown>): boolean {
  if (result.health !== undefined || result.state !== undefined) return true
  if (op === 'INSTALL' || op === 'UPDATE' || op === 'ROLLBACK' || op === 'UNINSTALL') return false // asíncronas: runId → polling
  return Object.keys(result).length > 0
}


/** El catálogo puede venir como {products:[...]}, {items:[...]} o array (tolerante, como la vista Agentes ALBRA). */
function extractProducts(catalog: unknown): Array<{ productId?: string; state?: string }> {
  if (Array.isArray(catalog)) return catalog as Array<{ productId?: string; state?: string }>
  if (catalog && typeof catalog === 'object') {
    const rec = catalog as { products?: unknown; items?: unknown }
    const list = Array.isArray(rec.products) ? rec.products : Array.isArray(rec.items) ? rec.items : []
    return list as Array<{ productId?: string; state?: string }>
  }
  return []
}

export class HttpInstaladorAdapter implements InstaladorInterface {
  readonly contractVersion = LIFECYCLE_CONTRACT_VERSION
  readonly providerKey = 'instalador-http'

  private unavailable(): LifecycleUnavailable {
    const configured = Boolean(process.env.ALBRA_OPS_URL)
    return configured
      ? { available: false, reason: 'unreachable', detail: `INSTALADOR configurado en ${albraOpsUrl()} pero no respondió (¿revisa ALBRA_OPS_TOKEN y que el servicio esté arriba?)` }
      : { available: false, reason: 'not_configured', detail: 'frontera INSTALADOR preparada (contrato EEC ops/1.0.0); configure ALBRA_OPS_URL + ALBRA_OPS_TOKEN para activarla' }
  }

  async listManaged() {
    if (!albraOpsUrl()) return { available: false as const, reason: 'not_configured' as const, detail: 'ALBRA_OPS_URL sin configurar' }
    try {
      const catalog = await fetchAlbraGet<unknown>('/api/catalog')
      const products = extractProducts(catalog)
      const refs = products
        .filter(p => typeof p.productId === 'string' && p.productId.length > 0)
        .map(p => ({ ref: p.productId as string, kind: 'PRODUCT' as const, ...(p.state ? { state: p.state } : {}) }))
      return { available: true as const, refs }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      return { available: false as const, reason: 'unreachable' as const, detail: err.message ?? 'INSTALADOR no accesible' }
    }
  }

  async getStatus(ref: ManagedRef): Promise<LifecycleStatus | LifecycleUnavailable> {
    try {
      const { response } = await executeAlbraOp('STATUS', ref.ref)
      if (!response || !response.accepted) {
        return { available: false, reason: 'rejected', detail: response?.error?.message ?? 'operación rechazada por el INSTALADOR' }
      }
      const state = (response.result?.state as { state?: string } | undefined)?.state
      return {
        available: true,
        ref: ref.ref,
        state: typeof state === 'string' ? state : 'UNKNOWN',
        observedAt: new Date().toISOString(),
        detail: (response.result?.state as Record<string, unknown> | undefined),
      }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      if (err.code === 'BRIDGE_NOT_CONFIGURED') return { available: false, reason: 'not_configured', detail: err.message }
      return { available: false, reason: 'unreachable', detail: err.message ?? 'INSTALADOR no accesible' }
    }
  }

  async requestOperation(op: LifecycleOperation, ref: ManagedRef, opts?: { correlationId?: string; params?: Record<string, unknown> }): Promise<LifecycleOperationResult | LifecycleUnavailable> {
    const mapped = LIFECYCLE_TO_OPS[op] ?? 'STATUS'
    try {
      const { request, response } = await executeAlbraOp(mapped, ref.ref, opts?.params)
      if (!response || !response.accepted) {
        return { available: false, reason: 'rejected', detail: response?.error?.message ?? response?.error?.code ?? 'operación rechazada por el INSTALADOR' }
      }
      const result = (response.result ?? {}) as Record<string, unknown>
      const runId = typeof result.runId === 'string' ? result.runId : undefined
      return {
        available: true,
        operationId: runId ?? request.requestId,
        // verificable SOLO si el INSTALADOR devolvió conclusión explícita;
        // runId asíncrono → verified=false hasta confirmación por polling.
        verified: resultIsConclusive(mapped, result),
        state: runId ? 'ACCEPTED' : 'EXECUTED',
        detail: result as Record<string, unknown>,
      }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      if (err.code === 'BRIDGE_NOT_CONFIGURED') return { available: false, reason: 'not_configured', detail: err.message }
      if (err.code === 'BRIDGE_UPSTREAM_ERROR') return { available: false, reason: 'unreachable', detail: err.message }
      return { available: false, reason: 'unreachable', detail: err.message ?? 'INSTALADOR no accesible' }
    }
  }
}

/** Frontera por defecto: INSTALADOR no conectado. Honesta: nada disponible. */
export class UnavailableInstaladorAdapter implements InstaladorInterface {
  readonly contractVersion = LIFECYCLE_CONTRACT_VERSION
  readonly providerKey = 'instalador-unavailable'

  private unavailable(): LifecycleUnavailable {
    return { available: false, reason: 'not_configured', detail: 'frontera INSTALADOR preparada (contrato EEC ops/1.0.0); configure ALBRA_OPS_URL + ALBRA_OPS_TOKEN para activarla' }
  }

  async listManaged() {
    return this.unavailable()
  }

  async getStatus(_ref: ManagedRef): Promise<LifecycleStatus | LifecycleUnavailable> {
    return this.unavailable()
  }

  async requestOperation(_op: LifecycleOperation, _ref: ManagedRef): Promise<LifecycleOperationResult | LifecycleUnavailable> {
    return this.unavailable()
  }
}
