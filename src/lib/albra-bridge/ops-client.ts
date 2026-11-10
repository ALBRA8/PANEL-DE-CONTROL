// ============================================================
// ALBRA BRIDGE — cliente servidor del contrato de operaciones
// del INSTALADOR (POST /api/ops).
//
// Contrato (INSTALADOR src/lib/albra/contracts/eec.ts):
//   { contractVersion: "1.0.0", requestId, operation, productId,
//     params?, nonce, issuedAt, expiresAt }  + Authorization: Bearer
//
// Reglas:
//   - El PANEL NUNCA ejecuta Docker ni simula estados: cada
//     operación la confirma el INSTALADOR (accepted/error real).
//   - Nonce único por solicitud (crypto.randomUUID), expiración ≤ 5 min.
//   - Sin token configurado → error explícito (nunca datos falsos).
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

export interface EecOpsResponse {
  contractVersion: string
  requestId: string
  accepted: boolean
  operation: string
  productId: string
  runId?: string
  state?: Record<string, unknown>
  health?: Record<string, unknown>
  detail?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** Construye la solicitud firmada del contrato (requestId/nonce/expiración). */
export function buildOpsRequest(operation: AlbraOperation, productId: string, params?: Record<string, unknown>): EecOpsRequest {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 4 * 60 * 1000) // ≤ ventana de 5 min del contrato
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

/**
 * Ejecuta una operación REAL contra el INSTALADOR.
 * Sin token → AlbraBridgeError("BRIDGE_NOT_CONFIGURED").
 * Nunca lanza por accepted:false — devuelve la respuesta del contrato.
 */
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
    const json = (await res.json()) as EecOpsResponse
    return { request, response: json, httpStatus }
  } catch (e) {
    if (e instanceof AlbraBridgeError) throw e
    return { request, response: null, httpStatus, transportError: (e as Error).message }
  }
}

/** Lectura directa (solo lectura) de endpoints abiertos del INSTALADOR. */
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
