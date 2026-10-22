import { NextRequest, NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { dispatchCommand } from '@/lib/eec/commands'
import { resolveRequester, authConfigured } from '@/lib/eec/security/auth'
import { checkRate, clientIp } from '@/lib/eec/security/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 1_000_000 // 1 MB

/**
 * ÚNICO punto de entrada de comandos del EEC (spec §13).
 * Pipeline: autenticación → validación → autorización → política → dispatch.
 *
 * SEGURIDAD (EEC V2 §6): la identidad del solicitante SE DERIVA EN EL
 * SERVIDOR (bearer token o sesión firmada). Los campos requesterType /
 * requesterId del body SE IGNORAN — un cliente no puede hacerse pasar
 * por HUMAN, AGENT o SYSTEM.
 */
export async function POST(req: NextRequest) {
  // ---- frontera de autenticación (cerrada por defecto) ----
  if (!authConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'auth_not_configured: defina EEC_OPERATOR_PASSWORD y/o EEC_API_TOKEN' },
      { status: 503 },
    )
  }
  const identity = resolveRequester(req)
  if (!identity) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // ---- límite de frecuencia ----
  const rl = checkRate(`cmd:${clientIp(req)}`, 60, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    )
  }

  // ---- límite de tamaño ----
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 })
  }

  await ensureBoot()
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 })
    }
    const body = JSON.parse(raw) as { type?: unknown; payload?: unknown; idempotencyKey?: unknown }
    if (typeof body.type !== 'string' || body.type.length === 0 || body.type.length > 80) {
      return NextResponse.json({ ok: false, error: 'invalid_command_type' }, { status: 400 })
    }
    if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))) {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 })
    }
    const result = await dispatchCommand({
      type: body.type,
      payload: (body.payload ?? {}) as Record<string, unknown>,
      // identidad DERIVADA del servidor, nunca del cliente:
      requesterType: identity.requesterType,
      requesterId: identity.requesterId,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey.slice(0, 120) : undefined,
    })
    // observabilidad: el cliente ve QUÉ identidad efectiva se aplicó (derivada en servidor)
    return NextResponse.json(
      { ...result, requester: { type: identity.requesterType, id: identity.requesterId, via: identity.via } },
      { status: result.ok || result.status === 'POLICY_CHECKED' ? 200 : 422 },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'bad_request' },
      { status: 400 },
    )
  }
}
