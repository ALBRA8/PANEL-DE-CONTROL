import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, authConfigured, loginOperator, resolveRequester } from '@/lib/eec/security/auth'
import { checkRate, clientIp } from '@/lib/eec/security/rate-limit'

export const dynamic = 'force-dynamic'

/** Estado de autenticación (para la UI sin exponer secretos). */
export async function GET(req: NextRequest) {
  const identity = resolveRequester(req)
  return NextResponse.json({
    configured: authConfigured(),
    authenticated: Boolean(identity),
    via: identity?.via ?? null,
  })
}

/** Login del operador: credencial validada en servidor → cookie httpOnly firmada. */
export async function POST(req: NextRequest) {
  const rl = checkRate(`login:${clientIp(req)}`, 10, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } })
  }
  let body: { password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 })
  }
  const result = loginOperator(String(body.password ?? ''))
  if (!result.ok) {
    const status = result.reason === 'auth_not_configured' ? 503 : 401
    return NextResponse.json({ ok: false, error: result.reason }, { status })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.EEC_INSECURE_COOKIE !== '1',
    maxAge: 12 * 3600,
    path: '/',
  })
  return res
}

/** Logout: elimina la cookie de sesión. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })
  return res
}
