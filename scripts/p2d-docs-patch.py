#!/usr/bin/env python3
# ============================================================
# Cierre documental del sprint (doc 07 §4.1):
#  - Apéndices V2 en docs 02 (EvidenceRef+Handoff), 04 (AuditChain+
#    quórum+adversarial+flags), 05 (casos adversariales+eval), 06
#    (estado P0-P3)
#  - doc 07 §4.1: filas P2-1/P2-2/P2-3 ✅ + frase de pendientes
# Anclas exactas, fail-loud, idempotente (rechaza doble aplicación).
# ============================================================
import pathlib, re

ROOT = pathlib.Path('/home/z/my-project')
D = 'docs/EEC-V2'
changed = []

def append_doc(rel, header, body):
    p = ROOT / rel
    assert p.exists(), f'{rel} no existe'
    txt = p.read_text(encoding='utf-8')
    assert header not in txt, f'{rel}: apéndice ya aplicado'
    sep = '' if txt.endswith('\n') else '\n'
    p.write_text(txt + sep + '\n' + header + '\n' + body, encoding='utf-8')
    changed.append(rel)

append_doc(f'{D}/02-CONTRATO-AGENTES.md',
    '## Apéndice V2 — Contratos de evidencia y traspaso (doc 07 · sprint P0-P2)',
    """Todo comando cuyo resultado reclame afirmaciones exigentes viaja con `evidence?: EvidenceRef[]`:

- **`EvidenceRef`** = `{ id, source, kind, hash?, verifiedAt? }`. La evidencia solo cuenta como VERIFICADA con criterio estricto (P2-3): `hash` SHA-256 de 64 hex del contenido real (se produce con `attestEvidence`, nunca a mano), `verifiedAt` parseable y no futuro, `source` presente. La provenance decorativa no pasa el gate.
- **Claim-or-refuse (P0-2)**: si una política `EVIDENCE/REQUIRE` aplica y la salida no acredita el mínimo de evidencia verificada, la salida NO se publica ni la tarea se marca ejecutada (`BLOCKED_MISSING_EVIDENCE`), con motivo legible y resumen de provenance.
- **`HandoffEnvelope` (P1-1)**: sobre de traspaso entre agentes/unidades con dossier de evidencias VERIFICADAS, asuntos abiertos heredados y garantías declaradas. Fail-closed: dossier con evidencia fantasma no formaliza el traspaso; la recepción exige ACK explícito (entrega no es recepción).
""")

append_doc(f'{D}/04-SEGURIDAD.md',
    '## Apéndice V2 — Cadena hash de auditoría, quórum y órgano de control (doc 07 · sprint P0-P2)',
    """- **AuditChain (P0-1)**: cada `AuditRecord` se sella al crearlo con SHA-256 del payload canónico encadenado al sello previo (`chainSeq`, `prevHash`, `thisHash`; génesis = 64 ceros). Un único punto de creación (`writeAudit`) — nada entra a la escritura pública sin sello. Verificación incremental: `GET /api/eec/audit/chain`. La cadena prueba alteración posterior; no prueba verdad absoluta (mitigación futura: fingerprint externo periódico).
- **Quórum humano (P0-3)**: `minimumHumanSignoff` en `Approval` — N firmas HUMANAS DISTINTAS; duplicados rechazados; el comando no se reanuda sin quórum. Riesgo conocido: exige identidad real de usuarios (quórum 1 sigue siendo seguro hoy).
- **Órgano de control (P1-3)**: revisión adversarial pre-dispatch determinística — 7 reglas (inyección, salto de controles, suplantación, urgencia artificial, evidencia fantasma, destrucción sin motivo, destructiva explícita), score 0-100 y umbrales por política `ADVERSARIAL`; BLOCK rechaza, REVIEW fuerza quórum.
- **Delegación administrativa (P2-4)**: feature flags por organización con catálogo cerrado y override auditable (`org.flag.set/unset` sellados en la cadena); fail-closed ante flag desconocido o tipo incorrecto.
""")

append_doc(f'{D}/05-PILOTO-E2E.md',
    '## Apéndice V2 — Casos adversariales y eval en el piloto (doc 07 · sprint P2)',
    """Casos adversariales que el piloto E2E debe ejecutar antes de cada dispatch sensible (política `ADVERSARIAL`; motor: `security/adversarial.ts`):

| # | Caso | Señal esperada |
|---|---|---|
| A1 | Inyección de instrucciones en el input ("ignora las reglas previas…") | BLOCK (score ≥ umbral) |
| A2 | Salto de controles ("sin esperar aprobación…") | BLOCK |
| A3 | Suplantación de identidad ("como administrador del sistema…") | BLOCK |
| A4 | Urgencia artificial ("inmediatamente, no hay tiempo de revisar") | REVIEW → quórum |
| A5 | Evidencia fantasma (claim sin hash/verifiedAt) | BLOCK por Evidence Gate |
| A6 | Destrucción de registros sin motivo declarado | BLOCK |
| A7 | Acción destructiva explícita sin trail | REVIEW → quórum |

**Eval harness (P2-1)**: cada caso del piloto lleva rúbrica determinística (`essential` / `forbidden` / `bonus`, regex puro, sin LLM en el lazo de verificación) ejecutada con `eval.run` — el veredicto PASS/FAIL y el score quedan en la escritura pública (auditados y sellados). Un caso del piloto solo cuenta como superado si su rúbrica da PASS.
""")

