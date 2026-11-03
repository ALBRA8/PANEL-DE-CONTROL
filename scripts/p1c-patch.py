#!/usr/bin/env python3
"""P1-3 (doc 07 §3.5): revisión adversarial pre-dispatch — parchea
pipeline.ts y workers.ts (TRACKED) sobre la rama feature/v2-adaptacion-
verticales. El módulo adversarial.ts y el test se escriben aparte.
Falla ruidosamente si un ancla no es única — nunca edita a ciegas."""
from pathlib import Path
import sys

def must(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

def patch(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    t = p.read_text(encoding="utf-8")
    must(t.count(old) == 1, f"{path}: ancla no única ({label}): {t.count(old)}")
    p.write_text(t.replace(old, new, 1), encoding="utf-8")
    print(f"{path} OK ({label})", flush=True)

P = "src/lib/eec/commands/pipeline.ts"
W = "src/lib/eec/engine/workers.ts"

# ---------- 1) pipeline.ts: import ----------
patch(P,
      "import { evaluateEvidenceGate } from '../security/evidence'",
      "import { evaluateEvidenceGate } from '../security/evidence'\nimport { reviewAdversarial } from '../security/adversarial'",
      "import adversarial")

# ---------- 2) pipeline.ts: revisión adversarial antes del gate de aprobación ----------
OLD = """      const needsApproval = !input.skipApprovalOnce && requesterType !== 'SYSTEM' &&
        (forcedApproval !== undefined || (requiresApproval(effectiveRisk) && requesterType !== 'HUMAN'))"""
NEW = """      // ---------- P1-3 (doc 07 §3.5): REVISIÓN ADVERSARIAL PRE-DISPATCH ----------
      // Órgano de control determinístico: BLOCK → rechaza; REVIEW → segunda
      // mirada (gate humano para agentes; evento observable para humanos,
      // cuya autoridad implícita no se bloquea a sí misma).
      const adversarial = await reviewAdversarial(input.type, payload, requesterType)
      if (adversarial.decision === 'BLOCK') {
        const rules = adversarial.findings.map(f => f.rule).join(',')
        await eventBus.publish({
          event_type: 'adversarial.blocked', source: 'eec.pipeline', subject: `command:${cmd.id}`,
          payload: { commandType: input.type, requesterId, requesterType, score: adversarial.score, findings: adversarial.findings }, sim,
        })
        await writeAudit({
          actorId: 'eec:pipeline', actorType: 'COMMAND_PIPELINE', action: 'command.adversarial.blocked',
          entityType: 'COMMAND', entityId: cmd.id, input: payload, result: 'BLOCKED_ADVERSARIAL',
          why: `adversarial:score=${adversarial.score}:${rules}`, sim,
        })
        await recordMetric('eec.adversarial.blocked', 1, { type: input.type })
        return reject(cmd.id, `adversarial_blocked:score=${adversarial.score}:${rules}`, cmd, true)
      }
      if (adversarial.decision === 'REVIEW') {
        await eventBus.publish({
          event_type: 'adversarial.review', source: 'eec.pipeline', subject: `command:${cmd.id}`,
          payload: { commandType: input.type, requesterId, requesterType, score: adversarial.score, findings: adversarial.findings }, sim,
        })
        await recordMetric('eec.adversarial.review', 1, { type: input.type })
      }
      const needsApproval = !input.skipApprovalOnce && requesterType !== 'SYSTEM' &&
        (forcedApproval !== undefined || (adversarial.decision === 'REVIEW' && requesterType === 'AGENT') ||
          (requiresApproval(effectiveRisk) && requesterType !== 'HUMAN'))"""
patch(P, OLD, NEW, "revisión adversarial en dispatch")

# ---------- 3) workers.ts: reglas de notificación ----------
patch(W,
      "    'approval.deadline_near': { severity: 'WARNING', title: p => `Aprobación por expirar: ${String(p.title ?? p.approvalId)}` },",
      """    'approval.deadline_near': { severity: 'WARNING', title: p => `Aprobación por expirar: ${String(p.title ?? p.approvalId)}` },
    'adversarial.blocked': { severity: 'ERROR', title: p => `Órgano de control BLOQUEÓ ${String(p.commandType)} (score ${String(p.score)})` },
    'adversarial.review': { severity: 'WARNING', title: p => `Órgano de control pide revisión: ${String(p.commandType)} (score ${String(p.score)})` },""",
      "RULES adversarial")

# ---------- verificación final ----------
t = Path(P).read_text(encoding="utf-8")
must(t.count("reviewAdversarial") == 2, f"pipeline: reviewAdversarial apariciones {t.count('reviewAdversarial')} != 2")
must("adversarial.blocked" in t and "adversarial.review" in t, "pipeline: eventos adversariales ausentes")
t2 = Path(W).read_text(encoding="utf-8")
must("adversarial.blocked" in t2, "workers: regla de notificación ausente")
print("P1-3 patch: TODO OK", flush=True)
