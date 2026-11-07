import { NextResponse } from 'next/server'
import { ensureBoot } from '@/lib/eec/boot'
import { buildObservatorySnapshot } from '@/lib/eec/engine/observatory'

export const dynamic = 'force-dynamic'

/** Sala de situación: snapshot consolidado de todos los órganos de control (solo lectura). */
export async function GET() {
  await ensureBoot()
  const snapshot = await buildObservatorySnapshot()
  return NextResponse.json(snapshot)
}
