// ============================================================
// EEC — CONTRATO DE CICLO DE VIDA (frontera con INSTALADOR, §7)
//
// El INSTALADOR es RESPONSABLE del ciclo de vida: instalar,
// configurar, iniciar, detener, reiniciar, actualizar, reparar,
// respaldar y revertir. El EEC NO duplica esas funciones: solo las
// SOLICITA por esta frontera versionada y autenticada, y registra
// la correlación solicitud ↔ operación.
//
// REGLA DE HONESTIDAD: aceptar una solicitud NO equivale a ejecutarla.
// El EEC solo reporta un cambio de estado cuando el INSTALADOR
// devuelve un RESULTADO VERIFICABLE. Si la frontera no está
// configurada, se informa "no disponible" — jamás se simula éxito.
// ============================================================

export const LIFECYCLE_CONTRACT_VERSION = '1.0.0'

export type LifecycleOperation =
  | 'install' | 'configure' | 'start' | 'stop' | 'restart'
  | 'upgrade' | 'repair' | 'backup' | 'rollback' | 'status'

export interface ManagedRef {
  /** Identidad del producto/agente según el INSTALADOR (su clave, no la del EEC). */
  ref: string
  kind: 'AGENT' | 'PRODUCT' | 'RUNTIME'
}

export interface LifecycleStatus {
  available: false | true
  ref: string
  /** Estado reportado por el INSTALADOR. El EEC lo trata como DECLARADO, no como evidencia directa. */
  state: string
  observedAt: string
  detail?: Record<string, unknown>
}

export interface LifecycleOperationResult {
  available: true
  /** Identificador de operación en el INSTALADOR para correlación/auditoría. */
  operationId: string
  /** Verificable: el INSTALADOR devolvió resultado concluyente de la operación. */
  verified: boolean
  state: string
  detail?: Record<string, unknown>
}

export interface LifecycleUnavailable {
  available: false
  reason: 'not_configured' | 'unreachable' | 'version_incompatible' | 'rejected' | 'timeout'
  detail?: string
}

export interface InstaladorInterface {
  readonly contractVersion: string
  /** Productos/agentes gestionados por el INSTALADOR. */
  listManaged(): Promise<{ available: true, refs: Array<ManagedRef & { state?: string }> } | LifecycleUnavailable>
  /** Estado de instalación/ciclo de vida de una referencia. */
  getStatus(ref: ManagedRef): Promise<LifecycleStatus | LifecycleUnavailable>
  /** Solicita una operación AUTORIZADA. Devuelve correlación y verificabilidad. */
  requestOperation(op: LifecycleOperation, ref: ManagedRef, opts?: { correlationId?: string; params?: Record<string, unknown> }):
    Promise<LifecycleOperationResult | LifecycleUnavailable>
}
