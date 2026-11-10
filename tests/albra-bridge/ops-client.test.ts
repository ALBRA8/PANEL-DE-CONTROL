// ============================================================
// ALBRA BRIDGE — pruebas del contrato de solicitud ops (§EEC)
// requestId/nonce únicos, expiración ≤ 5 min, sin token → error explícito.
// ============================================================
import { describe, test, expect } from 'bun:test'
import { buildOpsRequest, executeAlbraOp, AlbraBridgeError } from '../../src/lib/albra-bridge/ops-client'

describe('albra-bridge: contrato de solicitud ops', () => {
  test('requestId y nonce son únicos por solicitud', () => {
    const a = buildOpsRequest('START', 'chismoso')
    const b = buildOpsRequest('START', 'chismoso')
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.operation).toBe('START')
    expect(a.productId).toBe('chismoso')
  })

  test('expiración dentro de la ventana ≤ 5 min del contrato', () => {
    const req = buildOpsRequest('INSTALL', 'chismoso')
    const windowMs = Date.parse(req.expiresAt) - Date.parse(req.issuedAt)
    expect(windowMs).toBeGreaterThan(0)
    expect(windowMs).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  test('params se adjuntan solo cuando aportan valor', () => {
    const withParams = buildOpsRequest('UNINSTALL', 'chismoso', { dataMode: 'KEEP', purgeData: false })
    expect(withParams.params).toEqual({ dataMode: 'KEEP', purgeData: false })
    const without = buildOpsRequest('STATUS', 'chismoso')
    expect(without.params).toBeUndefined()
  })

  test('sin ALBRA_OPS_TOKEN → BRIDGE_NOT_CONFIGURED (nunca simula)', async () => {
    const prev = process.env.ALBRA_OPS_TOKEN
    delete process.env.ALBRA_OPS_TOKEN
    try {
      await executeAlbraOp('STATUS', 'chismoso')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AlbraBridgeError)
      expect((e as AlbraBridgeError).code).toBe('BRIDGE_NOT_CONFIGURED')
    } finally {
      if (prev) process.env.ALBRA_OPS_TOKEN = prev
    }
  })
})
