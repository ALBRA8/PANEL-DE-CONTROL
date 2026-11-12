// ============================================================
// ALBRA BRIDGE — registro de operaciones delegadas.
// Persiste el sobre y el resultado canónico real del INSTALADOR.
// ============================================================
import { db } from "@/lib/db"
import type { EecOpsRequest, EecOpsResponse } from "./ops-client"

export async function recordManagedOp(input: {
  request: EecOpsRequest
  response: EecOpsResponse | null
  transportError?: string
  paramsJson?: Record<string, unknown>
  startedAt: number
}): Promise<void> {
  const { request, response, transportError, paramsJson, startedAt } = input
  const result = response?.result
  try {
    await db.managedOperation.create({
      data: {
        requestId: request.requestId,
        productId: request.productId,
        operation: request.operation,
        accepted: response?.accepted ?? false,
        runId: result?.runId ?? null,
        contractVersion: request.contractVersion,
        resultCode: response?.accepted ? "ACCEPTED" : response?.error?.code ?? (transportError ? "TRANSPORT_ERROR" : "NO_RESPONSE"),
        resultJson: (result ?? undefined) as never,
        errorJson: (response?.error ?? (transportError ? { code: "TRANSPORT_ERROR", message: transportError } : undefined)) as never,
        paramsJson: (paramsJson ?? request.params ?? undefined) as never,
        durationMs: Date.now() - startedAt,
        // An async operation is only ACCEPTED when it returns runId; resolve it only after polling confirms a terminal run state.
        resolvedAt: response && !result?.runId ? new Date() : null,
      },
    })
  } catch {
    // El registro best-effort no debe convertir una respuesta real en falsa.
  }
}

export async function listManagedOps(productId?: string, limit = 30) {
  return db.managedOperation.findMany({
    where: productId ? { productId } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  })
}


/**
 * Reconciles a persisted PANEL operation with the authoritative lifecycle run
 * returned by the INSTALADOR. Unknown/non-terminal states never resolve it.
 */
export async function syncManagedOpRun(runId: string, run: unknown): Promise<void> {
  if (!run || typeof run !== "object" || Array.isArray(run)) return
  const dto = run as Record<string, unknown>
  if (dto.id !== runId || typeof dto.status !== "string") return

  const terminal: Record<string, string> = {
    SUCCESS: "SUCCEEDED",
    WARNING: "SUCCEEDED_WITH_WARNINGS",
    FAILURE: "FAILED",
    ROLLED_BACK: "ROLLED_BACK",
  }
  const resultCode = terminal[dto.status]
  if (!resultCode) return

  await db.managedOperation.updateMany({
    where: { runId, resolvedAt: null },
    data: {
      resultCode,
      resultJson: dto as never,
      errorJson: dto.status === "FAILURE"
        ? ({ code: "RUN_FAILED", message: typeof dto.error === "string" ? dto.error : "El run terminó con error." } as never)
        : undefined,
      resolvedAt: new Date(),
    },
  })
}
