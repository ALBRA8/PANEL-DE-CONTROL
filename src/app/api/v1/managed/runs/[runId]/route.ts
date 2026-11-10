// ============================================================
// ALBRA BRIDGE — GET /api/v1/managed/runs/[runId]
// Proxy de lectura del progreso REAL de un run del INSTALADOR
// (pasos + unidades por módulo). Sin inventar estados.
// ============================================================
import { NextResponse } from "next/server"
import { resolveRequester } from "@/lib/eec/security/auth"
import { fetchAlbraGet } from "@/lib/albra-bridge/ops-client"

export const dynamic = "force-dynamic"

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const requester = resolveRequester(req)
  if (!requester) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Autenticación de operador requerida." } }, { status: 401 })
  }
  const { runId } = await ctx.params
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runId)) {
    return NextResponse.json({ error: { code: "INVALID_RUN_ID", message: "runId inválido." } }, { status: 400 })
  }
  try {
    const run = await fetchAlbraGet<unknown>(`/api/runs/${runId}`)
    return NextResponse.json(run)
  } catch (e) {
    const err = e as { code?: string; message?: string; status?: number }
    return NextResponse.json({ error: { code: err.code ?? "BRIDGE_ERROR", message: err.message ?? "Error consultando el run." } }, { status: err.status ?? 502 })
  }
}
