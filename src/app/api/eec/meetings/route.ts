import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const meetings = await db.meeting.findMany({
    include: {
      participants: { include: { agent: { select: { id: true, code: true, name: true, state: true, activity: true, locationId: true } } } },
      location: true,
    },
    orderBy: { scheduledStartAt: 'desc' },
    take: 50,
  })
  return NextResponse.json({ meetings })
}
