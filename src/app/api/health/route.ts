import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.$queryRawUnsafe('SELECT 1')
    return NextResponse.json({
      ok: true,
      service: 'panel-de-control',
      status: 'healthy',
      database: 'reachable',
      timestamp: new Date().toISOString(),
    })
  } catch {
    return NextResponse.json(
      {
        ok: false,
        service: 'panel-de-control',
        status: 'unhealthy',
        database: 'unavailable',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    )
  }
}
