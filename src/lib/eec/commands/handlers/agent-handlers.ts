// ============================================================
// EEC — HANDLERS: agent.* y runtime.* (spec §7, §8, §16)
// El agente es identidad permanente; el runtime es proceso ejecutable.
// El fallo del runtime NUNCA destruye la identidad del agente.
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { setAgentState, setAgentLocation, TransitionError } from '../../engine/state'
import { writeAudit } from '../../engine/audit'
import { providerRegistry, RuntimeInterface } from '../../domain/contracts'
import { canRuntimeTransition } from '../../domain/types'

export function registerAgentHandlers(): void {
  // ---------------- agent.register (§16) ----------------
  registerCommandHandler('agent.register', async ({ payload, sim }) => {
    const p = payload as {
      code: string; name: string; role: string; description?: string
      provider: string; endpoint?: string; departmentCode?: string; officeCode?: string
      capabilities: string[]; skills: string[]; clearance: string
    }
    const exists = await db.agent.findUnique({ where: { code: p.code } })
    if (exists) return { agentId: exists.id, note: 'already_registered' }

    const department = p.departmentCode ? await db.department.findUnique({ where: { code: p.departmentCode } }) : null
    const office = p.officeCode ? await db.location.findUnique({ where: { code: p.officeCode } }) : null

    const agent = await db.agent.create({
      data: {
        code: p.code, name: p.name, role: p.role, description: p.description,
        provider: p.provider, endpoint: p.endpoint,
        capabilitiesJson: JSON.stringify(p.capabilities),
        skillsJson: JSON.stringify(p.skills),
        registrationJson: JSON.stringify({ clearance: p.clearance, registeredVia: 'command' }),
        departmentId: department?.id, officeId: office?.id,
        state: 'OFFLINE', healthStatus: 'UNKNOWN',
      },
    })
    // runtime inicial CREATED — el agente NO está conectado hasta agent.start
    const runtime = await db.agentRuntime.create({
      data: { agentId: agent.id, provider: p.provider, status: 'CREATED', endpoint: p.endpoint },
    })
    await eventBus.publish({
      event_type: 'agent.registered', source: 'eec.agents', subject: `agent:${agent.id}`,
      payload: { agentId: agent.id, code: agent.code, role: agent.role, provider: p.provider, runtimeId: runtime.id },
      sim,
    })
    await writeAudit({
      actorId: 'eec:agents', actorType: 'SYSTEM', action: 'agent.register',
      entityType: 'AGENT', entityId: agent.id, input: p, result: 'REGISTERED',
      why: 'registro de identidad permanente + runtime CREATED',
    })
    return { agentId: agent.id, runtimeId: runtime.id, state: 'OFFLINE' }
  })

  // ---------------- agent.start ----------------
  registerCommandHandler('agent.start', async ({ payload, sim }) => {
    const p = payload as { agentId?: string; code?: string }
    const agent = await db.agent.findUnique({
      where: p.agentId ? { id: p.agentId } : { code: p.code! },
      include: { runtimes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    if (!agent) throw new Error(`AGENT_NOT_FOUND`)
    let runtime = agent.runtimes[0]
    if (!runtime) {
      runtime = await db.agentRuntime.create({ data: { agentId: agent.id, provider: agent.provider } })
    }
    // transiciones de runtime validadas: →STARTING→READY→RUNNING
    let status = runtime.status
    for (const next of ['STARTING', 'READY', 'RUNNING']) {
      if (!canRuntimeTransition(status, next)) continue
      status = next
      runtime = await db.agentRuntime.update({
        where: { id: runtime.id },
        data: { status: next, startedAt: runtime.startedAt ?? new Date(), lastHeartbeatAt: new Date(), health: 'HEALTHY' },
      })
      await eventBus.publish({
        event_type: 'runtime.state.changed', source: 'eec.runtimes', subject: `runtime:${runtime.id}`,
        payload: { runtimeId: runtime.id, agentId: agent.id, status: next }, sim,
      })
    }

    const session = await db.session.create({
      data: {
        agentId: agent.id, runtimeId: runtime.id, status: 'ACTIVE',
        purpose: 'operational session', startedAt: new Date(),
      },
    })

    // estado del agente hacia IDLE (validado; ERROR pasa por RECOVERY)
    try {
      if (agent.state === 'ERROR') {
        await setAgentState(agent.id, 'RECOVERY', 'agent.start: recovering', { sim })
      }
      await setAgentState(agent.id, 'IDLE', 'agent.start', { sim, activity: 'Conectado y disponible' })
    } catch (e) {
      if (!(e instanceof TransitionError && agent.state === 'IDLE')) throw e
    }
    if (agent.officeId) await setAgentLocation(agent.id, agent.officeId, 'agent.start: vuelve a su oficina', sim)

    await eventBus.publish({
      event_type: 'agent.started', source: 'eec.agents', subject: `agent:${agent.id}`,
      payload: { agentId: agent.id, code: agent.code, runtimeId: runtime.id, sessionId: session.id }, sim,
    })
    await writeAudit({
      actorId: 'eec:agents', actorType: 'SYSTEM', action: 'agent.start',
      entityType: 'AGENT', entityId: agent.id, input: p,
      output: { runtimeId: runtime.id, sessionId: session.id }, result: 'RUNNING',
    })
    return { agentId: agent.id, runtimeId: runtime.id, sessionId: session.id, state: 'IDLE' }
  })

  // ---------------- agent.pause / resume / suspend / wake / stop ----------------
  registerCommandHandler('agent.pause', async ({ payload, sim }) => {
    const { agentId } = payload as { agentId: string }
    await setAgentState(agentId, 'PAUSED', 'agent.pause', { sim, activity: 'Pausado por operador' })
    await eventBus.publish({ event_type: 'agent.paused', source: 'eec.agents', subject: `agent:${agentId}`, payload: { agentId }, sim })
    return { agentId, state: 'PAUSED' }
  })

  registerCommandHandler('agent.resume', async ({ payload, sim }) => {
    const { agentId } = payload as { agentId: string }
    await setAgentState(agentId, 'IDLE', 'agent.resume', { sim, activity: 'Disponible' })
    await eventBus.publish({ event_type: 'agent.resumed', source: 'eec.agents', subject: `agent:${agentId}`, payload: { agentId }, sim })
    return { agentId, state: 'IDLE' }
  })

  registerCommandHandler('agent.suspend', async ({ payload, sim }) => {
    const p = payload as { agentId: string; reason?: string }
    await setAgentState(p.agentId, 'SUSPENDED', p.reason ?? 'agent.suspend', { sim, activity: 'Suspendido' })
    const agent = await db.agent.findUnique({ where: { id: p.agentId }, include: { runtimes: true } })
    for (const rt of agent?.runtimes ?? []) {
      if (canRuntimeTransition(rt.status, 'STOPPING')) {
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPING' } })
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPED', stoppedAt: new Date() } })
        await eventBus.publish({ event_type: 'runtime.state.changed', source: 'eec.runtimes', subject: `runtime:${rt.id}`, payload: { runtimeId: rt.id, agentId: p.agentId, status: 'STOPPED' }, sim })
      }
    }
    await eventBus.publish({ event_type: 'agent.suspended', source: 'eec.agents', subject: `agent:${p.agentId}`, payload: p, sim })
    return { agentId: p.agentId, state: 'SUSPENDED' }
  })

  registerCommandHandler('agent.wake', async ({ payload, sim }) => {
    const { agentId } = payload as { agentId: string }
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) throw new Error('AGENT_NOT_FOUND')
    if (agent.state === 'SUSPENDED' || agent.state === 'PAUSED' || agent.state === 'OFFLINE') {
      const { dispatchCommand } = await import('../pipeline')
      await dispatchCommand({ type: 'agent.start', payload: { agentId }, requesterType: 'SYSTEM', requesterId: 'eec:wake' })
    }
    await eventBus.publish({ event_type: 'agent.woken', source: 'eec.agents', subject: `agent:${agentId}`, payload: { agentId }, sim })
    return { agentId, state: 'IDLE' }
  })

  registerCommandHandler('agent.stop', async ({ payload, sim }) => {
    const p = payload as { agentId: string; reason?: string }
    const agent = await db.agent.findUnique({ where: { id: p.agentId }, include: { runtimes: true } })
    if (!agent) throw new Error('AGENT_NOT_FOUND')
    for (const rt of agent.runtimes) {
      if (canRuntimeTransition(rt.status, 'STOPPING')) {
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPING' } })
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPED', stoppedAt: new Date(), health: 'STOPPED' } })
        await eventBus.publish({ event_type: 'runtime.state.changed', source: 'eec.runtimes', subject: `runtime:${rt.id}`, payload: { runtimeId: rt.id, agentId: agent.id, status: 'STOPPED' }, sim })
      }
    }
    const sessions = await db.session.findMany({ where: { agentId: agent.id, status: { in: ['ACTIVE', 'PAUSED', 'RESUMED'] } } })
    for (const s of sessions) {
      await db.session.update({ where: { id: s.id }, data: { status: 'COMPLETED', endedAt: new Date() } })
    }
    if (agent.state !== 'OFFLINE') {
      await setAgentState(agent.id, 'OFFLINE', p.reason ?? 'agent.stop', { sim, activity: null })
    }
    await eventBus.publish({ event_type: 'agent.stopped', source: 'eec.agents', subject: `agent:${agent.id}`, payload: { agentId: agent.id, reason: p.reason }, sim })
    // identidad preservada: el Agent sigue intacto; solo runtime/session cambian
    return { agentId: agent.id, state: 'OFFLINE', identityPreserved: true }
  })

  registerCommandHandler('agent.assign_office', async ({ payload, sim }) => {
    const p = payload as { agentId: string; officeCode: string }
    const office = await db.location.findUnique({ where: { code: p.officeCode } })
    if (!office) throw new Error(`LOCATION_NOT_FOUND:${p.officeCode}`)
    await db.agent.update({ where: { id: p.agentId }, data: { officeId: office.id } })
    await eventBus.publish({ event_type: 'agent.office.assigned', source: 'eec.agents', subject: `agent:${p.agentId}`, payload: { agentId: p.agentId, officeId: office.id }, sim })
    return { agentId: p.agentId, officeId: office.id }
  })

  // ---------------- runtime.start/stop/restart/recover ----------------
  const runtimeOp = (op: 'start' | 'stop' | 'restart' | 'recover') =>
    async ({ payload, sim }: { payload: Record<string, unknown>; sim: boolean }): Promise<Record<string, unknown>> => {
      const { runtimeId } = payload as { runtimeId: string }
      const rt = await db.agentRuntime.findUnique({ where: { id: runtimeId }, include: { agent: true } })
      if (!rt) throw new Error('RUNTIME_NOT_FOUND')
      const adapter = providerRegistry.get<RuntimeInterface>('RUNTIME') // registrado en boot
      const agent = rt.agent

      if (op === 'start') {
        if (!canRuntimeTransition(rt.status, 'STARTING')) throw new TransitionError('RUNTIME', rt.id, rt.status, 'STARTING')
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STARTING', lastHeartbeatAt: new Date() } })
        await adapter.start(rt.id)
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'RUNNING', startedAt: rt.startedAt ?? new Date(), health: 'HEALTHY' } })
      }
      if (op === 'stop') {
        if (!canRuntimeTransition(rt.status, 'STOPPING')) throw new TransitionError('RUNTIME', rt.id, rt.status, 'STOPPING')
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPING' } })
        await adapter.stop(rt.id)
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'STOPPED', stoppedAt: new Date() } })
        if (agent.state !== 'OFFLINE') await setAgentState(agent.id, 'OFFLINE', 'runtime.stop', { sim })
      }
      if (op === 'restart') {
        await adapter.restart(rt.id)
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'RUNNING', restarts: { increment: 1 }, lastHeartbeatAt: new Date(), health: 'HEALTHY' } })
      }
      if (op === 'recover') {
        // CRASHED/ERROR → RECOVERING → READY → RUNNING; agente ERROR → RECOVERY → IDLE
        if (!canRuntimeTransition(rt.status, 'RECOVERING')) throw new TransitionError('RUNTIME', rt.id, rt.status, 'RECOVERING')
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'RECOVERING' } })
        await eventBus.publish({ event_type: 'runtime.recovering', source: 'eec.runtimes', subject: `runtime:${rt.id}`, payload: { runtimeId: rt.id }, sim })
        await adapter.recover(rt.id)
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'READY', restarts: { increment: 1 }, health: 'HEALTHY' } })
        await db.agentRuntime.update({ where: { id: rt.id }, data: { status: 'RUNNING', lastHeartbeatAt: new Date() } })
        await eventBus.publish({ event_type: 'runtime.recovered', source: 'eec.runtimes', subject: `runtime:${rt.id}`, payload: { runtimeId: rt.id, restarts: rt.restarts + 1 }, sim })
        if (agent.state === 'ERROR') {
          await setAgentState(agent.id, 'RECOVERY', 'runtime.recover', { sim, activity: 'Recuperando…' })
          await setAgentState(agent.id, 'IDLE', 'runtime.recover complete', { sim, activity: 'Recuperado y disponible' })
        }
      }
      const final = await db.agentRuntime.findUnique({ where: { id: rt.id } })
      return { runtimeId: rt.id, agentId: agent.id, status: final?.status }
    }
  registerCommandHandler('runtime.start', runtimeOp('start'))
  registerCommandHandler('runtime.stop', runtimeOp('stop'))
  registerCommandHandler('runtime.restart', runtimeOp('restart'))
  registerCommandHandler('runtime.recover', runtimeOp('recover'))
}
