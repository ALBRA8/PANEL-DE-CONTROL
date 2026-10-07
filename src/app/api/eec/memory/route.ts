import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'
import { knowledgeService } from '@/lib/eec/engine/memory'

export const dynamic = 'force-dynamic'

/** Memoria por scopes + conocimiento con filtro de permisos (§18, §19). */
export async function GET(req: NextRequest) {
  await ensureBoot()
  const q = req.nextUrl.searchParams.get('q')
  const scope = req.nextUrl.searchParams.get('scope')
  const agentId = req.nextUrl.searchParams.get('agentId')

  const memory = await db.memoryRecord.findMany({
    where: {
      ...(scope ? { scope } : {}),
      ...(agentId ? { OR: [{ agentId }, { agentId: null }] } : {}),
      ...(q ? { content: { contains: q } } : {}),
    },
    orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  })
  const knowledge = q
    ? await knowledgeService().retrieve({ text: q, limit: 20 }, 'RESTRICTED')
    : (await db.knowledgeItem.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 })).map(k => ({
        id: k.id, title: k.title, sourceType: k.sourceType,
        excerpt: k.content.slice(0, 240), classification: k.classification, score: 0,
      }))
  return NextResponse.json({ memory, knowledge })
}
