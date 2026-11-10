// ============================================================
// EEC — ADAPTADOR DE PROCESO LOCAL REAL (EEC V2, §4 del mandato)
//
// Ejecuta agentes como procesos reales separados del proceso web:
//  - Ejecutable y argumentos EXPLÍCITOS del manifiesto, validados
//    contra allowlist (EEC_ALLOWED_EXECUTABLES / EEC_ALLOWED_WORKDIRS).
//  - SIN shell: la entrada de la tarea viaja por STDIN como JSON
//    (la entrada de una tarea jamás se convierte en comandos).
//  - Protocolo NDJSON en stdout:
//      {"type":"progress","progress":N,"node":"…","activity":"…"}
//      {"type":"result","ok":true,"output":{…}}      ← última línea válida
//  - Evidencia: ExecutionProcess (pid, exitCode, señal, tiempos) +
//    Artifacts de stdout/stderr REDACTADOS (§10).
//  - Distingue SIEMPRE: proceso creado (SPAWNED) ≠ vivo (ALIVE) ≠
//    terminado (EXITED/KILLED/TIMEOUT) ≠ resultado validado (done).
//  - Reconciliación tras reinicio: pid muerto sin resultado →
//    UNRECONCILED (nunca "completado" inventado).
// ============================================================
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import path from 'path'
import { db } from '../../../../lib/db'
import type { AgentInterface, AgentTickContext, AgentTickResult } from '../../domain/contracts'
import { validateManifest, type AgentManifest } from '../../contracts/agent-manifest'
import { redactSecrets, collectSecretValues } from '../../security/auth'

export const PROVIDER_KEY = 'local-process'

// ---------- allowlists (§4) ----------

function allowlistExecutables(): string[] {
  const fromEnv = (process.env.EEC_ALLOWED_EXECUTABLES ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [process.execPath, ...fromEnv]
}

function allowlistWorkdirs(): string[] {
  const fromEnv = (process.env.EEC_ALLOWED_WORKDIRS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [process.cwd(), path.join(process.cwd(), 'agents'), ...fromEnv]
}

export function resolveExecutable(name: string): { ok: true; path: string } | { ok: false; error: string } {
  const candidates = path.isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '').split(':').map(dir => path.join(dir, name))
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        const real = realpathSync(c)
        const allowed = allowlistExecutables().map(e => { try { return realpathSync(e) } catch { return e } })
        if (allowed.includes(real)) return { ok: true, path: real }
        return { ok: false, error: `executable_not_allowlisted:${name}` }
      }
    } catch { /* seguir */ }
  }
  return { ok: false, error: `executable_not_found:${name}` }
}

export function validateWorkdir(workdir: string | undefined): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = path.resolve(workdir && workdir !== '.' ? workdir : process.cwd())
  const allowed = allowlistWorkdirs().map(d => path.resolve(d))
  if (allowed.some(a => resolved === a || resolved.startsWith(a + path.sep))) return { ok: true, path: resolved }
  return { ok: false, error: `workdir_not_allowlisted:${resolved}` }
}

// ---------- manifiesto del agente ----------

export function parseAgentManifest(agent: { providerConfigJson: string | null; provider: string }): AgentManifest | null {
  if (agent.provider !== PROVIDER_KEY) return null
  try {
    const cfg = JSON.parse(agent.providerConfigJson || '{}') as { manifest?: unknown }
    const v = validateManifest(cfg.manifest)
    return v.ok && v.manifest ? v.manifest : null
  } catch {
    return null
  }
}

// ---------- manejo de procesos activos (por runId) ----------

interface ProcessHandle {
  proc: ChildProcess
  recordId: string
  manifest: AgentManifest
  startedAt: number
  timeoutMs: number
  stdout: string
  stderr: string
  /** captura RAW para evidencia (consumeLines no la muta) */
  rawStdout: string
  events: Array<{ progress?: number; node?: string; activity?: string }>
  resultLine: { ok: boolean; output?: Record<string, unknown>; error?: string } | null
  exited: boolean
  exitCode: number | null
  signal: string | null
  finalized: boolean
  secrets: string[]
  lastEmitAt: number
}

