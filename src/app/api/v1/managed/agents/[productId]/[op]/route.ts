// ============================================================
// ALBRA BRIDGE — POST /api/v1/managed/agents/[productId]/[op]
// Delega la operación al INSTALADOR vía contrato EEC (/api/ops).
// ops permitidas: install|start|stop|restart|health|status|update|rollback|
//                 backup|restore|uninstall|diagnostics
// REGISTRA el resultado REAL (accepted/runId/error) en ManagedOperation.
// La desinstalación NUNCA borra datos salvo body.confirmDataLoss=true
// + params.purgeData=true (el INSTALADOR vuelve a exigirlo).
// ============================================================
import { NextResponse } from "next/server"
import { resolveRequester } from "@/lib/eec/security/auth"
import { AlbraBridgeError, executeAlbraOp, type AlbraOperation } from "@/lib/albra-bridge/ops-client"
import { recordManagedOp } from "@/lib/albra-bridge/records"

export const dynamic = "force-dynamic"

const OP_MAP: Record<string, AlbraOperation> = {
  install: "INSTALL",
  start: "START",
  stop: "STOP",
  restart: "RESTART",
  health: "HEALTH",
  status: "STATUS",
  update: "UPDATE",
  rollback: "ROLLBACK",
  backup: "BACKUP",
  restore: "RESTORE",
  uninstall: "UNINSTALL",
  diagnostics: "DIAGNOSTICS",
}

export async function POST(req: Request, ctx: { params: Promise<{ productId: string; op: string }> }) {
  const requester = resolveRequester(req)
  if (!requester) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Autenticación de operador requerida." } }, { status: 401 })
  }

  const { productId, op } = await ctx.params
  const operation = OP_MAP[op]
  if (!operation) {
    return NextResponse.json({ error: { code: "UNKNOWN_OPERATION", message: `Operación no soportada: ${op}` } }, { status: 400 })
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(productId)) {
    return NextResponse.json({ error: { code: "INVALID_PRODUCT_ID", message: "productId inválido." } }, { status: 400 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch { /* body vacío permitido */ }

  // Parámetros por operación (validados de nuevo por el INSTALADOR).
  const params: Record<string, unknown> = {}
  if (operation === "UPDATE" && typeof body.targetVersion === "string") params.targetVersion = body.targetVersion
  if (operation === "BACKUP" && typeof body.kind === "string") params.kind = body.kind
  if (operation === "RESTORE" && typeof body.backupId === "string") params.backupId = body.backupId
  if (operation === "UNINSTALL") {
    params.dataMode = body.dataMode === "EXPORT" ? "EXPORT" : body.dataMode === "DELETE" ? "DELETE" : "KEEP"
    // Doble confirmación: el PANEL exige confirmDataLoss=true Y el INSTALADOR exige purgeData.
    if (body.confirmDataLoss === true && body.dataMode === "DELETE") params.purgeData = true
  }

  const startedAt = Date.now()
  try {
    const { request, response, transportError } = await executeAlbraOp(operation, productId, params)
    await recordManagedOp({ request, response, transportError, paramsJson: params, startedAt })
    if (!response) {
      return NextResponse.json(
        { requestId: request.requestId, accepted: false, error: { code: "BRIDGE_UNREACHABLE", message: transportError ?? "El INSTALADOR no respondió." } },
        { status: 502 },
      )
    }
    return NextResponse.json(response)
  } catch (e) {
    const err = e as AlbraBridgeError
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status })
  }
}
