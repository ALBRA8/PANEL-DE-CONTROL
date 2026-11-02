import { NextRequest, NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { verifyAuditChain } from '@/lib/eec/engine/audit-chain'

export const dynamic = 'force-dynamic'

/**
 * P0-1 (doc 07 §3.1): verificación de la cadena hash de auditoría.
 * GET /api/eec/audit/chain?from=<seq>&to=<seq>
 * → { ok, verified, checked, brokenAt[], unsealedLegacy }
 * Nunca repara: solo observa y declara (declarado vs observado).
 */
export async function GET(req: NextRequest) {
  await ensureBoot()
  const from = Number(req.nextUrl.searchParams.get('from') ?? '1')
  const toRaw = req.nextUrl.searchParams.get('to')
  const to = toRaw ? Number(toRaw) : undefined
  const fromSeq = Number.isFinite(from) && from >= 1 ? Math.floor(from) : 1
  const toSeq = to !== undefined && Number.isFinite(to) && to >= fromSeq ? Math.floor(to) : undefined
  const result = await verifyAuditChain(fromSeq, toSeq)
  return NextResponse.json(result)
}
