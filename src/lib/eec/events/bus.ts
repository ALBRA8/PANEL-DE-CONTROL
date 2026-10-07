// ============================================================
// EEC — EVENT BUS (spec §14)
// Arquitectura de eventos centralizada. NO pertenece a ningún agente.
// Soporta: persistencia, idempotencia, retry, dead-letter,
// correlación/causación y replay.
//
// Envelope: event_id, event_type, version, timestamp, source, subject,
// correlation_id, causation_id, payload, metadata (+trace/span, sim).
// Namespaces: agent.* task.* workflow.* run.* runtime.* meeting.*
//             user.* client.* memory.* tool.* approval.* system.*
// ============================================================
import { randomUUID } from 'crypto'
import { db } from '../../../lib/db'
import type { EventEnvelope } from '../domain/types'
import { currentTrace, newTrace, recordMetric, sanitize, withTrace } from '../engine/observability'

type Subscriber = (event: EventEnvelope) => Promise<void> | void

interface SubscriberEntry {
  id: string
  pattern: string
  handler: Subscriber
}

const MAX_RETRIES = 3
const MAX_DISPATCH_DEPTH = 24

class EventBusImpl {
  private subscribers = new Map<string, SubscriberEntry>()
  private depth = 0

  /** Suscripción por patrón: 'task.*', 'approval.requested', '*' */
  subscribe(pattern: string, handler: Subscriber): () => void {
    const id = randomUUID()
    this.subscribers.set(id, { id, pattern, handler })
    return () => this.subscribers.delete(id)
  }

  private matches(pattern: string, type: string): boolean {
    if (pattern === '*' || pattern === type) return true
    if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
    return false
  }

  /**
   * Publica un evento: idempotente por event_id; completa correlación desde
   * el contexto de traza; persiste; despacha a suscriptores (sync para
   * orden determinista); en fallo retry → dead-letter.
   */
  async publish(spec: {
    event_type: string
    source: string
    subject: string
    payload?: Record<string, unknown>
    metadata?: Record<string, unknown>
    event_id?: string
    correlation_id?: string | null
    causation_id?: string | null
    trace_id?: string | null
    sim?: boolean
  }): Promise<EventEnvelope | null> {
    const t = currentTrace()
    const event: EventEnvelope = {
      event_id: spec.event_id ?? randomUUID(),
      event_type: spec.event_type,
      version: '1.0',
      timestamp: new Date().toISOString(),
      source: spec.source,
      subject: spec.subject,
      correlation_id: spec.correlation_id ?? t?.correlationId ?? null,
      causation_id: spec.causation_id ?? t?.correlationId ?? null,
      trace_id: spec.trace_id ?? t?.traceId ?? null,
      span_id: t?.spanId ?? null,
      payload: sanitize(spec.payload ?? {}) as Record<string, unknown>,
      metadata: { ...(spec.metadata ?? {}), sim: spec.sim ?? t?.sim ?? false },
      sim: spec.sim ?? t?.sim ?? false,
    }

    // ---- IDEMPOTENCIA: event_id duplicado se ignora sin efectos ----
    const existing = await db.eventRecord.findUnique({ where: { id: event.event_id } })
    if (existing) {
      return { ...event, seq: existing.seq }
    }

    const rec = await db.eventRecord.create({
      data: {
        id: event.event_id,
        type: event.event_type,
        version: event.version,
        source: event.source,
        subject: event.subject,
        correlationId: event.correlation_id ?? undefined,
        causationId: event.causation_id ?? undefined,
        traceId: event.trace_id ?? undefined,
        spanId: event.span_id ?? undefined,
        payloadJson: JSON.stringify(event.payload),
        metadataJson: JSON.stringify(event.metadata),
        status: 'PENDING',
        sim: event.sim ?? false,
      },
    })
    event.seq = rec.seq

    await recordMetric('eec.events.published', 1, { type: event.event_type })

    // ---- DISPATCH a suscriptores (profundidad acotada anti-recursión) ----
    if (this.depth < MAX_DISPATCH_DEPTH) {
      this.depth++
      try {
        for (const s of this.subscribers.values()) {
          if (!this.matches(s.pattern, event.event_type)) continue
          try {
            await s.handler(event)
          } catch (err) {
            await this.handleSubscriberFailure(rec.id, event, s.id, err)
          }
        }
      } finally {
        this.depth--
      }
    }

    await db.eventRecord.update({
      where: { seq: rec.seq },
      data: { status: 'PROCESSED', processedAt: new Date() },
    }).catch(() => undefined)

    return event
  }

