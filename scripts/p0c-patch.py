#!/usr/bin/env python3
"""P0-2 (doc 07 §3.2): Evidence Gate fail-closed.
Parchea archivos TRACKED sobre feature/v2-adaptacion-verticales.
Falla ruidosamente si un marcador no existe."""
from pathlib import Path
import sys

def must(cond, msg):
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

# ---------- 1) contracts.ts: EvidenceRef + salida de tool con evidencia ----------
con = Path("src/lib/eec/domain/contracts.ts")
t = con.read_text(encoding="utf-8")
anchor = """export interface ToolExecutionOutput {
  ok: boolean
  output: Record<string, unknown>
  cost?: number
  simulated?: boolean
  error?: string
}"""
repl = """export interface ToolExecutionOutput {
  ok: boolean
  output: Record<string, unknown>
  cost?: number
  simulated?: boolean
  error?: string
  /** P0-2 (doc 07 §3.2): evidencia que respalda la salida (claim-or-refuse). */
  evidence?: EvidenceRef[]
}

// ---------- EVIDENCE (P0-2 · doc 07 §3.2) ----------
/** Referencia de evidencia: el vertical define qué es "fuente aceptable". */
export interface EvidenceRef {
  id: string
  source: string
  kind: string
  /** hash del contenido evidenciado (provenance, doc 07 §2.3 #15) */
  hash?: string
  /** instante de verificación — sin él la evidencia NO cuenta como verificada */
  verifiedAt?: string
}"""
must(t.count(anchor) == 1, "bloque ToolExecutionOutput no único en contracts")
con.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("contracts.ts OK (EvidenceRef)")

# ---------- 2) pipeline.ts: gate en executeCommand (tras handler, antes de publicar) ----------
pipe = Path("src/lib/eec/commands/pipeline.ts")
t = pipe.read_text(encoding="utf-8")

anchor = "import { getCommandSchema, isKnownCommand } from './registry'"
repl = "import { getCommandSchema, isKnownCommand } from './registry'\nimport { evaluateEvidenceGate } from '../security/evidence'"
must(t.count(anchor) == 1, "import de registry no único en pipeline")
t = t.replace(anchor, repl, 1)

anchor = """    const result = await handler({ payload, commandId, requesterId, requesterType, sim, traceId: cmdRow?.traceId ?? null })
    await db.commandRecord.update({
      where: { id: commandId },
      data: { status: 'EXECUTED', resultJson: JSON.stringify(result ?? {}), executedAt: new Date(), sim },
    })"""
repl = """    const result = await handler({ payload, commandId, requesterId, requesterType, sim, traceId: cmdRow?.traceId ?? null })
    // P0-2 (doc 07 §3.2): Evidence Gate fail-closed — una salida exigente sin
    // evidencia verificada NO se marca ejecutada NI se publica en el bus.
    const gate = await evaluateEvidenceGate(type, result)
    if (gate.required && !gate.ok) {
      await db.commandRecord.update({
        where: { id: commandId },
        data: {
          status: 'BLOCKED_MISSING_EVIDENCE',
          rejectionReason: `evidence_gate:${gate.policy}:${gate.missing.join(',')}`.slice(0, 500),
          resultJson: JSON.stringify(result ?? {}),
          executedAt: new Date(),
          sim,
        },
      })
      await eventBus.publish({
        event_type: 'evidence.missing', source: 'eec.pipeline', subject: `command:${commandId}`,
        payload: { commandType: type, policy: gate.policy, missing: gate.missing, requesterId }, sim,
      })
      await writeAudit({
        actorId: 'eec:pipeline', actorType: 'COMMAND_PIPELINE', action: 'command.evidence.blocked',
        entityType: 'COMMAND', entityId: commandId, result: 'BLOCKED_MISSING_EVIDENCE',
        why: `evidence_gate:${gate.policy}: ${gate.missing.join(',')}`,
        output: { claimTags: (result as { claimTags?: unknown })?.claimTags ?? [] },
      })
      await recordMetric('eec.evidence.blocked', 1, { type })
      return { commandId, status: 'BLOCKED_MISSING_EVIDENCE', ok: false, error: 'missing_verified_evidence', result, traceId: cmdRow?.traceId ?? undefined }
    }
    await db.commandRecord.update({
      where: { id: commandId },
      data: { status: 'EXECUTED', resultJson: JSON.stringify(result ?? {}), executedAt: new Date(), sim },
    })"""
must(t.count(anchor) == 1, "bloque post-handler no único en pipeline")
pipe.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("pipeline.ts OK (Evidence Gate)")

# ---------- 3) schema.prisma: comentario de estados del CommandRecord ----------
schema = Path("prisma/schema.prisma")
t = schema.read_text(encoding="utf-8")
anchor = "  // RECEIVED|VALIDATED|AUTHORIZED|POLICY_CHECKED|DISPATCHED|EXECUTED|REJECTED|FAILED|DUPLICATE"
repl = "  // RECEIVED|VALIDATED|AUTHORIZED|POLICY_CHECKED|DISPATCHED|EXECUTED|REJECTED|FAILED|DUPLICATE|BLOCKED_MISSING_EVIDENCE"
must(t.count(anchor) == 1, "comentario de estados no único")
schema.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("schema.prisma OK (comentario)")
print("PATCH P0-2 COMPLETO")
