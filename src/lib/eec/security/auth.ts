// ============================================================
// EEC — SEGURIDAD: IDENTIDAD SERVER-SIDE (EEC V2, §6 del mandato)
//
// REGLA FUNDAMENTAL: el EEC jamás confía en requesterType/requesterId
// declarados por el cliente. La identidad del solicitante se DERIVA
// en el servidor de una credencial validada:
//
//   Authorization: Bearer $EEC_API_TOKEN   → HUMAN (operador por token)
//   Cookie eec_session (HMAC firmada)      → HUMAN (operador por sesión)
//   Llamadas internas (workers/handlers)   → SYSTEM (nunca vía HTTP)
//
// Sin credencial → 401. Sin configuración de credenciales → 503
// (frontera cerrada por defecto; NUNCA se simula autenticación).
// ============================================================
import { createHmac, timingSafeEqual } from 'crypto'

export const SESSION_COOKIE = 'eec_session'
const SESSION_TTL_MS = 12 * 3600 * 1000

export interface RequesterIdentity {
  requesterType: 'HUMAN'
  requesterId: string
  via: 'bearer' | 'session'
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function authConfigured(): boolean {
  return Boolean(process.env.EEC_OPERATOR_PASSWORD || process.env.EEC_API_TOKEN)
}

/** Firma de sesión: base64(payload).base64(hmac) con HMAC-SHA256. */
function sign(payload: string): string {
  const secret = process.env.EEC_SESSION_SECRET || 'eec-insecure-dev-secret'
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createSessionToken(operatorId = 'operator'): string {
  const payload = Buffer.from(JSON.stringify({ op: operatorId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifySessionToken(token: string | undefined | null): { op: string } | null {
  if (!token || !token.includes('.')) return null
  const [payload, mac] = token.split('.')
  try {
    if (!safeEqual(sign(payload), mac)) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { op: string; exp: number }
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null
    return { op: data.op }
  } catch {
    return null
  }
}

function constantTimePasswordOk(candidate: string): boolean {
  const expected = process.env.EEC_OPERATOR_PASSWORD
  if (!expected) return false
  return safeEqual(candidate, expected)
}

/** Verifica credenciales de login del operador. Devuelve el token de sesión o null. */
export function loginOperator(password: string): { ok: true; token: string } | { ok: false; reason: string } {
  if (!process.env.EEC_OPERATOR_PASSWORD) return { ok: false, reason: 'auth_not_configured' }
  if (!password || !constantTimePasswordOk(password)) return { ok: false, reason: 'invalid_credentials' }
  return { ok: true, token: createSessionToken('operator') }
}

/**
 * Resuelve la identidad del solicitante desde la petición HTTP.
 * Devuelve null si no hay credencial válida. NUNCA lee identidad del body.
 */
export function resolveRequester(req: Request): RequesterIdentity | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    const expected = process.env.EEC_API_TOKEN
    if (expected && token && safeEqual(token, expected)) {
      return { requesterType: 'HUMAN', requesterId: 'operator:token', via: 'bearer' }
    }
    return null // bearer presente pero inválido → no caer a cookie
  }
  const cookieHeader = req.headers.get('cookie') ?? ''
  const match = cookieHeader.split(/;\s*/).find(c => c.startsWith(`${SESSION_COOKIE}=`))
  const session = verifySessionToken(match?.split('=').slice(1).join('='))
  if (session) {
    return { requesterType: 'HUMAN', requesterId: `operator:${session.op}`, via: 'session' }
  }
  return null
}

/** Redacción de secretos para salidas de agentes y logs (§10). */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/g,
]

export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  let out = text
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]')
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]')
  }
  return out
}

/** Secretos que deben redactarse: valores de las variables listadas en el manifiesto (secretRef). */
export function collectSecretValues(envNames: string[]): string[] {
  return envNames
    .map(n => process.env[n])
    .filter((v): v is string => Boolean(v && v.length >= 6))
}