append_doc(f'{D}/06-MATRIZ-CAPACIDADES.md',
    '## Apéndice V2 — Estado de implementación del sprint doc 07 (P0-P3)',
    """| Ítem (matriz doc 07) | Estado | Evidencia |
|---|---|---|
| P0-1 Cadena hash en `AuditRecord` | ✅ | `engine/audit-chain.ts` + `/api/eec/audit/chain` |
| P0-2 Evidence Gate fail-closed | ✅ | `security/evidence.ts` + gate en pipeline |
| P0-3 Quórum humano `minimumHumanSignoff` | ✅ | `signaturesJson` en `Approval` |
| P1-1 `HandoffEnvelope` | ✅ | modelo `Handoff` + `handoff.create/ack/reject` |
| P1-2 Motor SLA + triggers por evento | ✅ | worker `sla-monitor` + reglas `EVENT_TRIGGERED` |
| P1-3 Revisión adversarial pre-dispatch | ✅ | `security/adversarial.ts` (7 reglas, score) |
| P2-1 Eval harness con rúbricas | ✅ | `eval/rubrics.ts` + `eval.run` auditado |
| P2-2 Doctor del sistema | ✅ | `engine/doctor.ts` + `/api/eec/doctor` + panel Sistema |
| P2-3 Provenance de evidencia | ✅ | criterio estricto + `attestEvidence`/`provenanceStatus` |
| P2-4 Paquete administrativo (flags + usage por org) | ✅ | `engine/org-flags.ts` + `org.*` + `/api/eec/orgs` + panel |
| P3 (post-piloto): MCP runtime, marketplace | ⏳ | diseño esbozado en doc 07 §4 |
""")

# ---------- doc 07 §4.1: filas P2-1..P2-3 + frase final ----------
DOC = f'{D}/07-ADAPTACION-DESPACHO-JURIDICO.md'
p = ROOT / DOC
doc = p.read_text(encoding='utf-8')

anchor_row = '| P2-4 paquete administrativo (#21+#22) | ✅ implementado |'
assert doc.count(anchor_row) == 1, 'fila P2-4 no única en doc 07'
m = re.search(r'^' + re.escape(anchor_row) + r'[^\n]*\|\n', doc, re.M)
assert m, 'línea P2-4 no encontrada'
NEW_ROWS = (
    '| P2-1 eval harness con rúbricas (#13) | ✅ implementado | `eval/rubrics.ts` (essential/forbidden/bonus, regex determinístico sin LLM, score 0-100) + comando `eval.run` (PASS y FAIL auditados y sellados); tests `p2-eval.test.ts` |\n'
    '| P2-2 doctor del sistema (#26) | ✅ implementado | `engine/doctor.ts` — 10 verificaciones reales (quick_check, cadena hash, pragmas, aprobaciones estancadas, dead-letters, modo sim, frontera INSTALADOR, políticas de evidencia, org-admin) + `/api/eec/doctor` + panel en Sistema; solo lectura, nunca repara; tests `p2-doctor.test.ts` |\n'
    '| P2-3 provenance de evidencia (#15) | ✅ implementado | `security/evidence.ts` criterio estricto (hash 64-hex, verifiedAt parseable y no futuro) + `attestEvidence`/`provenanceStatus`/`provenanceReport` + resumen en la decisión del gate; tests `p2-provenance.test.ts` |\n'
)
doc = doc[:m.end()] + NEW_ROWS + doc[m.end():]

pend_old = 'P2-3 provenance de evidencia. **P2-4 paquete administrativo: ✅ implementado** (ver tabla).'
assert doc.count(pend_old) == 1, 'frase de pendientes (rev P2-4) no encontrada'
pend_new = ('**Sprint P0+P1+P2 completo: 12/12 ítems implementados y verificados** (P0-1..P2-4, ver tabla). '
            'Pendiente post-piloto: P3 (MCP runtime, marketplace) y mitigación de fingerprint externo de la cadena.')
doc = doc.replace(pend_old, pend_new)

p.write_text(doc, encoding='utf-8')
changed.append(DOC)

for rel, needles in [
    (f'{D}/02-CONTRATO-AGENTES.md', ['Contratos de evidencia y traspaso']),
    (f'{D}/04-SEGURIDAD.md', ['Cadena hash de auditoría, quórum y órgano de control']),
    (f'{D}/05-PILOTO-E2E.md', ['Casos adversariales y eval en el piloto']),
    (f'{D}/06-MATRIZ-CAPACIDADES.md', ['Estado de implementación del sprint doc 07']),
    (DOC, ['P2-1 eval harness con rúbricas (#13) | ✅ implementado', 'Sprint P0+P1+P2 completo: 12/12']),
]:
    txt = (ROOT / rel).read_text(encoding='utf-8')
    for nd in needles:
        assert nd in txt, f'postcheck: falta {nd!r} en {rel}'

print('OK parche documental aplicado:')
for c in changed:
    print(f'  - {c}')
