import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const [events, schedules] = await Promise.all([
    db.calendarEvent.findMany({ orderBy: { startAt: 'asc' }, take: 200 }),
    db.schedule.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  ])
  return NextResponse.json({ events, schedules })
}
