import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'
import { reconstructEntity } from '@/lib/eec/engine/audit'

export const dynamic = 'force-dynamic'

/** Auditoría consultable + reconstrucción completa por entidad (§28). */
export async function GET(req: NextRequest) {
  await ensureBoot()
  const entityType = req.nextUrl.searchParams.get('entityType')
  const entityId = req.nextUrl.searchParams.get('entityId')
  const action = req.nextUrl.searchParams.get('action')

  if (entityType && entityId) {
    const reconstruction = await reconstructEntity(entityType, entityId)
    return NextResponse.json(reconstruction)
  }

  const records = await db.auditRecord.findMany({
    where: {
      ...(action ? { action: { contains: action } } : {}),
      ...(entityType ? { entityType } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return NextResponse.json({ records })
}
