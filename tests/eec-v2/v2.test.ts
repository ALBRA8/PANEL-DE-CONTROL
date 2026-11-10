// ============================================================
// EEC V2 — PRUEBAS UNITARIAS/INTEGRACIÓN (§10 del mandato)
// bun test tests/eec-v2/
// Cubre: contrato+versiones, allowlists, redacción de secretos,
// identidad/autenticación, rate limit, adaptador de proceso real
// (spawn/timeout/cancel/fallos/malformado), reconciliación,
// frontera INSTALADOR honesta.
// ============================================================
import { describe, test, expect } from 'bun:test'
import { validateManifest, isContractCompatible, EXAMPLE_LOCAL_PROCESS_MANIFEST } from '../../src/lib/eec/contracts/agent-manifest'
import { resolveExecutable, validateWorkdir } from '../../src/lib/eec/providers/adapters/local-process'
import { redactSecrets, createSessionToken, verifySessionToken, loginOperator, resolveRequester, authConfigured } from '../../src/lib/eec/security/auth'
import { checkRate } from '../../src/lib/eec/security/rate-limit'
import { UnavailableInstaladorAdapter } from '../../src/lib/eec/providers/adapters/instalador'
import { canRunTransition } from '../../src/lib/eec/domain/types'


// Entorno autocontenido: el allowlist debe declararse en el propio test
// (los tests de origin dependían del entorno de la máquina del autor).
import path from 'node:path'
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
process.env.EEC_ALLOWED_WORKDIRS = [process.env.EEC_ALLOWED_WORKDIRS, REPO_ROOT].filter(Boolean).join(',')

const SFX = Date.now().toString(36)

