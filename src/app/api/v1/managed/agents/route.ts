// ============================================================
// ALBRA BRIDGE — GET /api/v1/managed/agents
// Catálogo + estado REAL de los agentes gestionados por el INSTALADOR.
// Fusiona: contrato ops + catálogo de la bóveda + productos instalados.
// Sin INSTALADOR alcanzable → responde bridge:{status} (sin datos falsos).
// ============================================================
import { NextResponse } from "next/server"
import { resolveRequester } from "@/lib/eec/security/auth"
import { AlbraBridgeError, albraOpsToken, executeAlbraOp, fetchAlbraGet } from "@/lib/albra-bridge/ops-client"
import { listManagedOps } from "@/lib/albra-bridge/records"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const requester = resolveRequester(req)
  if (!requester) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Autenticación de operador requerida." } }, { status: 401 })
  }

  const bridgeConfigured = Boolean(albraOpsToken())

  // 1) Catálogo de la bóveda del INSTALADOR (lectura pública de su API).
  let catalog: Array<{ productId: string; displayName: string; latestVersion?: string | null; installable?: boolean; category?: string }> = []
  try {
    const raw = await fetchAlbraGet<{ items?: unknown[] } | unknown[]>("/api/catalog")
    const items = Array.isArray(raw) ? raw : raw.items ?? []
    catalog = items.map((i) => {
      const o = i as Record<string, unknown>
      return {
        productId: String(o.productId ?? o.id ?? ""),
        displayName: String(o.displayName ?? o.name ?? o.productId ?? ""),
        latestVersion: (o.latestVersion as string) ?? null,
        installable: (o.installable as boolean) ?? (o.canInstall as boolean) ?? true,
        category: (o.category as string) ?? undefined,
      }
    })
  } catch (e) {
    const err = e as AlbraBridgeError
    return NextResponse.json(
      { bridge: { configured: bridgeConfigured, status: err.code }, agents: [], recentOps: [], error: { code: err.code, message: err.message } },
      { status: 200 },
    )
  }

  // 2) Estado REAL por producto vía STATUS del contrato ops (falla → UNKNOWN real).
  const agents = await Promise.all(
    catalog.map(async (item) => {
      try {
        const { response } = await executeAlbraOp("STATUS", item.productId)
        const state = response?.state as Record<string, unknown> | undefined
        return {
          ...item,
          available: true,
          installed: Boolean(state),
          state: (state?.state as string) ?? null,
          health: (state?.health as string) ?? null,
          version: (state?.version as string) ?? null,
          evidence: (state?.evidence as Record<string, unknown>) ?? null,
          lastError: response?.error ? `${response.error.code}: ${response.error.message}` : null,
        }
      } catch (e) {
        const err = e as AlbraBridgeError
        return {
          ...item,
          available: err.code !== "BRIDGE_NOT_CONFIGURED",
          installed: false,
          state: null,
          health: null,
          version: null,
          evidence: null,
          lastError: `${err.code}: ${err.message}`,
        }
      }
    }),
  )

  const recentOps = (await listManagedOps(undefined, 20)).map((o) => ({
    id: o.id, productId: o.productId, operation: o.operation, accepted: o.accepted,
    runId: o.runId, resultCode: o.resultCode, createdAt: o.createdAt,
  }))

  return NextResponse.json({ bridge: { configured: bridgeConfigured, status: bridgeConfigured ? "OK" : "NOT_CONFIGURED" }, agents, recentOps })
}
