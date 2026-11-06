// ============================================================
// EEC — DOCTOR DEL SISTEMA (P2-2 · matriz #26)
// GET /api/eec/doctor → verificaciones reales del estado vivo.
// Solo lectura: nunca repara, declara.
// ============================================================
import { NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { runDoctor } from '@/lib/eec/engine/doctor'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureBoot()
  const report = await runDoctor()
  return NextResponse.json({ ok: true, ...report })
}
