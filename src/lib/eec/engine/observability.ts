// ============================================================
// EEC — OBSERVABILITY (spec §27): TRACE / METRIC / LOG
// Correlación por trace_id / correlation_id / causation_id / span_id.
// OpenTelemetry sería un adapter de reemplazo; esto es el núcleo neutro.
// ============================================================
import { db } from '../../../lib/db'
import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'

export interface EecTraceContext {
  traceId: string
  correlationId: string
  causationId?: string | null
  spanId?: string | null
  sim?: boolean
}

const globalForCtx = globalThis as unknown as { __eecAls?: AsyncLocalStorage<EecTraceContext> }
export const eecAls: AsyncLocalStorage<EecTraceContext> =
  globalForCtx.__eecAls ?? new AsyncLocalStorage<EecTraceContext>()
globalForCtx.__eecAls = eecAls

export function currentTrace(): EecTraceContext | undefined {
  return eecAls.getStore()
}

export function newTrace(seed?: Partial<EecTraceContext>): EecTraceContext {
  return {
    traceId: seed?.traceId ?? randomUUID(),
    correlationId: seed?.correlationId ?? randomUUID(),
    causationId: seed?.causationId ?? null,
    spanId: seed?.spanId ?? randomUUID(),
    sim: seed?.sim,
  }
}

/** Ejecuta fn con un contexto de traza ligado (propaga a publishes/subscribers). */
export async function withTrace<T>(ctx: EecTraceContext, fn: () => Promise<T>): Promise<T> {
  return eecAls.run(ctx, fn)
}

export async function startSpan(name: string, service: string, attrs?: Record<string, unknown>, parent?: EecTraceContext): Promise<string> {
  const base = parent ?? currentTrace()
  const spanId = randomUUID()
  try {
    await db.span.create({
      data: {
        spanId,
        traceId: base?.traceId ?? randomUUID(),
        parentSpanId: base?.spanId ?? null,
        name, service,
        attributesJson: JSON.stringify(attrs ?? {}),
      },
    })
  } catch { /* observability nunca rompe el core */ }
  return spanId
}

export async function endSpan(spanId: string, status: 'OK' | 'ERROR' = 'OK'): Promise<void> {
  try {
    await db.span.updateMany({ where: { spanId }, data: { endedAt: new Date(), status } })
  } catch { /* noop */ }
}

export async function recordMetric(name: string, value: number, labels?: Record<string, unknown>, unit?: string): Promise<void> {
  try {
    await db.metric.create({
      data: { name, value, unit: unit ?? null, labelsJson: JSON.stringify(labels ?? {}) },
    })
  } catch { /* noop */ }
}

export async function log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, context?: Record<string, unknown>, service = 'eec-core'): Promise<void> {
  const t = currentTrace()
  try {
    await db.logRecord.create({
      data: {
        level, message, service,
        traceId: t?.traceId ?? null,
        spanId: t?.spanId ?? null,
        contextJson: JSON.stringify(context ?? {}),
      },
    })
  } catch { /* noop */ }
}

/** Sanitiza payloads para que NUNCA aparezcan secretos en logs/eventos/UI (spec §25). */
const SECRET_KEYS = /secret|token|password|apikey|api_key|authorization|credential/i
export function sanitize(data: unknown, depth = 0): unknown {
  if (depth > 6 || data === null || data === undefined) return data
  if (Array.isArray(data)) return data.slice(0, 100).map(x => sanitize(x, depth + 1))
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : sanitize(v, depth + 1)
    }
    return out
  }
  if (typeof data === 'string' && data.length > 4000) return data.slice(0, 4000) + '…[truncated]'
  return data
}
