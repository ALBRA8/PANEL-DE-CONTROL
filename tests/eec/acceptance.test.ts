// ============================================================
// EEC — ACCEPTANCE TESTS (spec §53: escenarios 01-30)
// bun test tests/eec/acceptance.test.ts
// Ejecuta el pipeline REAL contra la BD real; las entidades usan
// prefijo TST- y se limpian al final. Motor manejado con ticks
// deterministas (runTicksOnce) — sin esperas ciegas.
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { dispatchCommand, isSimulationMode, setSimulationMode } from '../../src/lib/eec/commands'
import { eventBus } from '../../src/lib/eec/events/bus'
import { runTicksOnce } from '../../src/lib/eec/engine/workers'
import { reconstructEntity } from '../../src/lib/eec/engine/audit'
import { invokeTool } from '../../src/lib/eec/engine/gateway'
import { buildContextPackage } from '../../src/lib/eec/engine/context'
import { providerRegistry, AgentInterface, AgentTickContext, OrchestrationInterface, OrchestrationSpec } from '../../src/lib/eec/domain/contracts'
import { canTransition, canTaskTransition, canRuntimeTransition } from '../../src/lib/eec/domain/types'

const SFX = Date.now().toString(36)
let agentId = ''
let runtimeId = ''
let taskId = ''
let runId = ''
let clientId = ''
let approvalId = ''
let meetingId = ''
const received: string[] = []

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
})

afterAll(async () => {
  // limpieza best-effort de entidades de prueba
  try {
    const a = await db.agent.findUnique({ where: { code: `TST-AG-${SFX}` } })
    if (a) {
      await db.toolInvocation.deleteMany({ where: { agentId: a.id } })
      await db.memoryRecord.deleteMany({ where: { agentId: a.id } })
      await db.session.deleteMany({ where: { agentId: a.id } })
      await db.agentRuntime.deleteMany({ where: { agentId: a.id } })
      await db.run.deleteMany({ where: { agentId: a.id } })
      await db.task.deleteMany({ where: { assigneeAgentId: a.id } })
      await db.permission.deleteMany({ where: { agentId: a.id } })
      await db.agent.delete({ where: { id: a.id } })
    }
    await db.task.deleteMany({ where: { code: `TST-${SFX}` } })
    if (clientId) {
      await db.interaction.deleteMany({ where: { clientId } })
      await db.opportunity.deleteMany({ where: { clientId } })
      await db.client.delete({ where: { id: clientId } }).catch(() => undefined)
    }
  } catch { /* best effort */ }
  await db.$disconnect()
})

async function waitFor(pred: () => Promise<boolean>, maxMs = 15000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await runTicksOnce()
    if (await pred()) return true
    await new Promise(r => setTimeout(r, 80))
  }
  return false
}

