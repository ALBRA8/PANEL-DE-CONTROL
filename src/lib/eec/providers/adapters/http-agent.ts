// ============================================================
// EEC — ADAPTADOR DE SERVICIO REMOTO HTTP (EEC V2, §4)
//
// Para agentes que exponen una API compatible (declarada en el
// manifiesto como HTTP_SERVICE):
//   POST   {endpoint}/executions   → { executionId }
//   GET    {endpoint}/executions/{id} → { state, progress, node?, activity?, output? }
//   DELETE {endpoint}/executions/{id}  → cancelación (si el servicio la soporta)
//   GET    {endpoint}/health          → 200
//
// Autenticación entre servicios vía Bearer con token leído de la
// variable de entorno declarada (tokenEnv) — el valor jamás se
// almacena en BD ni se loguea. Timeouts con AbortController,
// validación estricta de respuestas y errores explícitos.
// ============================================================
import { db } from '../../../../lib/db'
import type { AgentInterface, AgentTickContext, AgentTickResult } from '../../domain/contracts'
import { validateManifest, type AgentManifest } from '../../contracts/agent-manifest'

export const PROVIDER_KEY = 'http-agent'

function parseManifest(agent: { providerConfigJson: string | null; provider: string }): AgentManifest | null {
  if (agent.provider !== PROVIDER_KEY) return null
  try {
    const cfg = JSON.parse(agent.providerConfigJson || '{}') as { manifest?: unknown }
    const v = validateManifest(cfg.manifest)
    return v.ok && v.manifest ? v.manifest : null
  } catch {
    return null
  }
}

function authHeaders(manifest: AgentManifest): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (manifest.runtime.type === 'HTTP_SERVICE' && manifest.runtime.tokenEnv) {
    const token = process.env[manifest.runtime.tokenEnv]
    if (token) headers.authorization = `Bearer ${token}`
  }
  return headers
}

function httpTimeout(manifest: AgentManifest): number {
  return manifest.runtime.type === 'HTTP_SERVICE' ? manifest.runtime.timeoutMs : 15_000
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json?: unknown; error?: string }> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const text = await res.text()
    let json: unknown
    try { json = JSON.parse(text) } catch {
      return { status: res.status, error: `malformed_response:not_json (status ${res.status})` }
    }
    return { status: res.status, json }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : 'network_error'
    return { status: 0, error: msg }
  } finally {
    clearTimeout(t)
  }
}

interface RemoteExecution { executionId: string; manifest: AgentManifest; done: boolean; output?: Record<string, unknown>; error?: string; startedAt: number }

const globalForRemote = globalThis as unknown as { __eecRemoteExec?: Map<string, RemoteExecution> }
const remote: Map<string, RemoteExecution> = globalForRemote.__eecRemoteExec ?? new Map()
globalForRemote.__eecRemoteExec = remote

export class HttpAgentAdapter implements AgentInterface {
  readonly providerKey = PROVIDER_KEY

  async health(agentId: string): Promise<{ healthy: boolean; detail?: string }> {
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    const manifest = agent ? parseManifest(agent) : null
    if (!agent || !manifest || manifest.runtime.type !== 'HTTP_SERVICE') return { healthy: false, detail: 'manifest_invalid_or_missing' }
    const r = await fetchJson(`${manifest.runtime.endpoint}/health`, { headers: authHeaders(manifest) }, httpTimeout(manifest))
    return { healthy: r.status === 200, detail: r.error ?? `status=${r.status}` }
  }

  async tick(ctx: AgentTickContext): Promise<AgentTickResult> {
    let ex = remote.get(ctx.runId)
    const agent = await db.agent.findUnique({ where: { id: ctx.agentId } })
    const manifest = agent ? parseManifest(agent) : null
    if (!agent || !manifest || manifest.runtime.type !== 'HTTP_SERVICE') {
      return { done: true, progress: 0, error: 'http_agent:manifest_invalid_or_missing' }
    }

    if (!ex) {
      const input = (ctx.context as { taskInput?: Record<string, unknown> })?.taskInput ?? {}
      const r = await fetchJson(`${manifest.runtime.endpoint}/executions`, {
        method: 'POST',
        headers: authHeaders(manifest),
        body: JSON.stringify({ runId: ctx.runId, taskId: ctx.taskId, agentId: ctx.agentId, input, contractVersion: manifest.contractVersion }),
      }, httpTimeout(manifest))
      if (r.error) return { done: true, progress: 0, error: `http_agent:${r.error}` }
      const j = r.json as { executionId?: unknown }
      if (r.status !== 201 && r.status !== 200) return { done: true, progress: 0, error: `http_agent:unexpected_status_${r.status}` }
      if (typeof j?.executionId !== 'string') return { done: true, progress: 0, error: 'http_agent:malformed_response:no_executionId' }
      ex = { executionId: j.executionId, manifest, done: false, startedAt: Date.now() }
      remote.set(ctx.runId, ex)
      return { done: false, progress: 0, currentNode: 'INTAKE', activity: `Ejecución remota creada (${ex.executionId.slice(0, 12)}…)`, outputs: { remoteExecutionId: ex.executionId } }
    }

    const r = await fetchJson(`${manifest.runtime.endpoint}/executions/${encodeURIComponent(ex.executionId)}`, {
      method: 'GET', headers: authHeaders(ex.manifest),
    }, httpTimeout(ex.manifest))
    if (r.error) {
      if (Date.now() - ex.startedAt > ex.manifest.limits.timeoutMs) {
        remote.delete(ctx.runId)
        return { done: true, progress: 100, error: `http_agent:${r.error}` }
      }
      return { done: false, progress: 1, activity: `Esperando al servicio (${r.error})` }
    }
    const j = r.json as { state?: unknown; progress?: unknown; node?: unknown; activity?: unknown; output?: unknown; error?: unknown }
    if (r.status !== 200 || typeof j?.state !== 'string') {
      remote.delete(ctx.runId)
      return { done: true, progress: 100, error: `http_agent:malformed_response:status_${r.status}` }
    }
    const progress = typeof j.progress === 'number' ? Math.max(0, Math.min(100, j.progress)) : 1
    if (j.state === 'RUNNING' || j.state === 'PENDING') {
      return {
        done: false, progress,
        currentNode: typeof j.node === 'string' ? j.node : 'EXECUTE',
        activity: typeof j.activity === 'string' ? j.activity : 'Ejecución remota en curso',
      }
    }
    remote.delete(ctx.runId)
    if (j.state === 'SUCCEEDED') {
      return {
        done: true, progress: 100, currentNode: 'REPORT',
        activity: 'Ejecución remota completada',
        outputs: { result: (j.output && typeof j.output === 'object') ? j.output as Record<string, unknown> : {}, remoteExecutionId: ex.executionId },
      }
    }
    return {
      done: true, progress: 100,
      error: `http_agent:remote_state_${j.state}${typeof j.error === 'string' ? `:${j.error.slice(0, 200)}` : ''}`,
      outputs: { remoteExecutionId: ex.executionId },
    }
  }
}

/** Cancelación de ejecución remota (mejor esfuerzo; el servicio puede no soportarla). */
export async function cancelRemoteExecutions(runId: string): Promise<void> {
  const ex = remote.get(runId)
  if (!ex) return
  remote.delete(runId)
  try {
    await fetchJson(`${ex.manifest.runtime.type === 'HTTP_SERVICE' ? ex.manifest.runtime.endpoint : ''}/executions/${encodeURIComponent(ex.executionId)}`, {
      method: 'DELETE', headers: authHeaders(ex.manifest),
    }, 5_000)
  } catch { /* mejor esfuerzo */ }
}
