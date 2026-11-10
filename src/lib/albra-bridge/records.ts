// ============================================================
// ALBRA BRIDGE — registro de operaciones delegadas.
// Cada solicitud al INSTALADOR se persiste con su resultado REAL
// (accepted/runId/error) para auditoría y para que la UI muestre
// estados confirmados, nunca simulados.
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
  try {
    await db.managedOperation.create({
      data: {
        requestId: request.requestId,
        productId: request.productId,
        operation: request.operation,
        accepted: response?.accepted ?? false,
        runId: response?.runId ?? null,
        contractVersion: request.contractVersion,
        resultCode: response?.accepted ? "ACCEPTED" : response?.error?.code ?? (transportError ? "TRANSPORT_ERROR" : "NO_RESPONSE"),
        resultJson: (response?.state ?? response?.health ?? response?.detail ?? undefined) as never,
        errorJson: (response?.error ?? (transportError ? { code: "TRANSPORT_ERROR", message: transportError } : undefined)) as never,
        paramsJson: (paramsJson ?? request.params ?? undefined) as never,
        durationMs: Date.now() - startedAt,
        resolvedAt: response ? new Date() : null,
      },
    })
  } catch {
    // Registro best-effort: nunca bloquea la respuesta del puente.
  }
}

export async function listManagedOps(productId?: string, limit = 30) {
  return db.managedOperation.findMany({
    where: productId ? { productId } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  })
}