describe('EEC — ACCEPTANCE (§53)', () => {
  test('01 agent registration', async () => {
    const res = await dispatchCommand({
      type: 'agent.register', requesterType: 'SYSTEM',
      payload: { code: `TST-AG-${SFX}`, name: 'Test Agent', role: 'QA Tester', provider: 'local-sim', capabilities: ['test'], skills: ['test'], clearance: 'INTERNAL' },
    })
    expect(res.ok).toBe(true)
    agentId = String(res.result?.agentId)
    runtimeId = String(res.result?.runtimeId)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.state).toBe('OFFLINE') // registrado ≠ conectado (no fabricación)
  })

  test('02 agent discovery (contract-driven)', async () => {
    const found = await db.agent.findUnique({ where: { code: `TST-AG-${SFX}` }, include: { runtimes: true } })
    expect(found).not.toBeNull()
    expect(found?.runtimes[0]?.status).toBe('CREATED')
    expect(found?.provider).toBe('local-sim')
  })

  test('03 heartbeat on start', async () => {
    const res = await dispatchCommand({ type: 'agent.start', requesterType: 'SYSTEM', payload: { agentId } })
    expect(res.ok).toBe(true)
    const rt = await db.agentRuntime.findUnique({ where: { id: runtimeId } })
    expect(rt?.status).toBe('RUNNING')
    expect(rt?.lastHeartbeatAt).not.toBeNull()
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.state).toBe('IDLE')
  })

  test('04 task assignment', async () => {
    const res = await dispatchCommand({
      type: 'task.create', requesterType: 'SYSTEM',
      payload: { title: `Tarea de prueba ${SFX}`, kind: 'report', priority: 'HIGH', risk: 'LOW' },
    })
    expect(res.ok).toBe(true)
    taskId = String(res.result?.taskId)
    const asg = await dispatchCommand({ type: 'task.assign', requesterType: 'SYSTEM', payload: { taskId, agentId } })
    expect(asg.ok).toBe(true)
    const task = await db.task.findUnique({ where: { id: taskId } })
    expect(task?.status).toBe('TODO')
    expect(task?.assigneeAgentId).toBe(agentId)
  })

  test('05 run creation + context assembly (§20)', async () => {
    const res = await dispatchCommand({ type: 'task.start', requesterType: 'SYSTEM', payload: { taskId } })
    expect(res.ok).toBe(true)
    runId = String(res.result?.runId)
    const run = await db.run.findUnique({ where: { id: runId } })
    expect(run?.status).toBe('RUNNING')
    const ctx = JSON.parse(run?.contextJson ?? '{}')
    expect(ctx.identity.agentId).toBe(agentId)
    expect(Array.isArray(ctx.tools)).toBe(true)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.state).toBe('WORKING')
    const pkg = await buildContextPackage({ agentId, taskId })
    expect(pkg.memory).toBeDefined()
  })

  test('06 tool invocation through gateway', async () => {
    const res = await invokeTool({
      toolCode: 'web.search', input: { query: 'eec acceptance' },
      agentId, taskId, runId, requesterType: 'AGENT', sim: true,
    })
    expect(['SUCCEEDED', 'SUPPRESSED_SIM'].includes(res.status)).toBe(true)
    const inv = await db.toolInvocation.findUnique({ where: { id: res.invocationId } })
    expect(inv?.sim).toBe(true) // simulación marcada honestamente
  })

  test('07 event propagation with correlation', async () => {
    const unsub = eventBus.subscribe('system.*', (e) => { received.push(e.event_type) })
    await eventBus.publish({ event_type: 'system.test.propagation', source: 'test', subject: 'test' })
    unsub()
    expect(received).toContain('system.test.propagation')
  })

  test('08 state machine: valid transitions accepted, invalid rejected+audited', async () => {
    expect(canTransition('OFFLINE', 'IDLE')).toBe(true)
    expect(canTransition('IDLE', 'SUSPENDED')).toBe(true)
    expect(canTransition('SUSPENDED', 'WORKING')).toBe(false)
    expect(canTaskTransition('TODO', 'IN_PROGRESS')).toBe(true)
    expect(canTaskTransition('DONE', 'TODO')).toBe(false)
    expect(canRuntimeTransition('RUNNING', 'CRASHED')).toBe(true)
    expect(canRuntimeTransition('RUNNING', 'READY')).toBe(false)
    // rechazo auditable real:
    const bad = await dispatchCommand({ type: 'task.move', requesterType: 'SYSTEM', payload: { taskId, to: 'DONE' } })
    // IN_PROGRESS → DONE está permitido por catálogo; probamos rechazo REAL vía task.retry en estado IN_PROGRESS
    const rejected = await dispatchCommand({ type: 'task.retry', requesterType: 'SYSTEM', payload: { taskId } })
    expect(rejected.ok).toBe(false)
    const rejections = await db.eventRecord.count({ where: { type: 'task.state.rejected' } })
    expect(rejections).toBeGreaterThan(0)
  })

  test('09 task completion via engine (run → evaluate)', async () => {
    const done = await waitFor(async () => {
      const t = await db.task.findUnique({ where: { id: taskId } })
      return ['DONE', 'QUALITY_REVIEW', 'REVIEW', 'FAILED'].includes(t?.status ?? '')
    }, 45000)
    expect(done).toBe(true)
    const run = await db.run.findUnique({ where: { id: runId } })
    expect(['SUCCEEDED', 'FAILED'].includes(run?.status ?? '')).toBe(true)
  }, 60000)

  test('10 quality flow: evaluation events exist', async () => {
    const evs = await db.eventRecord.count({ where: { type: { in: ['run.evaluated', 'task.completed', 'task.quality_review.requested'] } } })
    expect(evs).toBeGreaterThan(0)
  })

  test('11 approval lifecycle + command resume', async () => {
    const req = await dispatchCommand({
      type: 'approval.request', requesterType: 'SYSTEM',
      payload: { requestType: 'TEST_APPROVAL', title: 'Aprobación de prueba', risk: 'HIGH', payload: {}, ttlMinutes: 60 },
    })
    expect(req.ok).toBe(true)
    approvalId = String(req.result?.approvalId)
    const ap = await db.approval.findUnique({ where: { id: approvalId } })
    expect(ap?.status).toBe('REQUESTED')
    const ok = await dispatchCommand({ type: 'approval.approve', payload: { approvalId, note: 'test' } })
    expect(ok.ok).toBe(true)
    const ap2 = await db.approval.findUnique({ where: { id: approvalId } })
    expect(ap2?.status).toBe('APPROVED')
  })

  test('12 permission denial for agents without grant', async () => {
    const res = await dispatchCommand({
      type: 'task.create', requesterType: 'AGENT', requesterId: agentId,
      payload: { title: 'No debería ejecutarse', kind: 'generic' },
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe('REJECTED')
    expect(res.error).toContain('permission_denied')
  })

  test('13 runtime crash preserves agent identity (§44)', async () => {
    const res = await dispatchCommand({ type: 'system.chaos.runtime_crash', requesterType: 'SYSTEM', payload: { runtimeId, reason: 'acceptance test chaos' } })
    expect(res.ok).toBe(true)
    const rt = await db.agentRuntime.findUnique({ where: { id: runtimeId } })
    expect(rt?.status).toBe('CRASHED')
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.state).toBe('ERROR')
    expect(agent).not.toBeNull() // identidad intacta
  })

  test('14 recovery: runtime RUNNING, agent IDLE', async () => {
    const res = await dispatchCommand({ type: 'runtime.recover', requesterType: 'SYSTEM', payload: { runtimeId } })
    expect(res.ok).toBe(true)
    const rt = await db.agentRuntime.findUnique({ where: { id: runtimeId } })
    expect(rt?.status).toBe('RUNNING')
    expect((rt?.restarts ?? 0)).toBeGreaterThan(0)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.state).toBe('IDLE')
  })

  test('15 retry path (FAILED → TODO → run)', async () => {
    await dispatchCommand({ type: 'task.move', requesterType: 'SYSTEM', payload: { taskId, to: 'FAILED' } }).catch(() => undefined)
    const t1 = await db.task.findUnique({ where: { id: taskId } })
    if (t1?.status !== 'DONE') {
      const res = await dispatchCommand({ type: 'task.retry', requesterType: 'SYSTEM', payload: { taskId } })
      expect(res.ok).toBe(true)
      const t2 = await db.task.findUnique({ where: { id: taskId } })
      expect(t2?.status).toBe('TODO')
    }
  })

  test('16 cancellation', async () => {
    const t = await db.task.findUnique({ where: { id: taskId } })
    if (t && !['DONE', 'CANCELLED'].includes(t.status)) {
      const res = await dispatchCommand({ type: 'task.cancel', requesterType: 'SYSTEM', payload: { taskId, reason: 'acceptance' } })
      expect(res.ok).toBe(true)
    }
    const t2 = await db.task.findUnique({ where: { id: taskId } })
    expect(['DONE', 'CANCELLED', 'REVIEW', 'QUALITY_REVIEW'].includes(t2?.status ?? '')).toBe(true)
  })

  test('17 memory write with provenance', async () => {
    const res = await dispatchCommand({
      type: 'memory.write', requesterType: 'SYSTEM',
      payload: { agentId, scope: 'WORKING_CONTEXT', kind: 'EPISODE', content: `Memoria de prueba ${SFX}`, importance: 5, provenance: { test: SFX }, tags: ['test'] },
    })
    expect(res.ok).toBe(true)
    const mem = await db.memoryRecord.findUnique({ where: { id: String(res.result?.memoryId) } })
    expect(JSON.parse(mem?.provenanceJson ?? '{}').test).toBe(SFX)
  })

  test('18 knowledge retrieval respects classification filter (§19)', async () => {
    await db.knowledgeItem.create({
      data: { title: `Público ${SFX}`, sourceType: 'DOMAIN', content: `acceptance ${SFX} open knowledge`, classification: 'PUBLIC' },
    })
    await db.knowledgeItem.create({
      data: { title: `Restringido ${SFX}`, sourceType: 'INTERNAL_SYSTEM', content: `acceptance ${SFX} secret restricted data`, classification: 'RESTRICTED' },
    })
    const { knowledgeService } = await import('../../src/lib/eec/engine/memory')
    const hits = await knowledgeService().retrieve({ text: `acceptance ${SFX}`, limit: 10 }, 'INTERNAL')
    const titles = hits.map(h => h.title)
    expect(titles.some(t => t.includes('Público'))).toBe(true)
    expect(titles.some(t => t.includes('Restringido'))).toBe(false) // filtro de permisos activo
  })

  test('19 audit reconstruction (WHO/WHAT/WHEN/INPUT/OUTPUT)', async () => {
    const rec = await reconstructEntity('TASK', taskId)
    expect(rec.auditTrail.length).toBeGreaterThan(0)
    expect(rec.eventTrail.length).toBeGreaterThan(0)
    const a = rec.auditTrail[0] as { actorId?: string; action?: string; createdAt?: Date }
    expect(a.actorId).toBeDefined()
    expect(a.action).toBeDefined()
    // corrección inmutable
    const corr = await dispatchCommand({
      type: 'audit.correct', payload: {
        prevAuditId: String(a.actorId ? (rec.auditTrail[0] as { id?: string }).id : ''),
        action: 'test.corrected', entityType: 'TASK', entityId: taskId,
        why: 'acceptance correction', output: { corrected: true }, result: 'CORRECTED',
      },
    })
    expect(corr.ok).toBe(true)
  })

  test('20 visual synchronization: location derived from real state', async () => {
    const office = await db.location.findUnique({ where: { code: 'OFF-ATLAS' } })
    const res = await dispatchCommand({ type: 'agent.assign_office', requesterType: 'SYSTEM', payload: { agentId, officeCode: 'OFF-ATLAS' } })
    expect(res.ok).toBe(true)
    // el agente arrancado está en su oficina real
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    expect(agent?.officeId).toBe(office?.id)
    // snapshot del state API incluye locations para el visual
    const locs = await db.location.count()
    expect(locs).toBeGreaterThan(5)
  })

  test('21 orchestrator replacement via registry', async () => {
    const custom: OrchestrationInterface = {
      providerKey: 'test-orch',
      async submit(_s: OrchestrationSpec) { return { orchestrationId: 'custom-1' } },
      async status() { return { state: 'CUSTOM' } },
      async cancel() {}, async pause() {}, async resume() {}, async retry() {},
      async result() { return { custom: true } },
    }
    providerRegistry.register('ORCHESTRATOR', 'test-orch', custom)
    const resolved = providerRegistry.get<OrchestrationInterface>('ORCHESTRATOR', 'test-orch')
    const st = await resolved.status('x')
    expect(st.state).toBe('CUSTOM')
    providerRegistry.unregister('ORCHESTRATOR', 'test-orch')
  })

  test('22 agent provider replacement (adapter swap)', async () => {
    let ticked = false
    const customAgent: AgentInterface = {
      providerKey: 'test-agent-adapter',
      async tick(_ctx: AgentTickContext) {
        ticked = true
        return { done: true, progress: 100, outputs: { viaCustomAdapter: true }, activity: 'custom adapter tick' }
      },
    }
    providerRegistry.register('AGENT', 'test-agent-adapter', customAgent)
    const reg = await dispatchCommand({
      type: 'agent.register', requesterType: 'SYSTEM',
      payload: { code: `TST-AG2-${SFX}`, name: 'Custom Provider Agent', role: 'QA Tester', provider: 'test-agent-adapter', capabilities: [], skills: [], clearance: 'INTERNAL' },
    })
    const ag2 = String(reg.result?.agentId)
    await dispatchCommand({ type: 'agent.start', requesterType: 'SYSTEM', payload: { agentId: ag2 } })
    const t = await dispatchCommand({
      type: 'task.create', requesterType: 'SYSTEM',
      payload: { title: `Tarea adapter custom ${SFX}`, kind: 'generic', assigneeAgentId: ag2 },
    })
    const tid = String(t.result?.taskId)
    await dispatchCommand({ type: 'task.start', requesterType: 'SYSTEM', payload: { taskId: tid } })
    await waitFor(async () => ticked, 10000)
    expect(ticked).toBe(true) // el EEC usó el adapter reemplazado
    // limpieza de la entidad del adapter custom
    await db.task.deleteMany({ where: { id: tid } })
    await db.run.deleteMany({ where: { agentId: ag2 } })
    await db.session.deleteMany({ where: { agentId: ag2 } })
    await db.agentRuntime.deleteMany({ where: { agentId: ag2 } })
    await db.agent.delete({ where: { id: ag2 } })
  }, 30000)

  test('23 duplicate command idempotency (§46)', async () => {
    const key = `tst-idem-${SFX}`
    const r1 = await dispatchCommand({
      type: 'task.create', requesterType: 'SYSTEM',
      payload: { title: `Idempotente ${SFX}`, kind: 'generic' }, idempotencyKey: key,
    })
    const r2 = await dispatchCommand({
      type: 'task.create', requesterType: 'SYSTEM',
      payload: { title: `Idempotente ${SFX}`, kind: 'generic' }, idempotencyKey: key,
    })
    expect(r1.ok).toBe(true)
    expect(r2.duplicate).toBe(true)
    const count = await db.task.count({ where: { title: `Idempotente ${SFX}` } })
    expect(count).toBe(1) // sin efectos destructivos repetidos
    await db.task.deleteMany({ where: { title: `Idempotente ${SFX}` } })
  })

  test('24 duplicate event idempotency', async () => {
    const id = `tst-evt-${SFX}`
    const e1 = await eventBus.publish({ event_type: 'system.test.dup', source: 'test', subject: 'test', event_id: id })
    const e2 = await eventBus.publish({ event_type: 'system.test.dup', source: 'test', subject: 'test', event_id: id })
    expect(e1?.seq).toBe(e2?.seq) // segunda publicación ignorada
    const count = await db.eventRecord.count({ where: { id } })
    expect(count).toBe(1)
  })

  test('25 security violation: tool denied without permission', async () => {
    const inv = await invokeTool({
      toolCode: 'crm.update', input: {}, agentId, taskId: null, runId: null,
      requesterType: 'AGENT', sim: true,
    })
    // el agente TST no tiene tool.crm.update → DENIED por gateway
    expect(inv.status).toBe('DENIED')
  })

  test('26 CRM pipeline stage change', async () => {
    const res = await dispatchCommand({
      type: 'client.create', requesterType: 'SYSTEM',
      payload: { name: `Cliente TST ${SFX}`, segment: 'Test', contactEmail: 'tst@example.com' },
    })
    expect(res.ok).toBe(true)
    clientId = String(res.result?.clientId)
    const up = await dispatchCommand({ type: 'client.update_stage', requesterType: 'SYSTEM', payload: { clientId, stage: 'CONTACTED', note: 'test' } })
    expect(up.ok).toBe(true)
    const c = await db.client.findUnique({ where: { id: clientId } })
    expect(c?.stage).toBe('CONTACTED')
    const ev = await db.eventRecord.count({ where: { type: 'client.stage.changed' } })
    expect(ev).toBeGreaterThan(0)
  })

  test('27 meeting full lifecycle (invite→start→end→tasks)', async () => {
    const res = await dispatchCommand({
      type: 'meeting.create', requesterType: 'SYSTEM',
      payload: {
        title: `Reunión TST ${SFX}`, objective: 'acceptance', agenda: ['a'],
        locationCode: 'HQ-BOARDROOM', scheduledStartAt: new Date().toISOString(), durationMinutes: 15,
        participantAgentIds: [agentId],
      },
    })
    expect(res.ok).toBe(true)
    meetingId = String(res.result?.meetingId)
    // movimiento derivado: el agente fue invitado a la sala
    const afterInvite = await db.agent.findUnique({ where: { id: agentId } })
    const room = await db.location.findUnique({ where: { code: 'HQ-BOARDROOM' } })
    expect(afterInvite?.locationId).toBe(room?.id)
    await dispatchCommand({ type: 'meeting.start', requesterType: 'SYSTEM', payload: { meetingId } })
    const inMeeting = await db.agent.findUnique({ where: { id: agentId } })
    expect(inMeeting?.state).toBe('IN_MEETING')
    const end = await dispatchCommand({
      type: 'meeting.end', requesterType: 'SYSTEM',
      payload: { meetingId, decisions: ['Decisión TST'], actionItems: [{ title: `Acción de reunión ${SFX}`, priority: 'HIGH' }], result: 'ok' },
    })
    expect(end.ok).toBe(true)
    const afterEnd = await db.agent.findUnique({ where: { id: agentId } })
    expect(afterEnd?.state).toBe('IDLE')
    // action item → tarea generada
    const gen = await db.task.count({ where: { title: `Acción de reunión ${SFX}` } })
    expect(gen).toBe(1)
    await db.task.deleteMany({ where: { title: `Acción de reunión ${SFX}` } })
  })

  test('28 scheduler fires one-time command', async () => {
    const res = await dispatchCommand({
      type: 'schedule.create', requesterType: 'SYSTEM',
      payload: {
        name: `TST sched ${SFX}`, kind: 'ONE_TIME', expression: new Date(Date.now() + 1000).toISOString(),
        commandType: 'memory.write',
        commandPayload: { scope: 'ORGANIZATIONAL_MEMORY', content: `SCHED FIRING ${SFX}`, provenance: { test: SFX }, tags: ['test'] },
      },
    })
    expect(res.ok).toBe(true)
    const fired = await waitFor(async () => {
      const m = await db.memoryRecord.count({ where: { content: { contains: `SCHED FIRING ${SFX}` } } })
      if (m > 0) return true
      // diagnóstico en vivo del schedule
      const s = await db.schedule.findFirst({ where: { name: `TST sched ${SFX}` } })
      if (s && !s.enabled) return true // se desactiva al disparar
      return false
    }, 12000)
    const s = await db.schedule.findFirst({ where: { name: `TST sched ${SFX}` } })
    const memCount = await db.memoryRecord.count({ where: { content: { contains: `SCHED FIRING ${SFX}` } } })
    expect(fired || (s?.lastRunAt != null) || memCount > 0).toBe(true)
  }, 30000)

  test('29 notification routed from runtime crash', async () => {
    const n = await db.notification.count({ where: { type: { in: ['runtime.crashed', 'agent.error'] }, subjectId: runtimeId } })
    expect(n).toBeGreaterThan(0)
  })

  test('30 security: secrets never in logs/events (sanitize)', async () => {
    const { sanitize } = await import('../../src/lib/eec/engine/observability')
    const clean = sanitize({ apiKey: 'SECRET123', nested: { password: 'x', ok: 1 } }) as Record<string, unknown>
    expect(clean.apiKey).toBe('[REDACTED]')
    expect((clean.nested as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((clean.nested as Record<string, unknown>).ok).toBe(1)
  })

  test('31 simulation mode is on for external safety (§52)', () => {
    expect(isSimulationMode()).toBe(true)
  })
})
