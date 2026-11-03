// ============================================================
// EEC V2 — P1-2: MOTOR SLA — plazos y escalamiento (doc 07 #17)
// bun test tests/eec-v2/p1-sla.test.ts
// La administración vive de plazos:
//  - tarea a 30 min → task.deadline_near (CRITICAL), UNA sola vez (dedup)
//  - tarea vencida → task.overdue
//  - tarea sana (3 días) → silencio (sin ruido administrativo)
//  - regla on(task.deadline_near) → crea tarea de escalamiento auditable
//  - aprobación por expirar → approval.deadline_near
// ============================================================
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, initDbPragmas } from '../../src/lib/db'
import { bootEEC } from '../../src/lib/eec/boot'
import { setSimulationMode } from '../../src/lib/eec/commands'
import { slaMonitorTick } from '../../src/lib/eec/engine/workers'

const SFX = Date.now().toString(36)
const taskIds: string[] = []
let ruleId = ''

beforeAll(async () => {
  await initDbPragmas()
  await bootEEC()
  setSimulationMode(true)
})

afterAll(async () => {
  await db.task.deleteMany({ where: { id: { in: taskIds } } }).catch(() => undefined)
  await db.task.deleteMany({ where: { tagsJson: { contains: 'sla:escalamiento' } } }).catch(() => undefined)
  if (ruleId) await db.schedule.delete({ where: { id: ruleId } }).catch(() => undefined)
  await db.$disconnect()
})

async function makeTask(title: string, dueAt: Date | null, priority = 'MEDIUM'): Promise<string> {
  const t = await db.task.create({
    data: {
      code: `SLA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      title, dueAt, priority,
    },
  })
  taskIds.push(t.id)
  return t.id
}

function eventCount(type: string, subject: string, level?: string): Promise<number> {
  return db.eventRecord.count({
    where: { type, subject, ...(level ? { payloadJson: { contains: `"level":"${level}"` } } : {}) },
  })
}

describe('P1-2 motor SLA', () => {
  test('tarea a 30 min → deadline_near CRITICAL emitido UNA sola vez (dedup persistente)', async () => {
    const id = await makeTask(`Cargar expediente ${SFX}`, new Date(Date.now() + 30 * 60_000))
    await slaMonitorTick()
    expect(await eventCount('task.deadline_near', `task:${id}`, 'CRITICAL')).toBe(1)
    await slaMonitorTick() // segundo tick: sin duplicado
    await slaMonitorTick()
    expect(await eventCount('task.deadline_near', `task:${id}`, 'CRITICAL')).toBe(1)
    expect(await eventCount('task.overdue', `task:${id}`)).toBe(0)
  })

  test('tarea vencida → task.overdue con minutesLeft negativo', async () => {
    const id = await makeTask(`Declaración vencida ${SFX}`, new Date(Date.now() - 5 * 60_000))
    await slaMonitorTick()
    expect(await eventCount('task.overdue', `task:${id}`)).toBe(1)
    const ev = await db.eventRecord.findFirstOrThrow({ where: { type: 'task.overdue', subject: `task:${id}` } })
    const payload = JSON.parse(ev.payloadJson) as { minutesLeft: number; level: string }
    expect(payload.minutesLeft).toBeLessThan(0)
    expect(payload.level).toBe('OVERDUE')
  })

  test('tarea con plazo sano (3 días) → sin eventos de SLA', async () => {
    const id = await makeTask(`Trámite sin urgencia ${SFX}`, new Date(Date.now() + 3 * 24 * 3600_000))
    await slaMonitorTick()
    expect(await eventCount('task.deadline_near', `task:${id}`)).toBe(0)
    expect(await eventCount('task.overdue', `task:${id}`)).toBe(0)
  })

  test('regla on(task.deadline_near) crea tarea de ESCALAMIENTO auditable', async () => {
    const rule = await db.schedule.create({
      data: {
        name: `Escalar plazos críticos ${SFX}`,
        kind: 'EVENT_TRIGGERED',
        expression: 'task.deadline_near',
        commandType: 'task.create',
        commandPayloadJson: JSON.stringify({
          title: 'ESCALADO: {{event.payload.title}}',
          priority: 'CRITICAL',
          tags: ['sla:escalamiento'],
        }),
        enabled: true,
      },
    })
    ruleId = rule.id
    const nBefore = await db.task.count({ where: { tagsJson: { contains: 'sla:escalamiento' } } })
    const id = await makeTask(`Audiencia urgente ${SFX}`, new Date(Date.now() + 20 * 60_000))
    await slaMonitorTick() // emite deadline_near → el puente dispara la regla → task.create
    const esc = await db.task.findFirst({
      where: { tagsJson: { contains: 'sla:escalamiento' }, title: { contains: `ESCALADO: Audiencia urgente ${SFX}` } },
      orderBy: { createdAt: 'desc' },
    })
    expect(esc).not.toBeNull()
    expect(esc!.title).toBe(`ESCALADO: Audiencia urgente ${SFX}`) // plantilla resuelta con el envelope
    expect(esc!.priority).toBe('CRITICAL')
    expect((await db.task.count({ where: { tagsJson: { contains: 'sla:escalamiento' } } }))).toBe(nBefore + 1)
    // el disparo de la regla queda auditado en el bus con causación al evento origen
    const fired = await db.eventRecord.findFirst({
      where: { type: 'system.schedule.fired', payloadJson: { contains: rule.id } },
      orderBy: { seq: 'desc' },
    })
    expect(fired).not.toBeNull()
    const firedPayload = JSON.parse(fired!.payloadJson) as { trigger: string; scheduleId: string }
    expect(firedPayload.trigger).toBe('task.deadline_near')
    expect(firedPayload.scheduleId).toBe(rule.id)
    // la tarea escalaron fue creada por el motor interno (SYSTEM), con idempotencia por event_id
    const cmd = await db.commandRecord.findFirst({ where: { requesterId: 'eec:scheduler-bridge', payloadJson: { contains: esc!.title } }, orderBy: { createdAt: 'desc' } })
    expect(cmd).not.toBeNull()
    expect(cmd!.idempotencyKey).toContain(`sched-ev:${rule.id}:`)
    void id
  })

  test('aprobación pendiente a 60 min de expirar → approval.deadline_near', async () => {
    const a = await db.approval.create({
      data: {
        requestType: 'COMMAND_APPROVAL', subjectType: 'COMMAND', subjectId: 'sin-comando',
        title: `Aprobación de prueba ${SFX}`, risk: 'HIGH',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    })
    await slaMonitorTick()
    expect(await eventCount('approval.deadline_near', `approval:${a.id}`)).toBe(1)
    await db.approval.delete({ where: { id: a.id } }).catch(() => undefined)
  })
})
