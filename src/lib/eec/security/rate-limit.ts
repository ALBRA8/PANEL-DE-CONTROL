// ============================================================
// EEC — RATE LIMIT (§6): ventana deslizante en memoria.
// Limitación documentada: por instancia (suficiente para el despliegue
// single-node actual; para multi-nodo sustituir por almacén compartido).
// ============================================================

const globalForRL = globalThis as unknown as { __eecRateBuckets?: Map<string, number[]> }
const buckets = globalForRL.__eecRateBuckets ?? new Map<string, number[]>()
globalForRL.__eecRateBuckets = buckets

export interface RateVerdict {
  allowed: boolean
  remaining: number
  retryAfterSec: number
}

export function checkRate(key: string, limit: number, windowMs: number, now = Date.now()): RateVerdict {
  const arr = (buckets.get(key) ?? []).filter(t => now - t < windowMs)
  if (arr.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000))
    buckets.set(key, arr)
    return { allowed: false, remaining: 0, retryAfterSec }
  }
  arr.push(now)
  buckets.set(key, arr)
  if (buckets.size > 10_000) {
    // higiene: descartar claves inactivas
    for (const [k, v] of buckets) {
      if (v.every(t => now - t > windowMs)) buckets.delete(k)
    }
  }
  return { allowed: true, remaining: limit - arr.length, retryAfterSec: 0 }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'local'
}
