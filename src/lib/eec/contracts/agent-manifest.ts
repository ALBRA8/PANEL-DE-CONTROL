// ============================================================
// EEC — CONTRATO COMÚN DE AGENTES (EEC V2, §3 del mandato)
//
// Manifiesto versionado, explícito y validable para incorporar
// agentes heterogéneos (proceso local, servicio HTTP, …) sin una
// integración a medida por agente.
//
// Principios:
//  - El manifiesto es DECLARADO; la salud y las ejecuciones son
//    OBSERVADAS. El EEC nunca confunde lo uno con lo otro.
//  - Los secretos se referencian por nombre (secretRef), jamás
//    viajan en el manifiesto.
//  - Compatibilidad por versión MAYOR: major distinto → rechazo
//    explícito (E_CONTRACT_MAJOR_MISMATCH), nunca interpretación
//    "best effort" de contratos desconocidos.
// ============================================================
import { z } from 'zod'

export const AGENT_CONTRACT_VERSION = '1.0.0'
const SUPPORTED_MAJOR = 1

// ---------- sub-esquemas ----------

const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

const RuntimeLocalProcess = z.object({
  type: z.literal('LOCAL_PROCESS'),
  /** Ejecutable EXPLÍCITO (nombre resolvible en PATH o ruta absoluta). Validado contra allowlist del EEC. */
  executable: z.string().min(1).max(300),
  /** Argumentos fijos del proceso. La entrada de tarea viaja por STDIN (nunca por shell). */
  args: z.array(z.string().max(200)).max(50).default([]),
  /** Directorio de trabajo; validado contra allowlist EEC_ALLOWED_WORKDIRS. */
  workdir: z.string().max(300).optional(),
  /** Modo de health check por ejecución puntual del binario. */
  healthArgs: z.array(z.string().max(200)).max(20).default(['--eec-health']),
})

const RuntimeHttpService = z.object({
  type: z.literal('HTTP_SERVICE'),
  /** Base URL del servicio del agente (https preferible; http solo en red confiable). */
  endpoint: z.string().url().max(300),
  /** Nombre de variable de entorno que contiene el token de servicio (nunca el valor). */
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  /** Timeout de HTTP en ms. */
  timeoutMs: z.number().int().min(250).max(600_000).default(15_000),
})

const Capability = z.object({
  /** Operación que el agente declara saber ejecutar (ej: 'report.generate'). */
  op: z.string().regex(/^[a-z0-9._-]+$/).min(2).max(80),
  description: z.string().max(300).optional(),
  risk: RiskLevel.default('LOW'),
  /** Si true, el EEC exige aprobación humana antes de despachar esta operación. */
  requiresApproval: z.boolean().default(false),
})

const ConfigEntry = z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  required: z.boolean().default(true),
  /** Nombre de la variable de entorno que contiene el secreto (referencia, no valor). */
  secretRef: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  description: z.string().max(200).optional(),
})

const Limits = z.object({
  /** Timeout máximo de la ejecución completa. */
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
  /** Reintentos máximos ante fallo TRANSITORIO. 0 = no reintentar jamás (default seguro). */
  maxRetries: z.number().int().min(0).max(3).default(0),
  /** Las reintentos requieren que la operación sea declarada idempotente. */
  idempotent: z.boolean().default(false),
})

// ---------- manifiesto completo ----------

export const AgentManifestSchema = z.object({
  contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver requerido'),
  identity: z.object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-_]{1,39}$/),
    name: z.string().min(2).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    owner: z.string().min(1).max(80),
    description: z.string().max(400).optional(),
  }),
  source: z.object({
    repo: z.string().max(300).optional(),
    release: z.string().max(80).optional(),
  }).default({}),
  platform: z.object({
    os: z.enum(['linux', 'darwin', 'windows', 'any']).default('linux'),
    requirements: z.array(z.string().max(120)).max(20).default([]),
  }).default({}),
  runtime: z.discriminatedUnion('type', [RuntimeLocalProcess, RuntimeHttpService]),
  capabilities: z.array(Capability).min(1).max(50),
  config: z.array(ConfigEntry).max(30).default([]),
  limits: Limits.default({}),
  /** kind de health check implícito en runtime; observaciones extra opcionales. */
  health: z.object({
    intervalMs: z.number().int().min(5_000).max(3_600_000).default(60_000),
  }).default({}),
})

