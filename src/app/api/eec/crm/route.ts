import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const [clients, interactions] = await Promise.all([
    db.client.findMany({
      include: {
        opportunities: { orderBy: { updatedAt: 'desc' } },
        contacts: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    db.interaction.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 60,
      include: { client: { select: { name: true } } },
    }),
  ])
  return NextResponse.json({ clients, interactions })
}
