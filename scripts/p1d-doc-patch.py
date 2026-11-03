#!/usr/bin/env python3
"""P1-doc: registra el estado de implementación P0+P1 en el doc 07
(§4.1 junto al roadmap) sobre la rama feature/v2-adaptacion-verticales.
Falla ruidosamente si el ancla no es única."""
from pathlib import Path
import sys

def must(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

DOC = "docs/EEC-V2/07-ADAPTACION-DESPACHO-JURIDICO.md"
ANCHOR = "Enmiendas mínimas a documentos existentes:"

SECTION = """### 4.1 Estado de implementación (sprint P0+P1 completado)

| Ítem | Estado | Evidencia verificable |
|---|---|---|
| P0-1 cadena hash en `AuditRecord` | ✅ implementado | `engine/audit-chain.ts` (sello SHA-256 en `writeAudit`, verificación incremental) + endpoint `/api/eec/audit/chain`; commit `8728725`; tests `p0-chain.test.ts` |
| P0-2 Evidence Gate fail-closed | ✅ implementado | `security/evidence.ts` + gate en pipeline (`BLOCKED_MISSING_EVIDENCE`, anti-fantasma); commit `2d9c94c`; tests `p0-evidence.test.ts` |
| P0-3 quórum humano | ✅ implementado | `minimumHumanSignoff` + `signaturesJson` en `Approval` (N firmas HUMANAS distintas); commit `407a1b2`; tests `p0-quorum.test.ts` |
| P1-1 `HandoffEnvelope` (#24) | ✅ implementado | contrato en `domain/contracts.ts` + modelo `Handoff` + comandos `handoff.create/ack/reject` con dossier fail-closed y ACK del receptor; commit `3206028`; tests `p1-handoff.test.ts` |
| P1-2 motor SLA (#17) | ✅ implementado | worker `sla-monitor` (escalera WARNING→CRITICAL→OVERDUE con dedup persistente) + reglas `EVENT_TRIGGERED` en `Schedule` con plantillas `{{event.*}}` (on(deadline_near) crea tarea de escalamiento auditable); commit `c6b38c4`; tests `p1-sla.test.ts` |
| P1-3 revisión adversarial (#11) | ✅ implementado | `security/adversarial.ts` — 7 reglas determinísticas (inyección, salto de controles, suplantación, urgencia artificial, evidencia fantasma, destrucción sin motivo, destructiva explícita), score 0-100, umbrales por política `ADVERSARIAL`; BLOCK rechaza, REVIEW fuerza quórum humano en agentes; commit `28a8600`; tests `p1-adversarial.test.ts` |

Regresión completa P0+P1: **32/32 tests en verde** (`bun test tests/eec-v2/`). Pendiente para el
siguiente tramo: P2-1 eval harness con rúbricas, P2-2 doctor del sistema, P2-3 provenance de
evidencia y **P2-4 paquete administrativo** (feature flags por org + usage/coste por org).

"""

p = Path(DOC)
t = p.read_text(encoding="utf-8")
must(t.count(ANCHOR) == 1, f"ancla no única en {DOC}: {t.count(ANCHOR)}")
must("### 4.1 Estado de implementación" not in t, "§4.1 ya existe")
p.write_text(t.replace(ANCHOR, SECTION + ANCHOR, 1), encoding="utf-8")
t2 = p.read_text(encoding="utf-8")
must(t2.count("32/32 tests en verde") == 1, "sección no aplicada")
print(f"{DOC} OK (§4.1 estado P0+P1)", flush=True)
