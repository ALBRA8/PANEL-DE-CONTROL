#!/usr/bin/env python3
"""Parche P3 (fase 1): cablea el observatorio y el piloto V2.
Anclas fail-loud: si un ancla no existe exactamente una vez, aborta sin escribir."""
import io, sys

def patch(path, edits):
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    for old, new in edits:
        n = src.count(old)
        if n != 1:
            sys.exit(f"ANCLA FAIL ({path}): {n} coincidencias para: {old[:70]!r}")
        src = src.replace(old, new)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f"OK {path}: {len(edits)} ancla(s)")

# 1) package.json: script pilot:v2
patch('package.json', [(
    '    "pilot": "bun scripts/pilot-e2e.ts"',
    '    "pilot": "bun scripts/pilot-e2e.ts",\n    "pilot:v2": "bun scripts/pilot-e2e-v2.ts"',
)])

# 2) ops-view.tsx: importar y renderizar el Observatorio (primero, sala de situación)
patch('src/components/eec/ops-view.tsx', [
    (
        "import { OrgAdminPanel } from '@/components/eec/org-admin-panel'",
        "import { OrgAdminPanel } from '@/components/eec/org-admin-panel'\nimport { ObservatoryPanel } from '@/components/eec/observatory-panel'",
    ),
    (
        '      <OrgAdminPanel />',
        '      <ObservatoryPanel />\n      <OrgAdminPanel />',
    ),
])

# 3) doc 07 §4.1: fila del observatorio + línea de pendientes
patch('docs/EEC-V2/07-ADAPTACION-DESPACHO-JURIDICO.md', [(
    '| P2-3 provenance de evidencia (#15) | ✅ implementado | `security/evidence.ts` criterio estricto (hash 64-hex, verifiedAt parseable y no futuro) + `attestEvidence`/`provenanceStatus`/`provenanceReport` + resumen en la decisión del gate; tests `p2-provenance.test.ts` |',
    '| P2-3 provenance de evidencia (#15) | ✅ implementado | `security/evidence.ts` criterio estricto (hash 64-hex, verifiedAt parseable y no futuro) + `attestEvidence`/`provenanceStatus`/`provenanceReport` + resumen en la decisión del gate; tests `p2-provenance.test.ts` |\n'
    '| P3 observatorio consolidado (§27) | ✅ implementado | `engine/observatory.ts` snapshot único de la sala de situación (doctor 10 checks + cadena hash + contadores adversarial/eval + SLA + dead-letters + eventos 24h + flags y usage por org) + `/api/eec/observatory` + panel en Sistema; tests `p3-observatory.test.ts` |',
)])

print("FASE 1 COMPLETA")
