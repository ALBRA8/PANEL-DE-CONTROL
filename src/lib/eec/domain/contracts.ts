// ============================================================
// EEC — PROVIDER-AGNOSTIC CONTRACTS (spec §3, §15, §16, §17, §43)
//
// EEC → INTERFACE → ADAPTER → PROVIDER
// El core jamás importa un proveedor concreto. Los adapters se
// registran en el ProviderRegistry y son reemplazables en caliente.
// ============================================================

import type { ProviderType } from '../domain/types'

// ---------- CONTEXT PACKAGE (spec §20) ----------
export interface ContextPackage {
  identity: { agentId: string; code: string; role: string; provider: string }
  permissions: Array<{ capability: string; resource: string; action: string; effect: string }>
  project?: { id: string; code: string; name: string; objective?: string | null } | null
  memory: Array<{ id: string; scope: string; content: string; importance: number }>
  knowledge: Array<{ id: string; title: string; sourceType: string; excerpt: string; classification: string }>
  conversation?: { id: string; title?: string | null; messageCount: number } | null
  tools: Array<{ code: string; name: string; capability: string; risk: string }>
  policies: Array<{ code: string; type: string; effect: string }>
  assembledAt: string
  traceId?: string | null
}

// ---------- AGENT INTERFACE ----------
// Un "agente" concreto (Hermes, CREA, A2A peer, worker local...) implementa esto.
export interface AgentInterface {
  readonly providerKey: string
  /** Ejecuta un tick del run: avanza el trabajo y emite eventos. No toca STATE directamente. */
  tick(ctx: AgentTickContext): Promise<AgentTickResult>
  /** Health probe del agente proveedor. */
  health?(agentId: string): Promise<{ healthy: boolean; detail?: string }>
}

export interface AgentTickContext {
  runId: string
  agentId: string
  agentCode: string
  taskId?: string | null
  currentNode: string | null
  progress: number
  context: ContextPackage & Record<string, unknown>
  traceId?: string | null
  simulation: boolean
}

export interface AgentTickResult {
  done: boolean
  progress: number
  currentNode?: string | null
  outputs?: Record<string, unknown>
  error?: string
  /** Actividad descriptiva derivada del trabajo real (nunca fabricada). */
  activity?: string
}

// ---------- ORCHESTRATION INTERFACE (spec §15) ----------
// Hermético: submit/status/cancel/pause/resume/retry/result.
export interface OrchestrationInterface {
  readonly providerKey: string
  submit(spec: OrchestrationSpec): Promise<{ orchestrationId: string }>
  status(orchestrationId: string): Promise<{ state: string; detail?: Record<string, unknown> }>
  cancel(orchestrationId: string): Promise<void>
  pause(orchestrationId: string): Promise<void>
  resume(orchestrationId: string): Promise<void>
  retry(orchestrationId: string): Promise<void>
  result(orchestrationId: string): Promise<Record<string, unknown> | null>
}

export interface OrchestrationSpec {
  runId: string
  workflowId?: string | null
  taskId?: string | null
  agentId?: string | null
  nodes?: Array<Record<string, unknown>>
  context?: Record<string, unknown>
}

// ---------- RUNTIME INTERFACE (spec §8) ----------
export interface RuntimeInterface {
  readonly providerKey: string
  start(runtimeId: string): Promise<void>
  stop(runtimeId: string): Promise<void>
  restart(runtimeId: string): Promise<void>
  recover(runtimeId: string): Promise<void>
}

// ---------- TOOL INTERFACE (spec §17) ----------
export interface ToolInterface {
  readonly providerKey: string
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionOutput>
}

export interface ToolExecutionContext {
  toolCode: string
  agentId?: string | null
  runId?: string | null
  taskId?: string | null
  simulation: boolean
  traceId?: string | null
}

export interface ToolExecutionOutput {
  ok: boolean
  output: Record<string, unknown>
  cost?: number
  simulated?: boolean
  error?: string
}