// ---------- contrato (§3) ----------
describe('V2 contrato de agentes', () => {
  test('manifiesto válido aceptado', () => {
    const v = validateManifest(EXAMPLE_LOCAL_PROCESS_MANIFEST)
    expect(v.ok).toBe(true)
    expect(v.manifest?.runtime.type).toBe('LOCAL_PROCESS')
  })

  test('campos obligatorios ausentes → rechazado con errores enumerados', () => {
    const v = validateManifest({ contractVersion: '1.0.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.length).toBeGreaterThan(0)
  })

  test('versión mayor incompatible → E_CONTRACT_MAJOR_MISMATCH (sin best-effort)', () => {
    const v = validateManifest({ ...EXAMPLE_LOCAL_PROCESS_MANIFEST, contractVersion: '2.1.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('E_CONTRACT_MAJOR_MISMATCH')
    expect(v.incompatibleMajor).toBe(true)
  })

  test('isContractCompatible: 1.x compatible, 2.x y basura no', () => {
    expect(isContractCompatible('1.9.9')).toBe(true)
    expect(isContractCompatible('2.0.0')).toBe(false)
    expect(isContractCompatible('x.y.z')).toBe(false)
  })

  test('maxRetries>0 sin idempotente declarado → rechazado (operaciones externas)', () => {
    const m = JSON.parse(JSON.stringify(EXAMPLE_LOCAL_PROCESS_MANIFEST)) as { limits: { maxRetries: number; idempotent: boolean } }
    m.limits.maxRetries = 2
    m.limits.idempotent = false
    expect(validateManifest(m).ok).toBe(false)
    m.limits.idempotent = true
    expect(validateManifest(m).ok).toBe(true)
  })

  test('código de identidad con caracteres inválidos → rechazado', () => {
    const m = JSON.parse(JSON.stringify(EXAMPLE_LOCAL_PROCESS_MANIFEST)) as { identity: { code: string } }
    m.identity.code = 'código inválido con espacios!'
    expect(validateManifest(m).ok).toBe(false)
  })
})

// ---------- adaptador de proceso local: allowlists (§4) ----------
describe('V2 allowlists de proceso local', () => {
  test('ejecutable no autorizado → executable_not_allowlisted', () => {
    const r = resolveExecutable('python3')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('executable_not_allowlisted')
  })

  test('ejecutable inexistente → executable_not_found', () => {
    const r = resolveExecutable(`no-existe-${SFX}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('executable_not_found')
  })

  test('ejecutable del runtime (bun) autorizado', () => {
    const r = resolveExecutable('bun')
    expect(r.ok).toBe(true)
  })

  test('workdir dentro del allowlist → ok', () => {
    // Ruta portátil: dentro de la raíz del repo (declarada en el allowlist del propio test).
    const r = validateWorkdir(path.join(REPO_ROOT, 'agents'))
    expect(r.ok).toBe(true)
  })

  test('path traversal fuera del allowlist → workdir_not_allowlisted', () => {
    const r = validateWorkdir('/etc')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('workdir_not_allowlisted')
    const r2 = validateWorkdir('../../../../etc')
    expect(r2.ok).toBe(false)
  })
})

// ---------- seguridad: secretos, identidad, rate limit (§6) ----------
describe('V2 seguridad', () => {
  test('redactSecrets elimina patrones de secretos comunes', () => {
    const out = redactSecrets('key sk-abcdef12345678 y ghp_1234567890123456789012345', [])
    expect(out).not.toContain('sk-abcdef12345678')
    expect(out).not.toContain('ghp_1234567890')
    expect(out).toContain('[REDACTED]')
  })

  test('redactSecrets con lista extra', () => {
    const out = redactSecrets('token=SUPERSECRETO123 fin', ['SUPERSECRETO123'])
    expect(out).not.toContain('SUPERSECRETO123')
    expect(out).toContain('[REDACTED]')
  })

  test('sesión firmada: válida, expirada y manipulada', () => {
    const tok = createSessionToken('tester')
    expect(verifySessionToken(tok)?.op).toBe('tester')
    expect(verifySessionToken(`${tok}x`)).toBeNull() // manipulada
    expect(verifySessionToken('abc.def.ghi')).toBeNull()
  })

  test('login: credencial correcta/incorrecta/sin configurar', () => {
    const prev = process.env.EEC_OPERATOR_PASSWORD
    process.env.EEC_OPERATOR_PASSWORD = 'pass-larga-de-test-123'
    expect(loginOperator('pass-larga-de-test-123').ok).toBe(true)
    expect(loginOperator('incorrecta').ok).toBe(false)
    delete process.env.EEC_OPERATOR_PASSWORD
    const r = loginOperator('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('auth_not_configured')
    if (prev) process.env.EEC_OPERATOR_PASSWORD = prev
  })

  test('resolveRequester: bearer válido → HUMAN; inválido → null; sin credencial → null', () => {
    const prev = process.env.EEC_API_TOKEN
    process.env.EEC_API_TOKEN = 'token-de-test-123456'
    const req = new Request('http://x/api/eec/commands', { method: 'POST', headers: { authorization: 'Bearer token-de-test-123456' } })
    const id = resolveRequester(req)
    expect(id?.requesterType).toBe('HUMAN')
    expect(id?.via).toBe('bearer')
    const bad = new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer incorrecto' } })
    expect(resolveRequester(bad)).toBeNull()
    const anon = new Request('http://x', { method: 'POST' })
    expect(resolveRequester(anon)).toBeNull()
    if (prev) process.env.EEC_API_TOKEN = prev
    else delete process.env.EEC_API_TOKEN
  })

  test('authConfigured refleja el entorno', () => {
    const prev = process.env.EEC_API_TOKEN
    process.env.EEC_API_TOKEN = 'x-token-de-test-1234'
    expect(authConfigured()).toBe(true)
    delete process.env.EEC_API_TOKEN
    const prevP = process.env.EEC_OPERATOR_PASSWORD
    delete process.env.EEC_OPERATOR_PASSWORD
    expect(authConfigured()).toBe(false)
    if (prev) process.env.EEC_API_TOKEN = prev
    if (prevP) process.env.EEC_OPERATOR_PASSWORD = prevP
  })

  test('rate limit: ventana deslizante bloquea al superar el límite', () => {
    const key = `tst-${SFX}`
    for (let i = 0; i < 5; i++) {
      expect(checkRate(key, 5, 60_000).allowed).toBe(true)
    }
    const blocked = checkRate(key, 5, 60_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })
})

// ---------- máquina de estados RUN: UNRECONCILED (§5) ----------
describe('V2 estados RUN', () => {
  test('UNRECONCILED existe y solo sale de RUNNING', () => {
    expect(canRunTransition('RUNNING', 'UNRECONCILED')).toBe(true)
    expect(canRunTransition('SUCCEEDED', 'UNRECONCILED')).toBe(false)
    expect(canRunTransition('UNRECONCILED', 'FAILED')).toBe(true)
    expect(canRunTransition('UNRECONCILED', 'PENDING')).toBe(false)
  })
})

// ---------- frontera INSTALADOR honesta (§7) ----------
describe('V2 frontera INSTALADOR', () => {
  test('sin configuración informa not_configured — nunca simula éxito', async () => {
    const prev = process.env.EEC_INSTALLADOR_URL
    delete process.env.EEC_INSTALLADOR_URL
    const a = new UnavailableInstaladorAdapter()
    const st = await a.getStatus({ ref: 'agente-x', kind: 'AGENT' })
    expect(st.available).toBe(false)
    if (!st.available) expect(st.reason).toBe('not_configured')
    const op = await a.requestOperation('start', { ref: 'agente-x', kind: 'AGENT' })
    expect(op.available).toBe(false)
    const ls = await a.listManaged()
    expect(ls.available).toBe(false)
    if (prev) process.env.EEC_INSTALLADOR_URL = prev
  })
})
