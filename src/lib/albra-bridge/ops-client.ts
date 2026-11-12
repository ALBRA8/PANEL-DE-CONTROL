// ============================================================
// ALBRA BRIDGE — cliente servidor del contrato de operaciones
// del INSTALADOR (POST /api/ops).
//
// La respuesta canónica V1 siempre anida los datos bajo result:
// { contractVersion, requestId, accepted, operation, productId,
//   result?: { runId?, state?, health?, detail? }, error? }
// ============================================================
import { randomUUID } from "node:crypto"

export const ALBRA_OPS_CONTRACT_VERSION = "1.0.0"

export function albraOpsUrl(): string {
  return (process.env.ALBRA_OPS_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "")
}

export function albraOpsToken(): string | null {
  const t = process.env.ALBRA_OPS_TOKEN?.trim()
  return t ? t : null
}

export class AlbraBridgeError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type AlbraOperation =
  | "INSTALL" | "START" | "STOP" | "RESTART" | "HEALTH" | "UPDATE"
  | "ROLLBACK" | "BACKUP" | "RESTORE" | "UNINSTALL" | "DIAGNOSTICS" | "STATUS"

export interface EecOpsRequest {
  contractVersion: typeof ALBRA_OPS_CONTRACT_VERSION
  requestId: string
  operation: AlbraOperation
  productId: string
  params?: Record<string, unknown>
  nonce: string
  issuedAt: string
  expiresAt: string
}

export interface EecOpsResult {
  runId?: string
  state?: Record<string, unknown>
  health?: Record<string, unknown>
  detail?: unknown
}

export interface EecOpsResponse {
  contractVersion: typeof ALBRA_OPS_CONTRACT_VERSION
  requestId: string
  accepted: boolean
  operation: AlbraOperation
  productId: string
  result?: EecOpsResult
  error?: { code: string; message: string }
}

export function buildOpsRequest(operation: AlbraOperation, productId: string, params?: Record<string, unknown>): EecOpsRequest {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 4 * 60 * 1000)
  return {
    contractVersion: ALBRA_OPS_CONTRACT_VERSION,
    requestId: randomUUID(),
    operation,
    productId,
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    nonce: randomUUID(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

export function validateOpsResponse(value: unknown, request: EecOpsRequest): EecOpsResponse {
  if (!value || typeof value !== "object") {
    throw new AlbraBridgeError("BRIDGE_INVALID_RESPONSE", "El INSTALADOR devolvió una respuesta que no es un objeto.")
  }
  const response = value as Record<string, unknown>
  if (
    response.contractVersion !== ALBRA_OPS_CONTRACT_VERSION ||
    response.requestId !== request.requestId ||
    response.operation !== request.operation ||
    response.productId !== request.productId ||
    typeof response.accepted !== "boolean"
  ) {
    throw new AlbraBridgeError("BRIDGE_CONTRACT_MISMATCH", "La respuesta del INSTALADOR no coincide con la solicitud EEC V1.")
  }
  if (response.result !== undefined && (!response.result || typeof response.result !== "object" || Array.isArray(response.result))) {
    throw new AlbraBridgeError("BRIDGE_INVALID_RESPONSE", "El campo result del INSTALADOR tiene un formato inválido.")
  }
  // V1 canónica: los datos SIEMPRE van anidados bajo result. Un campo de raíz
  // antiguo (runId/state/health/detail sueltos) es un contrato que no coincide.
  for (const legacy of ["runId", "state", "health", "detail"] as const) {
    if (response[legacy] !== undefined) {
      throw new AlbraBridgeError(
        "BRIDGE_CONTRACT_MISMATCH",
        `La respuesta del INSTALADOR no coincide con la V1 canónica: usa el campo de raíz antiguo '${legacy}' (los datos van anidados bajo result).`,
      )
    }
  }
  if (response.error !== undefined) {
    const error = response.error as Record<string, unknown>
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new AlbraBridgeError("BRIDGE_INVALID_RESPONSE", "El campo error del INSTALADOR tiene un formato inválido.")
    }
  }
  if (response.accepted === false && response.error === undefined) {
    throw new AlbraBridgeError("BRIDGE_INVALID_RESPONSE", "Una operación rechazada debe incluir error.code y error.message.")
  }
  return response as unknown as EecOpsResponse
}

/** Ejecuta una operación real. accepted:false se devuelve como resultado de negocio. */
export async function executeAlbraOp(
  operation: AlbraOperation,
  productId: string,
  params?: Record<string, unknown>,
): Promise<{ request: EecOpsRequest; response: EecOpsResponse | null; httpStatus: number; transportError?: string }> {
  const token = albraOpsToken()
  if (!token) {
    throw new AlbraBridgeError(
      "BRIDGE_NOT_CONFIGURED",
      "ALBRA_OPS_TOKEN no está configurado: el PANEL no puede solicitar operaciones al INSTALADOR.",
      503,
    )
  }
  const request = buildOpsRequest(operation, productId, params)
  let httpStatus = 0
  try {
    const res = await fetch(`${albraOpsUrl()}/api/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    })
    httpStatus = res.status
    if (res.status === 401) {
      throw new AlbraBridgeError("BRIDGE_UNAUTHORIZED", "El INSTALADOR rechazó el token de operaciones (401).", 502)
    }
    if (!res.ok) {
      throw new AlbraBridgeError("BRIDGE_UPSTREAM_ERROR", `El INSTALADOR respondió HTTP ${res.status}.`)
    }
    let json: unknown
    try { json = await res.json() } catch {
      throw new AlbraBridgeError("BRIDGE_INVALID_RESPONSE", "El INSTALADOR no devolvió JSON válido.")
    }
    return { request, response: validateOpsResponse(json, request), httpStatus }
  } catch (e) {
    if (e instanceof AlbraBridgeError) throw e
    return { request, response: null, httpStatus, transportError: (e as Error).message }
  }
}

/** Lectura directa de endpoints de solo lectura del INSTALADOR. */
export async function fetchAlbraGet<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`${albraOpsUrl()}${path}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new AlbraBridgeError("BRIDGE_UPSTREAM_ERROR", `INSTALADOR ${path} respondió ${res.status}`, 502)
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof AlbraBridgeError) throw e
    throw new AlbraBridgeError("BRIDGE_UNREACHABLE", `No se pudo contactar al INSTALADOR (${path}): ${(e as Error).message}`, 502)
  }
}