// ---------- MEMORY INTERFACE (spec §18) ----------
export interface MemoryInterface {
  readonly providerKey: string
  write(entry: MemoryWriteRequest): Promise<{ id: string }>
  query(q: MemoryQuery): Promise<MemoryHit[]>
}

export interface MemoryWriteRequest {
  agentId?: string | null
  scope: string
  kind?: string
  content: string
  importance?: number
  provenance: Record<string, unknown>
  classification?: string
  tags?: string[]
  ttlMinutes?: number
}

export interface MemoryQuery {
  agentId?: string | null
  scopes?: string[]
  text?: string
  limit?: number
  minImportance?: number
}

export interface MemoryHit {
  id: string
  scope: string
  kind: string
  content: string
  importance: number
  provenance: Record<string, unknown>
  classification: string
}

// ---------- KNOWLEDGE INTERFACE (spec §19) ----------
export interface KnowledgeInterface {
  readonly providerKey: string
  retrieve(q: KnowledgeQuery, clearance: string): Promise<KnowledgeHit[]>
}

export interface KnowledgeQuery {
  text: string
  tags?: string[]
  limit?: number
}

export interface KnowledgeHit {
  id: string
  title: string
  sourceType: string
  excerpt: string
  classification: string
  score: number
}

// ---------- MODEL INTERFACE (inference provider) ----------
export interface ModelInterface {
  readonly providerKey: string
  complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }):
    Promise<{ text: string; tokens?: number; cost?: number; simulated?: boolean }>
}

// ---------- NOTIFICATION INTERFACE (spec §42) ----------
export interface NotificationInterface {
  readonly providerKey: string
  send(n: { title: string; body?: string; severity: string; channels: string[]; subjectType?: string; subjectId?: string; recipientId?: string }): Promise<void>
}

// ---------- PROVIDER REGISTRY (spec §43) ----------
export interface ProviderEntry {
  key: string
  type: ProviderType
  adapter: string
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'DISABLED'
  isDefault: boolean
  instance?: unknown
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderEntry>()

  register<T>(type: ProviderType, key: string, instance: T, opts?: { adapter?: string; isDefault?: boolean }): void {
    const id = `${type}:${key}`
    const existing = this.providers.get(id)
    this.providers.set(id, {
      key,
      type,
      adapter: opts?.adapter ?? (instance as { constructor?: { name?: string } })?.constructor?.name ?? 'anonymous',
      status: 'AVAILABLE',
      isDefault: opts?.isDefault ?? existing?.isDefault ?? false,
      instance,
    })
  }

  unregister(type: ProviderType, key: string): void {
    this.providers.delete(`${type}:${key}`)
  }

  setDisabled(type: ProviderType, key: string, disabled: boolean): void {
    const e = this.providers.get(`${type}:${key}`)
    if (e) e.status = disabled ? 'DISABLED' : 'AVAILABLE'
  }

  get<T>(type: ProviderType, key?: string): T {
    const list = this.list(type)
    if (key) {
      const e = this.providers.get(`${type}:${key}`)
      if (!e || e.status !== 'AVAILABLE') throw new Error(`EEC_PROVIDER_UNAVAILABLE:${type}:${key}`)
      return e.instance as T
    }
    const def = list.find(p => p.isDefault && p.status === 'AVAILABLE') ?? list.find(p => p.status === 'AVAILABLE')
    if (!def) throw new Error(`EEC_PROVIDER_UNAVAILABLE:${type}:default`)
    return def.instance as T
  }

  list(type?: ProviderType): ProviderEntry[] {
    const all = Array.from(this.providers.values())
    return type ? all.filter(p => p.type === type) : all
  }
}

// Registro global único del proceso (sobrevive a HMR con guard)
const globalForRegistry = globalThis as unknown as { __eecProviderRegistry?: ProviderRegistry }
export const providerRegistry: ProviderRegistry =
  globalForRegistry.__eecProviderRegistry ?? new ProviderRegistry()
globalForRegistry.__eecProviderRegistry = providerRegistry
