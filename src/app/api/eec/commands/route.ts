import { NextRequest, NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { dispatchCommand } from '@/lib/eec/commands'

export const dynamic = 'force-dynamic'

/**
 * ÚNICO punto de entrada de comandos del EEC (spec §13).
 * Pipeline: validación → autorización → política → dispatch.
 */
export async function POST(req: NextRequest) {
  await ensureBoot()
  try {
    const body = await req.json()
    const result = await dispatchCommand({
      type: String(body.type ?? ''),
      payload: body.payload ?? {},
      requesterType: (body.requesterType ?? 'HUMAN') as 'HUMAN' | 'AGENT' | 'SYSTEM',
      requesterId: body.requesterId ?? 'operator',
      idempotencyKey: body.idempotencyKey,
    })
    return NextResponse.json(result, { status: result.ok || result.status === 'POLICY_CHECKED' ? 200 : 422 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'bad_request' },
      { status: 400 },
    )
  }
}
