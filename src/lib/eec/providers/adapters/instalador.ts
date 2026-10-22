// ============================================================
// EEC — ADAPTADORES DE LA FRONTERA INSTALADOR (§7)
//
// HttpInstaladorAdapter: cliente del INSTALADOR cuando existe
//   desplegado y configurado (EEC_INSTALLADOR_URL + token).
// UnavailableInstaladorAdapter (DEFAULT): frontera HONESTA — informa
//   "no disponible/not_configured"; nunca simula una operación.
//
// El EEC no toca tablas internas del INSTALADOR: solo este contrato.
// ============================================================
import type {
  InstaladorInterface, LifecycleOperation, LifecycleOperationResult,
  LifecycleStatus, LifecycleUnavailable, ManagedRef,
} from '../../contracts/lifecycle'
import { LIFECYCLE_CONTRACT_VERSION } from '../../contracts/lifecycle'

const TIMEOUT_MS = 10_000

interface ReqInit { method: string; path: string; body?: unknown; correlationId?: string }

export class HttpInstaladorAdapter implements InstaladorInterface {
  readonly contractVersion = LIFECYCLE_CONTRACT_VERSION
  readonly providerKey = 'instalador-http'

  private base(): { url: string; token?: string } | null {
    const url = process.env.EEC_INSTALLADOR_URL
    if (!url) return null
    return { url: url.replace(/\/$/, ''), token: process.env.EEC_INSTALLADOR_TOKEN }
  }

  private async call<T>({ method, path, body, correlationId }: ReqInit): Promise<{ ok: true; data: T } | { ok: false; reason: LifecycleUnavailable['reason']; detail?: string }> {
    const cfg = this.base()
    if (!cfg) return { ok: false, reason: 'not_configured' }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${cfg.url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
          'x-eec-contract': `eec.instalador/${LIFECYCLE_CONTRACT_VERSION}`,
          ...(correlationId ? { 'x-eec-correlation-id': correlationId } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
      if (res.status === 404) return { ok: false, reason: 'rejected', detail: 'operación o referencia desconocida para el INSTALADOR' }
      if (res.status === 426) return { ok: false, reason: 'version_incompatible', detail: await res.text().catch(() => '') }
      if (!res.ok) return { ok: false, reason: 'rejected', detail: `status_${res.status}` }
      const json = (await res.json().catch(() => null)) as T | null
      if (json === null) return { ok: false, reason: 'unreachable', detail: 'respuesta no JSON' }
      return { ok: true, data: json }
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : 'network'
      return { ok: false, reason: msg === 'timeout' ? 'timeout' : 'unreachable', detail: msg }
    } finally {
      clearTimeout(t)
    }
  }

  async listManaged() {
    const r = await this.call<{ refs?: Array<ManagedRef & { state?: string }> }>({ method: 'GET', path: '/api/v1/managed' })
    if (!r.ok) return { available: false as const, reason: r.reason, detail: r.detail }
    if (!Array.isArray(r.data.refs)) return { available: false as const, reason: 'unreachable' as const, detail: 'respuesta malformada' }
    return { available: true as const, refs: r.data.refs }
  }

  async getStatus(ref: ManagedRef): Promise<LifecycleStatus | LifecycleUnavailable> {
    const r = await this.call<{ state?: unknown; detail?: unknown }>({ method: 'GET', path: `/api/v1/managed/${encodeURIComponent(ref.ref)}` })
    if (!r.ok) return { available: false, reason: r.reason, detail: r.detail }
    if (typeof r.data.state !== 'string') return { available: false, reason: 'unreachable', detail: 'respuesta malformada' }
    return { available: true, ref: ref.ref, state: r.data.state, observedAt: new Date().toISOString(), detail: r.data.detail as Record<string, unknown> | undefined }
  }

  async requestOperation(op: LifecycleOperation, ref: ManagedRef, opts?: { correlationId?: string; params?: Record<string, unknown> }): Promise<LifecycleOperationResult | LifecycleUnavailable> {
    const r = await this.call<{ operationId?: unknown; state?: unknown; verified?: unknown; detail?: unknown }>({
      method: 'POST', path: `/api/v1/managed/${encodeURIComponent(ref.ref)}/operations`,
      body: { op, params: opts?.params ?? {} }, correlationId: opts?.correlationId,
    })
    if (!r.ok) return { available: false, reason: r.reason, detail: r.detail }
    if (typeof r.data.operationId !== 'string' || typeof r.data.state !== 'string') {
      return { available: false, reason: 'unreachable', detail: 'respuesta malformada (sin operationId)' }
    }
    return {
      available: true,
      operationId: r.data.operationId,
      // verificable SOLO si el INSTALADOR devolvió conclusión explícita:
      verified: r.data.verified === true,
      state: r.data.state,
      detail: r.data.detail as Record<string, unknown> | undefined,
    }
  }
}

/** Frontera por defecto: INSTALADOR no conectado. Honesta: nada disponible. */
export class UnavailableInstaladorAdapter implements InstaladorInterface {
  readonly contractVersion = LIFECYCLE_CONTRACT_VERSION
  readonly providerKey = 'instalador-unavailable'

  private unavailable(): LifecycleUnavailable {
    return { available: false, reason: 'not_configured', detail: 'frontera INSTALADOR preparada (contrato eec.instalador/1.0.0); configure EEC_INSTALLADOR_URL para activarla' }
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