  private async handleSubscriberFailure(eventRecId: string, event: EventEnvelope, subscriberId: string, err: unknown): Promise<void> {
    // Reintento del suscriptor fallido: re-ejecuta su handler hasta MAX_RETRIES.
    const s = this.subscribers.get(subscriberId)
    let attempt = 0
    if (s) {
      while (attempt < MAX_RETRIES) {
        attempt++
        try {
          await s.handler(event)
          return
        } catch { /* reintento */ }
      }
    }
    // dead-letter
    await db.eventRecord.update({
      where: { id: eventRecId },
      data: { status: 'DEAD_LETTER', retryCount: attempt },
    }).catch(() => undefined)
    await recordMetric('eec.events.dead_letter', 1, { type: event.event_type })
    console.error(`[EEC-BUS] DEAD_LETTER ${event.event_type} (${subscriberId}):`, err instanceof Error ? err.message : err)
  }

  /** Reprocesa eventos en dead-letter (comando system.deadletter.retry). */
  async retryDeadLetter(limit = 50): Promise<number> {
    const dead = await db.eventRecord.findMany({
      where: { status: 'DEAD_LETTER' },
      orderBy: { seq: 'desc' },
      take: limit,
    })
    let n = 0
    for (const d of dead) {
      const envelope: EventEnvelope = {
        event_id: d.id, event_type: d.type, version: d.version,
        timestamp: d.createdAt.toISOString(), source: d.source, subject: d.subject,
        correlation_id: d.correlationId, causation_id: d.causationId, trace_id: d.traceId,
        payload: JSON.parse(d.payloadJson || '{}'),
        metadata: JSON.parse(d.metadataJson || '{}'),
        seq: d.seq, sim: d.sim,
      }
      let ok = true
      for (const s of this.subscribers.values()) {
        if (!this.matches(s.pattern, envelope.event_type)) continue
        try { await s.handler(envelope) } catch { ok = false }
      }
      await db.eventRecord.update({
        where: { seq: d.seq },
        data: { status: ok ? 'PROCESSED' : 'FAILED', retryCount: { increment: 1 } },
      })
      if (ok) n++
    }
    return n
  }

  /** Replay determinista de eventos históricos para reconstrucción/tests. */
  async replay(filter: { from?: number; to?: number; types?: string[] }, handler: Subscriber): Promise<number> {
    const rows = await db.eventRecord.findMany({
      where: {
        ...(filter.from || filter.to
          ? { seq: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
        ...(filter.types ? { type: { in: filter.types } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: 1000,
    })
    for (const d of rows) {
      await handler({
        event_id: d.id, event_type: d.type, version: d.version,
        timestamp: d.createdAt.toISOString(), source: d.source, subject: d.subject,
        correlation_id: d.correlationId, causation_id: d.causationId, trace_id: d.traceId,
        payload: JSON.parse(d.payloadJson || '{}'),
        metadata: JSON.parse(d.metadataJson || '{}'),
        seq: d.seq, sim: d.sim,
      })
    }
    return rows.length
  }

  async since(seq: number, limit = 200): Promise<Array<Record<string, unknown>>> {
    const rows = await db.eventRecord.findMany({
      where: { seq: { gt: seq } },
      orderBy: { seq: 'asc' },
      take: limit,
    })
    return rows.map(d => ({
      seq: d.seq, id: d.id, event_type: d.type, source: d.source, subject: d.subject,
      timestamp: d.createdAt.toISOString(),
      correlation_id: d.correlationId, causation_id: d.causationId, trace_id: d.traceId,
      payload: JSON.parse(d.payloadJson || '{}'),
      sim: d.sim,
    }))
  }
}

const globalForBus = globalThis as unknown as { __eecEventBus?: EventBusImpl }
export const eventBus: EventBusImpl = globalForBus.__eecEventBus ?? new EventBusImpl()
globalForBus.__eecEventBus = eventBus

/** Helper: traza nueva + publish dentro de ella. */
export async function publishInNewTrace(spec: Parameters<EventBusImpl['publish']>[0], seed?: Partial<ReturnType<typeof newTrace>>) {
  const ctx = newTrace(seed)
  return withTrace(ctx, () => eventBus.publish(spec))
}
