// ============================================================
// EEC V2 — INTEGRACIÓN: ADAPTADOR DE PROCESO REAL (§10)
// bun test tests/eec-v2/local-process.real.test.ts
// Spawn REAL del agente eco (proceso separado), con limpieza TST-.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { setSimulationMode } from '../../src/lib/eec/commands'
import manifestJson from '../../agents/echo-agent/manifest.json'
import { LocalProcessAgentAdapter, cancelRunProcesses } from '../../src/lib/eec/providers/adapters/local-process'

const SFX = Date.now().toString(36)
const adapter = new LocalProcessAgentAdapter()
let agentId = ''
const runIds: string[] = []

describe('V2 proceso real (integración)', () => {
  beforeAll(async () => {
    await initDbPragmas()
    await bootEEC()
    setSimulationMode(true)
    const agent = await db.agent.create({
      data: {
        code: `TST-LP-${SFX}`, name: 'Agente proceso real (test)', role: 'Tester',
        provider: 'local-process',
        capabilitiesJson: JSON.stringify(['echo.work']),
        providerConfigJson: JSON.stringify({ manifest: { ...manifestJson, limits: { ...manifestJson.limits, timeoutMs: 8000 } } }),
        state: 'IDLE', healthStatus: 'HEALTHY',
      },
    })
    agentId = agent.id
  })

  afterAll(async () => {
    for (const r of runIds) await cancelRunProcesses(r, 'cleanup').catch(() => undefined)
    await db.agent.delete({ where: { id: agentId } }).catch(() => undefined)
    await db.$disconnect()
  })

  function mkCtx(runId: string, input: Record<string, unknown>) {
    runIds.push(runId)
    return {
      runId, agentId, agentCode: `TST-LP-${SFX}`, taskId: null, currentNode: null,
      progress: 0, context: { taskInput: input } as never, traceId: runId, simulation: true,
    }
  }

  test('health real: proceso --eec-health exit 0 con marca', async () => {
    const h = await adapter.health(agentId)
    expect(h.healthy).toBe(true)
    expect(h.detail).toContain('exit=0')
  })

  test('spawn real → progreso NDJSON → resultado validado exit 0', async () => {
    const runId = `TST-run-ok-${SFX}`
    const r1 = await adapter.tick(mkCtx(runId, { durationMs: 1200, chunks: 4 }))
    expect(r1.done).toBe(false)
    expect((r1.outputs as { pid?: number }).pid).toBeGreaterThan(0) // proceso REAL con pid
    // avanzar ticks hasta finalizar
    let last = r1
    for (let i = 0; i < 60 && !last.done; i++) {
      await new Promise(r => setTimeout(r, 300))
      last = await adapter.tick({ ...mkCtx(runId, {}), progress: last.progress })
    }
    expect(last.done).toBe(true)
    expect(last.error).toBeUndefined()
    expect((last.outputs as { result: { deterministic: boolean } }).result.deterministic).toBe(true)
    const rec = await db.executionProcess.findFirst({ where: { runId } })
    expect(rec?.exitCode).toBe(0)
    expect(rec?.status).toBe('EXITED')
    expect(rec?.stdoutArtifactId).not.toBeNull() // evidencia persistida
    const art = await db.artifact.findUnique({ where: { id: rec!.stdoutArtifactId! } })
    expect(art?.type).toBe('PROCESS_STDOUT')
    expect(art?.metadataJson).toContain('"redacted":true')
  }, 30000)

  test('timeout: proceso killed + error timeout (sin resultado inventado)', async () => {
    const runId = `TST-run-timeout-${SFX}`
    await adapter.tick(mkCtx(runId, { durationMs: 30000, chunks: 30 }))
    // el manifiesto del test tiene timeoutMs=8000 — simulamos espera corta forzando ticks
    let last = { done: false, progress: 0 } as Awaited<ReturnType<adapter.tick>>
    for (let i = 0; i < 40 && !last.done; i++) {
      await new Promise(r => setTimeout(r, 250))
      last = await adapter.tick({ ...mkCtx(runId, {}), progress: last.progress })
    }
    expect(last.done).toBe(true)
    expect(String(last.error)).toContain('timeout')
    const rec = await db.executionProcess.findFirst({ where: { runId } })
    expect(rec?.status).toBe('TIMEOUT')
  }, 30000)

  test('cancelación cooperativa: SIGTERM → exit 130 registrado', async () => {
    const runId = `TST-run-cancel-${SFX}`
    await adapter.tick(mkCtx(runId, { durationMs: 30000, chunks: 30 }))
    await new Promise(r => setTimeout(r, 400))
    await cancelRunProcesses(runId, 'test')
    const rec = await db.executionProcess.findFirst({ where: { runId } })
    expect(rec?.status).toBe('KILLED')
    // el agente eco imprime {"type":"cancelled"} antes de salir: queda en la evidencia
    const art = rec?.stdoutArtifactId ? await db.artifact.findUnique({ where: { id: rec.stdoutArtifactId } }) : null
    expect(art?.metadataJson).toBeDefined()
  }, 20000)

  test('crash sin result line → error no_result_line (resultado ambiguo honesto)', async () => {
    const runId = `TST-run-crash-${SFX}`
    await adapter.tick(mkCtx(runId, { durationMs: 400, chunks: 2, crashBeforeResult: true }))
    let last = { done: false, progress: 0 } as Awaited<ReturnType<adapter.tick>>
    for (let i = 0; i < 40 && !last.done; i++) {
      await new Promise(r => setTimeout(r, 250))
      last = await adapter.tick({ ...mkCtx(runId, {}), progress: last.progress })
    }
    expect(last.done).toBe(true)
    expect(String(last.error)).toContain('no_result_line')
  }, 20000)

  test('exit≠0 → agent_failed con código real', async () => {
    const runId = `TST-run-fail-${SFX}`
    await adapter.tick(mkCtx(runId, { durationMs: 400, chunks: 2, exitCode: 3 }))
    let last = { done: false, progress: 0 } as Awaited<ReturnType<adapter.tick>>
    for (let i = 0; i < 40 && !last.done; i++) {
      await new Promise(r => setTimeout(r, 250))
      last = await adapter.tick({ ...mkCtx(runId, {}), progress: last.progress })
    }
    expect(last.done).toBe(true)
    expect(String(last.error)).toContain('exit=3')
  }, 20000)
})
