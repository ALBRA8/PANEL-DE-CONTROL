// ============================================================
// EEC — DOCTOR DEL SISTEMA (P2-2 · doc 07 matriz #26)
// Verificaciones REALES (no cosméticas) sobre el estado vivo:
//  1. conectividad y respuesta de la BD
//  2. integridad física (PRAGMA quick_check)
  // 3. pragmas de seguridad (foreign_keys)
//  4. cadena hash de auditoría íntegra (verifyAuditChain)
//  5. aprobaciones pendientes y estancadas (>24 h)
//  6. dead-letters del bus de eventos
//  7. modo simulación (honestidad del estado)
//  8. frontera INSTALADOR (provider LIFECYCLE honesto)
//  9. políticas de evidencia activas (gate con dientes)
// 10. administración por organización (catálogo y overrides)
// Solo lectura: NUNCA repara — declara (declarado vs observado).
// ============================================================
import { db } from '../../../lib/db'
import { verifyAuditChain } from './audit-chain'
import { isSimulationMode } from '../commands/pipeline'
import { providerRegistry } from '../domain/contracts'
import { ORG_FLAG_DEFS } from './org-flags'

export type CheckStatus = 'OK' | 'WARN' | 'FAIL'

export interface DoctorCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  ms: number
}

export interface DoctorReport {
  overall: CheckStatus
  checks: DoctorCheck[]
  durationMs: number
  generatedAt: string
}

const ORDER: Record<CheckStatus, number> = { OK: 0, WARN: 1, FAIL: 2 }

async function timed(id: string, label: string, fn: () => Promise<{ status: CheckStatus; detail: string }>): Promise<DoctorCheck> {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { id, label, status: r.status, detail: r.detail, ms: Date.now() - t0 }
  } catch (e) {
    return { id, label, status: 'FAIL', detail: `error: ${(e as Error).message}`, ms: Date.now() - t0 }
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const t0 = Date.now()
  const checks: DoctorCheck[] = []

  // 1. conectividad
  checks.push(await timed('db-connect', 'Conectividad de la base de datos', async () => {
    await db.$queryRawUnsafe('SELECT 1')
    return { status: 'OK', detail: 'SELECT 1 respondido' }
  }))

  // 2. integridad física
  checks.push(await timed('db-quick-check', 'Integridad física (PRAGMA quick_check)', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ quick_check: string }>>('PRAGMA quick_check')
    const first = rows[0]?.quick_check ?? 'sin respuesta'
    return first === 'ok'
      ? { status: 'OK', detail: 'quick_check = ok' }
      : { status: 'FAIL', detail: `quick_check = ${first}` }
  }))

  // 3. pragmas de seguridad
  checks.push(await timed('db-foreign-keys', 'Claves foráneas activas (PRAGMA foreign_keys)', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ foreign_keys: number }>>('PRAGMA foreign_keys')
    const on = Number(rows[0]?.foreign_keys ?? 0) === 1
    return on
      ? { status: 'OK', detail: 'foreign_keys = ON' }
      : { status: 'WARN', detail: 'foreign_keys = OFF (integridad referencial sin reforzar; initDbPragmas no ha corrido en esta conexión)' }
  }))

  // 4. cadena hash de auditoría
  checks.push(await timed('audit-chain', 'Cadena hash de auditoría (P0-1)', async () => {
    const v = await verifyAuditChain(1)
    const broken = v.brokenAt?.length ?? 0
    if (broken > 0) return { status: 'FAIL', detail: `cadena ROTA en ${broken} punto(s): seq ${v.brokenAt.slice(0, 5).join(',')}` }
    if (v.unsealedLegacy > 0) return { status: 'WARN', detail: `íntegra, con ${v.unsealedLegacy} registro(s) heredado(s) sin sello (backfill pendiente)` }
    return { status: 'OK', detail: `${v.checked} registro(s) verificados, sin rupturas` }
  }))

  // 5. aprobaciones pendientes/estancadas
  checks.push(await timed('approvals', 'Aprobaciones humanas pendientes', async () => {
    const pending = await db.approval.findMany({ where: { status: { in: ['REQUESTED', 'AWAITING_SIGNOFF'] } }, select: { id: true, createdAt: true, minimumHumanSignoff: true } })
    const stale = pending.filter(p => Date.now() - p.createdAt.getTime() > 24 * 3600_000)
    if (pending.length === 0) return { status: 'OK', detail: 'sin aprobaciones pendientes' }
    if (stale.length > 0) return { status: 'WARN', detail: `${pending.length} pendiente(s), ${stale.length} estancada(s) >24 h — revisar quórum` }
    return { status: 'OK', detail: `${pending.length} pendiente(s) recientes` }
  }))

  // 6. dead-letters
  checks.push(await timed('dead-letters', 'Dead-letters del bus de eventos', async () => {
    const n = await db.eventRecord.count({ where: { status: 'DEAD_LETTER' } })
    return n === 0
      ? { status: 'OK', detail: 'sin dead-letters' }
      : { status: 'WARN', detail: `${n} evento(s) en dead-letter (revisar reprocess en ops)` }
  }))

  // 7. modo simulación
  checks.push(await timed('simulation-mode', 'Modo simulación (honestidad del estado)', async () => {
    const on = isSimulationMode()
    return on
      ? { status: 'WARN', detail: 'SIMULACIÓN ACTIVA — las ejecuciones no tocan runtime real' }
      : { status: 'OK', detail: 'ejecución real (sim off)' }
  }))

  // 8. frontera INSTALADOR
  checks.push(await timed('instalador-boundary', 'Frontera INSTALADOR (ciclo de vida)', async () => {
    const life = providerRegistry.list('LIFECYCLE')
    const unavailable = life.find(p => p.key === 'instalador-unavailable')
    if (unavailable) return { status: 'WARN', detail: 'EEC_INSTALLADOR_URL sin configurar: registro/baja de agentes vía INSTALADOR NO disponible (frontera honesta, no simulada)' }
    return { status: 'OK', detail: `LIFECYCLE: ${life.map(p => p.key).join(', ')}` }
  }))

  // 9. políticas de evidencia activas
  checks.push(await timed('evidence-policies', 'Políticas de evidencia (Evidence Gate)', async () => {
    const n = await db.policy.count({ where: { enabled: true, type: 'EVIDENCE', effect: 'REQUIRE' } })
    return n === 0
      ? { status: 'WARN', detail: 'sin políticas EVIDENCE/REQUIRE activas: el gate no exige evidencia (fail-closed dormido)' }
      : { status: 'OK', detail: `${n} política(s) REQUIRE activa(s)` }
  }))

  // 10. administración por organización
  checks.push(await timed('org-admin', 'Administración por organización (P2-4)', async () => {
    const [orgs, overrides] = await Promise.all([
      db.organization.count(),
      db.orgFlag.count(),
    ])
    return { status: 'OK', detail: `${orgs} organización(es), ${overrides} override(s) sobre catálogo de ${ORG_FLAG_DEFS.length} flags` }
  }))

  const overall = checks.reduce<CheckStatus>((acc, c) => (ORDER[c.status] > ORDER[acc] ? c.status : acc), 'OK')
  return {
    overall,
    checks,
    durationMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  }
}
