// ============================================================
// EEC — ADMINISTRACIÓN POR ORGANIZACIÓN (P2-4 · matriz #21/#22)
// Lectura consolidada: organizaciones + flags resueltos (default vs
// override) + usage/coste atribuido. Las MUTACIONES no entran aquí:
// van por /api/eec/commands (org.create, org.flag.set, org.flag.unset)
// para pasar por auth, rate-limit, política y cadena hash de auditoría.
// ============================================================
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureBoot } from '@/lib/eec/boot'
import { ORG_FLAG_DEFS, resolveOrgFlags, getOrgUsage } from '@/lib/eec/engine/org-flags'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const [orgs, usage] = await Promise.all([
    db.organization.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, code: true, name: true, mission: true, createdAt: true } }),
    getOrgUsage(),
  ])
  const withFlags = await Promise.all(
    orgs.map(async o => ({ ...o, flags: await resolveOrgFlags(o.id) })),
  )
  return NextResponse.json({
    ok: true,
    catalog: ORG_FLAG_DEFS,
    organizations: withFlags,
    usage: usage.rows,
    usageTotals: usage.totals,
  })
}
