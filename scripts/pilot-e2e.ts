// ============================================================
// EEC V2 — PILOTO E2E OBLIGATORIO (§9 del mandato)
// bun run pilot   (o: bun scripts/pilot-e2e.ts)
//
// Demuestra el ciclo REAL completo con un agente de prueba que se
// ejecuta como PROCESO REAL separado del proceso web (agents/echo-agent).
// Pasos marcados [HTTP*] se ejecutan en tests/eec-v2/api-security.sh
// (necesitan el servidor HTTP vivo); aquí se cubren en proceso.
// ============================================================
import { readFileSync } from 'fs'
import { db, initDbPragmas } from '../src/lib/db'
import { bootEEC } from '../src/lib/eec/boot'
import { dispatchCommand, setSimulationMode } from '../src/lib/eec/commands'
import { runTicksOnce } from '../src/lib/eec/engine/workers'
import { validateManifest } from '../src/lib/eec/contracts/agent-manifest'
import { reconcileProcessesAfterBoot } from '../src/lib/eec/providers/adapters/local-process'

const SFX = Date.now().toString(36)
const results: Array<{ step: string; ok: boolean; detail: string }> = []

function report(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`)
}

async function waitUntil(pred: () => Promise<boolean>, maxMs = 20000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await runTicksOnce()
    if (await pred()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

async function main(): Promise<number> {
  console.log('=== PILOTO E2E — EEC V2: ejecución real, segura, persistente y observable ===\n')
  await initDbPragmas()
  await bootEEC()
  // el piloto ejercita el CAMINO REAL: los pasos usan el adaptador local-process;
  // el modo simulación se activa (marca eventos sim) pero el proceso es real y separado.
  setSimulationMode(true)

  // ---------- 1. Registro y validación del manifiesto ----------
  const rawManifest = JSON.parse(readFileSync('agents/echo-agent/manifest.json', 'utf8')) as unknown
  const v = validateManifest(rawManifest)
  report('1. manifiesto validado (contrato v1)', v.ok && v.manifest?.identity.code === 'ECO-01', v.ok ? `contract ${v.manifest!.contractVersion}` : v.errors.join('; '))
  if (!v.ok) return 1
  const manifest = v.manifest

  const bad = validateManifest({ ...rawManifest, contractVersion: '2.0.0' })
  report('1b. versión mayor incompatible rechazada', !bad.ok && bad.errors.join().includes('E_CONTRACT_MAJOR_MISMATCH'))

  // ---------- 2. Descubrimiento: registro del agente con manifiesto ----------
  const reg = await dispatchCommand({
    type: 'agent.register', requesterType: 'SYSTEM',
    payload: {
      code: manifest.identity.code, name: manifest.identity.name, role: 'Agente de prueba (piloto)',
      description: manifest.identity.description, provider: 'local-process',
      capabilities: [], skills: [], clearance: 'INTERNAL', manifest: rawManifest,
    },
    idempotencyKey: `pilot-reg-${SFX}`,
  })
  report('2. agente registrado con contrato', reg.ok, reg.ok ? `agentId=${reg.result?.agentId}` : reg.error)
  const agentId = String(reg.result?.agentId ?? '')

  // provider real SIN manifiesto → rechazo honesto
  const regNoManifest = await dispatchCommand({
    type: 'agent.register', requesterType: 'SYSTEM',
    payload: { code: `ECO-NOMAN-${SFX}`, name: 'Sin manifiesto', role: 'Prueba', provider: 'local-process', capabilities: [], skills: [], clearance: 'INTERNAL' },
  })
  report('2b. provider real sin manifiesto → rechazado', !regNoManifest.ok && String(regNoManifest.error).includes('manifest_required'))

  // ---------- 3. Comprobación de salud REAL (spawn de --eec-health) ----------
  const start = await dispatchCommand({ type: 'agent.start', requesterType: 'SYSTEM', payload: { agentId } })
  report('3. health check real superado (proceso --eec-health, exit 0)', start.ok, start.ok ? 'agente IDLE + HEALTHY' : start.error)

  // ---------- 4. Creación de tarea ----------
  const t1 = await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: { title: `[PILOTO] trabajo real ${SFX}`, kind: 'echo.work', priority: 'HIGH', risk: 'LOW', tags: ['piloto-v2'] },
  })
  const taskId = String(t1.result?.taskId ?? '')
  const asg = await dispatchCommand({ type: 'task.assign', requesterType: 'SYSTEM', payload: { taskId, agentId } })
  report('4. tarea creada y asignada', t1.ok && asg.ok, `task=${taskId}`)

  // ---------- 5-8. Ejecución real con aprobación por política ----------
  // política temporal: task.start exige aprobación humana (demuestra §5.6/5.7)
  const policy = await db.policy.create({
    data: {
      code: `PILOT-APPROVAL-${SFX}`, name: 'Piloto: task.start exige aprobación',
      type: 'APPROVAL', effect: 'REQUIRE_APPROVAL', enabled: true,
      actionJson: JSON.stringify(['task.start']), subjectJson: JSON.stringify({}),
      conditionsJson: '{}', priority: 100,
    },
  })
  const started = await dispatchCommand({ type: 'task.start', requesterType: 'HUMAN', payload: { taskId, input: { durationMs: 1600, chunks: 8 } } })
  report('5. política fuerza aprobación humana', started.ok === false && started.status === 'POLICY_CHECKED' && Boolean(started.approvalId), `approval=${started.approvalId ?? started.error}`)
  const approvalId = String(started.approvalId ?? '')
  const approved = await dispatchCommand({ type: 'approval.approve', requesterType: 'HUMAN', payload: { approvalId, note: 'piloto E2E' } })
  report('6. aprobación humana concedida y comando reanudado', approved.ok, `resumed=${JSON.stringify((approved.result as { resumed?: unknown } | undefined)?.resumed ?? approved.result ?? {})}`.slice(0, 120))
  // el resultado reanudado (commandId/status) no expone runId: se resuelve por evidencia persistida
  const resumedRun = await db.run.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } })
  const runId = String(resumedRun?.id ?? '')
  await db.policy.delete({ where: { id: policy.id } }).catch(() => undefined)

  // el proceso real debe existir con pid propio
  const procAlive = await waitUntil(async () => {
    const p = await db.executionProcess.findFirst({ where: { runId } })
    return Boolean(p && p.pid && p.status === 'ALIVE')
  })
  const proc = await db.executionProcess.findFirst({ where: { runId } })
  report('7. proceso REAL iniciado (separado del web)', procAlive && (proc?.pid ?? 0) > 0, proc ? `pid=${proc.pid} exec=${proc.executable.split('/').pop()}` : 'sin registro')

  // ---------- 8. resultado estructurado + persistencia + evidencia ----------
  const finished = await waitUntil(async () => {
    const r = await db.run.findUnique({ where: { id: runId } })
    return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNRECONCILED'].includes(r?.status ?? '')
  }, 30000)
  const run = await db.run.findUnique({ where: { id: runId } })
  const procFinal = await db.executionProcess.findFirst({ where: { runId } })
  const artifacts = procFinal?.stdoutArtifactId ? await db.artifact.findMany({ where: { id: { in: [procFinal.stdoutArtifactId, procFinal.stderrArtifactId].filter(Boolean) as string[] } } }) : []
  report('8. ejecución real completada con resultado validado', finished && run?.status === 'SUCCEEDED' && procFinal?.exitCode === 0,
    `run=${run?.status} exit=${procFinal?.exitCode} dur=${procFinal?.durationMs}ms evidencias=${artifacts.length}`)
  report('8b. eventos persistentes con correlación', (await db.eventRecord.count({ where: { subject: `run:${runId}` } })) > 0, '')

  // ---------- 9. visualización (§9.9): el resultado está expuesto por el API operativo ----------
  report('9. resultado visible vía API operativa', Boolean(run?.outputsJson && run.outputsJson.length > 2), 'run.outputsJson incluye result estructurado (GET /api/eec/agents / audit)')

  // ---------- 10. cancelación de proceso real ----------
  const t2 = await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: { title: `[PILOTO] cancelación ${SFX}`, kind: 'echo.heavy', risk: 'MEDIUM' },
  })
  const taskId2 = String(t2.result?.taskId ?? '')
  await dispatchCommand({ type: 'task.assign', requesterType: 'SYSTEM', payload: { taskId: taskId2, agentId } })
  const st2 = await dispatchCommand({ type: 'task.start', requesterType: 'HUMAN', payload: { taskId: taskId2, input: { durationMs: 60000, chunks: 60 } } })
  const runId2 = String(st2.result?.runId ?? '')
  await waitUntil(async () => {
    const p = await db.executionProcess.findFirst({ where: { runId: runId2 } })
    return p?.status === 'ALIVE'
  })
  const cancel = await dispatchCommand({ type: 'task.cancel', requesterType: 'HUMAN', payload: { taskId: taskId2, reason: 'piloto: cancelación' } })
  await new Promise(r => setTimeout(r, 500))
  const proc2 = await db.executionProcess.findFirst({ where: { runId: runId2 }, orderBy: { startedAt: 'desc' } })
  const run2 = await db.run.findUnique({ where: { id: runId2 } })
  report('10. cancelación: proceso real terminado (SIGTERM→SIGKILL) y run CANCELLED',
    cancel.ok && run2?.status === 'CANCELLED' && (proc2?.status === 'KILLED' || proc2?.status === 'EXITED'), proc2 ? `estado=${proc2.status} pid=${proc2.pid}` : 'sin proc')

  // ---------- 11. fallo real del proceso y recuperación controlada ----------
  const t3 = await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: { title: `[PILOTO] fallo real ${SFX}`, kind: 'echo.work', risk: 'LOW' },
  })
  const taskId3 = String(t3.result?.taskId ?? '')
  await dispatchCommand({ type: 'task.assign', requesterType: 'SYSTEM', payload: { taskId: taskId3, agentId } })
  const st3 = await dispatchCommand({ type: 'task.start', requesterType: 'HUMAN', payload: { taskId: taskId3, input: { durationMs: 800, chunks: 4, exitCode: 3 } } })
  const runId3 = String(st3.result?.runId ?? '')
  await waitUntil(async () => {
    const r = await db.run.findUnique({ where: { id: runId3 } })
    return ['FAILED', 'SUCCEEDED', 'UNRECONCILED'].includes(r?.status ?? '')
  }, 20000)
  const run3 = await db.run.findUnique({ where: { id: runId3 } })
  const proc3 = await db.executionProcess.findFirst({ where: { runId: runId3 }, orderBy: { startedAt: 'desc' } })
  const task3 = await db.task.findUnique({ where: { id: taskId3 } })
  report('11. fallo real: exit≠0 → run FAILED (no disfrazado)',
    run3?.status === 'FAILED' && proc3?.exitCode === 3 && task3?.status === 'FAILED',
    `exit=${proc3?.exitCode} run=${run3?.status} task=${task3?.status}`)

  // 11b. resultado ambiguo (crash sin result line) → FAILED con evidencia, nunca inventado
  const t4 = await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: { title: `[PILOTO] crash sin resultado ${SFX}`, kind: 'echo.work', risk: 'LOW' },
  })
  const taskId4 = String(t4.result?.taskId ?? '')
  await dispatchCommand({ type: 'task.assign', requesterType: 'SYSTEM', payload: { taskId: taskId4, agentId } })
  const st4 = await dispatchCommand({ type: 'task.start', requesterType: 'HUMAN', payload: { taskId: taskId4, input: { durationMs: 600, chunks: 3, crashBeforeResult: true } } })
  const runId4 = String(st4.result?.runId ?? '')
  await waitUntil(async () => {
    const r = await db.run.findUnique({ where: { id: runId4 } })
    return ['FAILED', 'SUCCEEDED', 'UNRECONCILED'].includes(r?.status ?? '')
  }, 20000)
  const run4 = await db.run.findUnique({ where: { id: runId4 } })
  report('11b. proceso muerto SIN result → FAILED (no_result_line), nunca completado',
    run4?.status === 'FAILED' && String(run4?.error).includes('no_result_line'), String(run4?.error ?? '').slice(0, 90))

  // ---------- 12. reinicio + reconciliación (simulada con la MISMA función de boot) ----------
  const deadPid = await findDeadPid()
  const synthRun = await db.run.create({ data: { agentId, taskId: null, status: 'RUNNING', currentNode: 'EXECUTE', progress: 40, startedAt: new Date() } })
  await db.executionProcess.create({
    data: { runId: synthRun.id, agentId, executable: '/bin/false', argsJson: '[]', status: 'ALIVE', pid: deadPid, startedAt: new Date(Date.now() - 60_000) },
  })
  const rec = await reconcileProcessesAfterBoot()
  const recRun = await db.run.findUnique({ where: { id: synthRun.id } })
  const recProc = await db.executionProcess.findFirst({ where: { runId: synthRun.id } })
  report('12. reconciliación post-reinicio: pid muerto → UNRECONCILED (no completado)',
    rec.unreconciled >= 1 && recRun?.status === 'UNRECONCILED' && recProc?.status === 'UNRECONCILED',
    `pid=${deadPid} run=${recRun?.status} proc=${recProc?.status}`)
  await db.run.delete({ where: { id: synthRun.id } }).catch(() => undefined)
  await db.executionProcess.deleteMany({ where: { runId: synthRun.id } }).catch(() => undefined)

  // ---------- 13. rechazo de solicitudes no autorizadas ----------
  // 13a. en proceso: agente AGENT sin permiso command.task.create → DENIED
  const denied = await dispatchCommand({ type: 'task.create', requesterType: 'AGENT', requesterId: agentId, payload: { title: `No permitida ${SFX}`, kind: 'generic' } })
  report('13. autorización: agente sin permiso → REJECTED', !denied.ok && denied.status === 'REJECTED', String(denied.error))
  // 13b. vía HTTP (identidad suplantada) → cubierto por tests/eec-v2/api-security.sh (401)
  console.log('   [HTTP] rechazo de peticiones sin credencial → tests/eec-v2/api-security.sh')

  // ---------- 14. idempotencia ----------
  const key = `pilot-idem-${SFX}`
  const r1 = await dispatchCommand({ type: 'task.create', requesterType: 'HUMAN', payload: { title: `[PILOTO] idempotente ${SFX}`, kind: 'generic' }, idempotencyKey: key })
  const r2 = await dispatchCommand({ type: 'task.create', requesterType: 'HUMAN', payload: { title: `[PILOTO] idempotente ${SFX}`, kind: 'generic' }, idempotencyKey: key })
  const dupCount = await db.task.count({ where: { title: `[PILOTO] idempotente ${SFX}` } })
  report('14. idempotencia: misma clave → 1 sola tarea', r1.ok && r2.duplicate === true && dupCount === 1, `tareas=${dupCount}`)

  // ---------- 15. evidencia final: los procesos existieron y terminaron ----------
  const procs = await db.executionProcess.findMany({ where: { agentId }, orderBy: { startedAt: 'asc' } })
  const pids = procs.map(p => p.pid).filter(Boolean) as number[]
  const allEnded = procs.every(p => ['EXITED', 'KILLED', 'TIMEOUT', 'SPAWN_FAILED', 'UNRECONCILED'].includes(p.status))
  report('15. evidencia: procesos reales con pids distintos y fin registrado',
    procs.length >= 4 && new Set(pids).size === pids.length && allEnded,
    `procesos=${procs.length} pids=[${pids.join(', ')}]`)

  // ---------- limpieza ----------
  for (const tid of [taskId, taskId2, taskId3, taskId4]) {
    await db.task.deleteMany({ where: { id: tid } }).catch(() => undefined)
  }
  await db.run.deleteMany({ where: { agentId } }).catch(() => undefined)
  await db.executionProcess.deleteMany({ where: { agentId } }).catch(() => undefined)
  await db.artifact.deleteMany({ where: { metadataJson: { contains: 'PILOTO' } } }).catch(() => undefined)
  await db.session.deleteMany({ where: { agentId } }).catch(() => undefined)
  await db.agentRuntime.deleteMany({ where: { agentId } }).catch(() => undefined)
  await db.memoryRecord.deleteMany({ where: { agentId } }).catch(() => undefined)
  await db.agent.delete({ where: { id: agentId } }).catch(() => undefined)
  await db.task.deleteMany({ where: { title: { contains: `[PILOTO]` } } }).catch(() => undefined)
  await db.$disconnect()

  const failed = results.filter(r => !r.ok)
  console.log(`\n=== RESULTADO DEL PILOTO: ${results.length - failed.length}/${results.length} pasos OK ===`)
  if (failed.length > 0) {
    console.log('FALLOS:')
    for (const f of failed) console.log(`  ✗ ${f.step}: ${f.detail}`)
    return 1
  }
  console.log('La EEC demostró coordinar ejecuciones REALES, seguras, persistentes y observables.')
  return 0
}

async function findDeadPid(): Promise<number> {
  // busca un pid que NO esté vivo (para la reconciliación sintética)
  for (let pid = 4000; pid < 40000; pid += 7) {
    try { process.kill(pid, 0) } catch { return pid }
  }
  return 999999
}

main().then(code => process.exit(code)).catch((e) => {
  console.error('PILOTO CRASH:', e)
  process.exit(1)
})