const globalForProc = globalThis as unknown as { __eecProcHandles?: Map<string, ProcessHandle> }
const handles: Map<string, ProcessHandle> = globalForProc.__eecProcHandles ?? new Map()
globalForProc.__eecProcHandles = handles

/** Cancela (SIGTERM→SIGKILL) todos los procesos activos de un run. Idempotente. */
export async function cancelRunProcesses(runId: string, reason = 'cancelled'): Promise<void> {
  const h = handles.get(runId)
  if (!h) return
  if (h.exited) {
    if (!h.finalized) await finalize(runId, 'KILLED', h.exitCode, `cancelled:${reason}`).catch(() => undefined)
    return
  }
  await new Promise<void>((resolve) => {
    try { h.proc.kill('SIGTERM') } catch { /* ya muerto */ }
    const t = setTimeout(() => {
      try { h.proc.kill('SIGKILL') } catch { /* ya muerto */ }
      resolve()
    }, 3000)
    h.proc.once('exit', () => { clearTimeout(t); resolve() })
  })
  h.exited = true
  h.resultLine = h.resultLine ?? { ok: false, error: `cancelled:${reason}` }
  await finalize(runId, 'KILLED', h.exitCode, `cancelled:${reason}`).catch(() => undefined)
}

// ---------- evidencia (§8, §10) ----------

const MAX_EVIDENCE_BYTES = 64 * 1024

async function storeEvidence(
  kind: 'stdout' | 'stderr', content: string, secrets: string[],
  meta: { runId: string; agentId?: string | null; taskId?: string | null },
): Promise<string | null> {
  if (!content.trim()) return null
  const redacted = redactSecrets(content.slice(0, MAX_EVIDENCE_BYTES), secrets)
  const art = await db.artifact.create({
    data: {
      type: kind === 'stdout' ? 'PROCESS_STDOUT' : 'PROCESS_STDERR',
      name: `${kind}:${meta.runId.slice(-8)}`,
      uri: `eec:evidence:${kind}`,
      mimeType: 'text/plain; charset=utf-8',
      size: Buffer.byteLength(redacted),
      metadataJson: JSON.stringify({ ...meta, redacted: true, truncated: content.length > MAX_EVIDENCE_BYTES, collectedAt: new Date().toISOString() }),
    },
  })
  return art.id
}

async function finalize(runId: string, status: 'EXITED' | 'KILLED' | 'TIMEOUT' | 'SPAWN_FAILED', exitCode: number | null, error?: string): Promise<void> {
  const h = handles.get(runId)
  if (!h) return
  if (h.finalized) return
  h.finalized = true
  const durationMs = Date.now() - h.startedAt
  const [stdoutId, stderrId] = await Promise.all([
    storeEvidence('stdout', h.rawStdout || h.stdout, h.secrets, { runId: h.recordId }),
    storeEvidence('stderr', h.stderr, h.secrets, { runId: h.recordId }),
  ])
  await db.executionProcess.update({
    where: { id: h.recordId },
    data: {
      status, exitCode, signal: h.signal,
      endedAt: new Date(), durationMs,
      stdoutArtifactId: stdoutId, stderrArtifactId: stderrId,
      error: error?.slice(0, 400),
    },
  }).catch(() => undefined)
  handles.delete(runId)
}

// ---------- parsing NDJSON ----------