export type AgentManifest = z.infer<typeof AgentManifestSchema>
export type ManifestCapability = z.infer<typeof Capability>

// ---------- validación + compatibilidad ----------

export interface ManifestValidation {
  ok: boolean
  manifest?: AgentManifest
  errors: string[]
  /** true si el manifiesto es sintácticamente válido pero de una versión mayor no soportada. */
  incompatibleMajor?: boolean
}

export function validateManifest(raw: unknown): ManifestValidation {
  const parsed = AgentManifestSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 20),
    }
  }
  const manifest = parsed.data
  const major = Number.parseInt(manifest.contractVersion.split('.')[0] ?? '0', 10)
  if (major !== SUPPORTED_MAJOR) {
    return {
      ok: false,
      errors: [`E_CONTRACT_MAJOR_MISMATCH: manifiesto ${manifest.contractVersion} incompatible con contrato soportado ^${SUPPORTED_MAJOR}.0.0`],
      incompatibleMajor: true,
    }
  }
  // reglas cruzadas
  const errors: string[] = []
  // §5: no repetir automáticamente operaciones externas no idempotentes
  if (manifest.limits.maxRetries > 0 && !manifest.limits.idempotent) {
    errors.push('limits.maxRetries>0 exige limits.idempotent=true para operaciones externas no idempotentes')
  }
  for (const c of manifest.config) {
    if (c.secretRef && !/^[A-Z_][A-Z0-9_]*$/.test(c.secretRef)) errors.push(`config.${c.name}.secretRef inválido`)
  }
  if (errors.length > 0) return { ok: false, errors, manifest }
  return { ok: true, manifest, errors: [] }
}

/** true si dos versiones son compatibles (misma mayor). */
export function isContractCompatible(contractVersion: string): boolean {
  const major = Number.parseInt(contractVersion.split('.')[0] ?? '0', 10)
  return major === SUPPORTED_MAJOR
}

// ---------- ejemplos canónicos ----------

/** Manifiesto del agente de prueba del piloto (proceso real, determinista). */
export const EXAMPLE_LOCAL_PROCESS_MANIFEST: AgentManifest = {
  contractVersion: '1.0.0',
  identity: { code: 'ECO-01', name: 'Agente Eco (piloto)', version: '1.0.0', owner: 'ALBRA8', description: 'Agente determinista de prueba: emite progreso NDJSON por stdout y resultado estructurado.' },
  source: { repo: 'ALBRA8/PANEL-DE-CONTROL', release: 'agents/echo-agent' },
  platform: { os: 'linux', requirements: ['bun o node >= 18'] },
  runtime: { type: 'LOCAL_PROCESS', executable: 'bun', args: ['agents/echo-agent/agent.mjs'], workdir: '.', healthArgs: ['agents/echo-agent/agent.mjs', '--eec-health'] },
  capabilities: [
    { op: 'echo.work', description: 'Trabajo determinista con progreso y resultado estructurado', risk: 'LOW', requiresApproval: false },
    { op: 'echo.heavy', description: 'Trabajo prolongado (demo cancel/timeout)', risk: 'MEDIUM', requiresApproval: false },
  ],
  config: [],
  limits: { timeoutMs: 60_000, maxRetries: 0, idempotent: false },
  health: { intervalMs: 60_000 },
}

/** Ejemplo de agente HTTP (contrato preparado; requiere servicio real que lo exponga). */
export const EXAMPLE_HTTP_MANIFEST: AgentManifest = {
  contractVersion: '1.0.0',
  identity: { code: 'HTTP-DEMO', name: 'Agente HTTP demo', version: '1.0.0', owner: 'ALBRA8' },
  source: {},
  platform: { os: 'any', requirements: [] },
  runtime: { type: 'HTTP_SERVICE', endpoint: 'https://agente.example.internal', tokenEnv: 'HTTP_DEMO_TOKEN', timeoutMs: 15_000 },
  capabilities: [{ op: 'demo.op', risk: 'LOW', requiresApproval: false }],
  config: [{ name: 'HTTP_DEMO_TOKEN', required: true, secretRef: 'HTTP_DEMO_TOKEN' }],
  limits: { timeoutMs: 120_000, maxRetries: 0, idempotent: false },
  health: { intervalMs: 60_000 },
}
