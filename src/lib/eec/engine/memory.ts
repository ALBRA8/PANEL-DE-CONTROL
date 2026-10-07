// ============================================================
// EEC — MEMORY (spec §18) & KNOWLEDGE (spec §19)
// Separación estricta memoria ↔ conocimiento.
// No se persiste todo el contexto automáticamente: escritura deliberada
// con provenance y clasificación obligatorias.
// ============================================================
import { db } from '../../../lib/db'
import { providerRegistry, MemoryInterface, KnowledgeInterface } from '../domain/contracts'
import { dataClassRank } from '../domain/types'

const DEFAULT_MEMORY: MemoryInterface = {
  providerKey: 'builtin',
  async write(entry) {
    if (!entry.provenance || Object.keys(entry.provenance).length === 0) {
      throw new Error('EEC_MEMORY_PROVENANCE_REQUIRED')
    }
    const rec = await db.memoryRecord.create({
      data: {
        agentId: entry.agentId ?? null,
        scope: entry.scope,
        kind: entry.kind ?? 'OBSERVATION',
        content: entry.content,
        importance: entry.importance ?? 5,
        provenanceJson: JSON.stringify(entry.provenance),
        classification: entry.classification ?? 'INTERNAL',
        permissionsJson: JSON.stringify({}),
        tagsJson: JSON.stringify(entry.tags ?? []),
        expiresAt: entry.ttlMinutes ? new Date(Date.now() + entry.ttlMinutes * 60_000) : null,
      },
    })
    return { id: rec.id }
  },
  async query(q) {
    const rows = await db.memoryRecord.findMany({
      where: {
        ...(q.agentId ? { OR: [{ agentId: q.agentId }, { agentId: null }] } : {}),
        ...(q.scopes ? { scope: { in: q.scopes } } : {}),
        ...(q.minImportance ? { importance: { gte: q.minImportance } } : {}),
        ...(q.text ? { content: { contains: q.text } } : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: q.limit ?? 10,
    })
    return rows.map(r => ({
      id: r.id, scope: r.scope, kind: r.kind, content: r.content,
      importance: r.importance, provenance: JSON.parse(r.provenanceJson || '{}'),
      classification: r.classification,
    }))
  },
}

const DEFAULT_KNOWLEDGE: KnowledgeInterface = {
  providerKey: 'builtin',
  async retrieve(q, clearance) {
    const rows = await db.knowledgeItem.findMany({ take: 500 })
    const terms = q.text.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const scored = rows
      .map(r => {
        const hay = `${r.title} ${r.content} ${r.tagsJson}`.toLowerCase()
        let score = 0
        for (const t of terms) if (hay.includes(t)) score += 1
        // boost por tags coincidentes
        for (const t of q.tags ?? []) if (hay.includes(t.toLowerCase())) score += 2
        return {
          id: r.id, title: r.title, sourceType: r.sourceType,
          excerpt: r.content.slice(0, 240),
          classification: r.classification,
          score,
        }
      })
      // ---- PERMISSION FILTER: nunca exponer clasificación > clearance ----
      .filter(r => r.score > 0 && dataClassRank(r.classification) <= dataClassRank(clearance))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit ?? 5)
    return scored
  },
}

export function memoryService(): MemoryInterface {
  try { return providerRegistry.get<MemoryInterface>('MEMORY') } catch { return DEFAULT_MEMORY }
}
export function knowledgeService(): KnowledgeInterface {
  try { return providerRegistry.get<KnowledgeInterface>('KNOWLEDGE') } catch { return DEFAULT_KNOWLEDGE }
}

/** Clearance de un agente derivado de sus permisos (mayor clasificación permitida). */
export async function agentClearance(agentId: string | null | undefined): Promise<string> {
  if (!agentId) return 'INTERNAL'
  const perms = await db.permission.findMany({ where: { agentId, effect: 'ALLOW' } })
  let best = 0
  for (const p of perms) {
    const m = /data\.(\w+)/.exec(p.capability)
    if (m) best = Math.max(best, dataClassRank(m[1]))
  }
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { registrationJson: true } })
  const declared = agent ? safeClass(agent.registrationJson) : 'INTERNAL'
  return dataClassRank(declared) > best ? declared : (['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'][best] ?? 'INTERNAL')
}

function safeClass(reg: string): string {
  try { return JSON.parse(reg).clearance ?? 'INTERNAL' } catch { return 'INTERNAL' }
}