function consumeLines(h: ProcessHandle): void {
  const lines = h.stdout.split('\n')
  h.stdout = lines.pop() ?? '' // última línea incompleta se conserva
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      const ev = JSON.parse(t) as Record<string, unknown>
      if (ev.type === 'progress') {
        h.events.push({
          progress: typeof ev.progress === 'number' ? Math.max(0, Math.min(100, ev.progress)) : undefined,
          node: typeof ev.node === 'string' ? ev.node.slice(0, 60) : undefined,
          activity: typeof ev.activity === 'string' ? ev.activity.slice(0, 200) : undefined,
        })
        h.lastEmitAt = Date.now()
      } else if (ev.type === 'result') {
        h.resultLine = {
          ok: ev.ok === true,
          output: (ev.output && typeof ev.output === 'object' && !Array.isArray(ev.output)) ? ev.output as Record<string, unknown> : undefined,
          error: typeof ev.error === 'string' ? ev.error : undefined,
        }
      }
    } catch {
      // línea no-JSON: se conserva en la evidencia stdout; no es protocolo
    }
  }
}

// ---------- ADAPTADOR ----------

export class LocalProcessAgentAdapter implements AgentInterface {
  readonly providerKey = PROVIDER_KEY

  async health(agentId: string): Promise<{ healthy: boolean; detail?: string }> {
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) return { healthy: false, detail: 'agent_not_found' }
    const manifest = parseAgentManifest(agent)
    if (!manifest) return { healthy: false, detail: 'manifest_invalid_or_missing' }
    if (manifest.runtime.type !== 'LOCAL_PROCESS') return { healthy: false, detail: 'wrong_runtime_type' }
    const rt = manifest.runtime
    const exe = resolveExecutable(rt.executable)
    if (!exe.ok) return { healthy: false, detail: exe.error }
    const wd = validateWorkdir(manifest.runtime.workdir)
    if (!wd.ok) return { healthy: false, detail: wd.error }
    return new Promise((resolve) => {
      let settled = false
      const done = (healthy: boolean, detail?: string) => { if (!settled) { settled = true; resolve({ healthy, detail }) } }
      try {
        const child = spawn(exe.path, rt.healthArgs, {
          cwd: wd.path,
          env: childEnv(manifest),
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        })
        let out = ''
        child.stdout?.on('data', d => { out += String(d) })
        child.on('error', (e) => done(false, `spawn_error:${e.message}`))
        child.on('exit', (code) => {
          // el health check real exige exit 0 Y la marca de salud del agente
          done(code === 0 && out.includes('"eec":"healthy"'), `exit=${code} out=${out.trim().slice(0, 120)}`)
        })
      } catch (e) {
        done(false, e instanceof Error ? e.message : 'health_spawn_failed')
      }
    })
  }

  async tick(ctx: AgentTickContext): Promise<AgentTickResult> {
    const sim = ctx.simulation
    let h = handles.get(ctx.runId)

    // ---- 1. SPWN: primera llamada del run → crear proceso real ----
    if (!h) {
      const agent = await db.agent.findUnique({ where: { id: ctx.agentId } })
      const manifest = agent ? parseAgentManifest(agent) : null
      if (!agent || !manifest || manifest.runtime.type !== 'LOCAL_PROCESS') {
        return { done: true, progress: 0, error: 'local_process:manifest_invalid_or_missing' }
      }
      const exe = resolveExecutable(manifest.runtime.executable)
      if (!exe.ok) return { done: true, progress: 0, error: `local_process:${exe.error}` }
      const wd = validateWorkdir(manifest.runtime.workdir)
      if (!wd.ok) return { done: true, progress: 0, error: `local_process:${wd.error}` }

      const input = (ctx.context as { taskInput?: Record<string, unknown> })?.taskInput ?? {}
      const secrets = collectSecretValues(manifest.config.map(c => c.secretRef).filter((s): s is string => Boolean(s)))
      const timeoutMs = manifest.limits.timeoutMs

      let recordId: string
      try {
        const rec = await db.executionProcess.create({
          data: {
            runId: ctx.runId, agentId: ctx.agentId, taskId: ctx.taskId ?? null,
            executable: exe.path, argsJson: JSON.stringify(manifest.runtime.args),
            workdir: wd.path, status: 'SPAWNED', sim,
          },
        })
        recordId = rec.id
      } catch (e) {
        return { done: true, progress: 0, error: `local_process:evidence_write_failed:${e instanceof Error ? e.message : 'db'}` }
      }

      let proc: ChildProcess
      try {
        proc = spawn(exe.path, manifest.runtime.args, {
          cwd: wd.path,
          env: childEnv(manifest),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (e) {
        await db.executionProcess.update({
          where: { id: recordId },
          data: { status: 'SPAWN_FAILED', endedAt: new Date(), error: (e instanceof Error ? e.message : 'spawn_failed').slice(0, 400) },
        }).catch(() => undefined)
        return { done: true, progress: 0, error: 'local_process:spawn_failed' }
      }

      h = {
        proc, recordId, manifest, startedAt: Date.now(), timeoutMs,
        stdout: '', stderr: '', rawStdout: '', events: [], resultLine: null,
        exited: false, exitCode: null, signal: null, finalized: false,
        secrets, lastEmitAt: Date.now(),
      }
      handles.set(ctx.runId, h)

      proc.stdout?.on('data', d => {
        const chunk = String(d)
        h!.stdout += chunk
        h!.rawStdout = (h!.rawStdout + chunk).slice(-MAX_EVIDENCE_BYTES)
        if (h!.stdout.length > 2 * MAX_EVIDENCE_BYTES) h!.stdout = h!.stdout.slice(-MAX_EVIDENCE_BYTES)
      })
      proc.stderr?.on('data', d => { h!.stderr += String(d); if (h!.stderr.length > MAX_EVIDENCE_BYTES) h!.stderr = h!.stderr.slice(-MAX_EVIDENCE_BYTES) })
      proc.on('exit', (code, signal) => {
        h!.exited = true; h!.exitCode = code; h!.signal = signal
      })
      proc.on('error', (e) => {
        h!.exited = true; h!.resultLine = { ok: false, error: `process_error:${e.message}` }
      })

      // entrada de tarea por STDIN (nunca por argv/shell)
      try {
        proc.stdin?.write(JSON.stringify({
          eec: 'task.input/v1', runId: ctx.runId, taskId: ctx.taskId ?? null, agentId: ctx.agentId,
          input, limits: { timeoutMs },
        }))
        proc.stdin?.end()
      } catch { /* el proceso pudo morir ya; quedará como EXITED con error */ }

      await db.executionProcess.update({ where: { id: recordId }, data: { pid: proc.pid ?? null, status: 'ALIVE' } }).catch(() => undefined)

      return {
        done: false, progress: 0, currentNode: 'INTAKE',
        activity: `Proceso real iniciado (pid ${proc.pid ?? '?'}) — ejecutable autorizado`,
        outputs: { processId: recordId, pid: proc.pid ?? null, executable: exe.path },
      }
    }

    // ---- 2. TIMEOUT ----
    const elapsed = Date.now() - h.startedAt
    if (!h.exited && elapsed > h.timeoutMs) {
      try { h.proc.kill('SIGKILL') } catch { /* ya muerto */ }
      h.exited = true
      h.resultLine = { ok: false, error: `timeout_after_${h.timeoutMs}ms` }
      await finalize(ctx.runId, 'TIMEOUT', null, `timeout_after_${h.timeoutMs}ms`)
      return { done: true, progress: 100, error: `local_process:timeout_after_${h.timeoutMs}ms` }
    }

    // ---- 3. Vivo: consumir eventos NDJSON ----
    consumeLines(h)
    const last = [...h.events].reverse().find(e => e.progress !== undefined || e.activity)
    if (!h.exited) {
      return {
        done: false,
        progress: last?.progress ?? 1,
        currentNode: last?.node ?? 'EXECUTE',
        activity: last?.activity ?? `Proceso vivo (pid ${h.proc.pid ?? '?'}) — ${(elapsed / 1000).toFixed(1)}s`,
      }
    }

    // ---- 4. EXITED: validar resultado (¿resultado real o fin ambiguo?) ----
    consumeLines(h) // drenar líneas finales entre el último tick y la salida
    await finalize(ctx.runId, 'EXITED', h.exitCode, h.resultLine?.ok === false ? h.resultLine.error : undefined)
    const durSec = (elapsed / 1000).toFixed(1)

    if (h.resultLine && h.resultLine.ok && h.exitCode === 0) {
      return {
        done: true, progress: 100, currentNode: 'REPORT',
        activity: `Proceso terminado (exit 0, ${durSec}s) — resultado estructurado validado`,
        outputs: {
          result: h.resultLine.output ?? {},
          exitCode: 0, durationMs: elapsed,
          processId: h.recordId,
        },
      }
    }
    if (h.resultLine && !h.resultLine.ok) {
      return {
        done: true, progress: 100,
        error: `local_process:agent_failed(exit=${h.exitCode}):${h.resultLine.error ?? 'sin detalle'}`,
        outputs: { exitCode: h.exitCode, durationMs: elapsed, processId: h.recordId },
      }
    }
    // proceso terminó SIN result line → resultado ambiguo, honestidad: fallo con evidencia
    return {
      done: true, progress: 100,
      error: `local_process:no_result_line(exit=${h.exitCode ?? 'null'}, signal=${h.signal ?? 'none'})`,
      outputs: { exitCode: h.exitCode, durationMs: elapsed, processId: h.recordId, evidence: 'ver ExecutionProcess.stdout/stderr' },
    }
  }
}

/** Env mínimo para el hijo: nada del entorno del EEC se filtra salvo secretos declarados. */
function childEnv(manifest: AgentManifest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    EEC_CHILD: '1',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  }
  for (const c of manifest.config) {
    if (c.secretRef && process.env[c.secretRef] !== undefined) {
      env[c.name] = process.env[c.secretRef] as string
    }
  }
  return env
}

/** Reconciliación tras reinicio (§5.12): procesos que el EEC creía vivos. */
export async function reconcileProcessesAfterBoot(): Promise<{ reattached: number; unreconciled: number }> {
  let reattached = 0
  let unreconciled = 0
  const stale = await db.executionProcess.findMany({
    where: { status: { in: ['SPAWNED', 'ALIVE'] }, sim: false },
    orderBy: { startedAt: 'desc' }, take: 100,
  })
  for (const rec of stale) {
    if (handles.has(rec.runId)) continue // vivo en este proceso (no debería tras boot)
    const pidAlive = rec.pid ? isPidAlive(rec.pid) : false
    if (pidAlive) {
      await db.executionProcess.update({ where: { id: rec.id }, data: { status: 'ALIVE', error: null } }).catch(() => undefined)
      reattached++
      continue
    }
    await db.executionProcess.update({
      where: { id: rec.id },
      data: { status: 'UNRECONCILED', endedAt: new Date(), error: 'proceso no vivo tras reinicio del EEC; resultado indeterminado' },
    }).catch(() => undefined)
    unreconciled++
    // el run NO se marca completado: queda UNRECONCILED y la tarea BLOCKED (decisión humana)
    await db.run.updateMany({
      where: { id: rec.runId, status: 'RUNNING' },
      data: { status: 'UNRECONCILED', error: 'unreconciled_after_restart: proceso real no vivo, sin resultado validado' },
    }).catch(() => undefined)
    if (rec.taskId) {
      await db.$executeRawUnsafe(
        `UPDATE Task SET status='BLOCKED', updatedAt=CURRENT_TIMESTAMP WHERE id=? AND status='IN_PROGRESS'`,
        rec.taskId,
      ).catch(() => undefined)
    }
  }
  return { reattached, unreconciled }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
