import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const approvals = await db.approval.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return NextResponse.json({ approvals })
}
