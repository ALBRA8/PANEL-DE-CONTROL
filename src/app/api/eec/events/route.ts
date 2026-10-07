import { NextRequest, NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { eventBus } from '@/lib/eec/events/bus'

export const dynamic = 'force-dynamic'

/** Stream de eventos por cursor (fallback de polling del bridge realtime). */
export async function GET(req: NextRequest) {
  await ensureBoot()
  const since = parseInt(req.nextUrl.searchParams.get('since') ?? '0', 10) || 0
  const limit = Math.min(500, parseInt(req.nextUrl.searchParams.get('limit') ?? '200', 10) || 200)
  const events = await eventBus.since(since, limit)
  const lastSeq = events.length > 0 ? Number((events[events.length - 1] as { seq: number }).seq) : since
  return NextResponse.json({ events, lastSeq, cursor: lastSeq })
}
