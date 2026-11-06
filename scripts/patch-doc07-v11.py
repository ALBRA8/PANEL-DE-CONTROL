#!/usr/bin/env python3
"""Rev 1.1 del doc 07: refuerzo del carácter administrativo del EEC.

Inserta:
  1) Línea de revisión en la cabecera (tras la línea 'Fuente analizada')
  2) Sección 0.1 — EEC como administración general (antes de '## 1. Método')
  3) Fila P2-4 (paquete administrativo) en la tabla de roadmap de §4
Falla ruidosamente si algún marcador no existe (no edita nada a ciegas).
"""
from pathlib import Path
import sys

DOC = Path("docs/EEC-V2/07-ADAPTACION-DESPACHO-JURIDICO.md")
text = DOC.read_text(encoding="utf-8")

REV_LINE = (
    "- **Rev 1.1 (2026-11-01)**: corrección de enfoque del propietario — EEC como "
    "**administración general** del ecosistema (§0.1); el paquete administrativo "
    "(feature flags + usage por organización) sube de post-piloto a P2."
)

SECTION_01 = """## 0.1 Rev 1.1 — Enfoque reforzado: el EEC es la ADMINISTRACIÓN GENERAL del ecosistema

Corrección de rumbo del propietario (2026-11-01): *"somos más administrativos; aquí vamos a organizar algo más grande"*. Esta matriz se relee con ese acento: el EEC no es solo el plano de control técnico — es su **administración general**: el back-office que organiza N organizaciones × M verticales × flotas de agentes, aplicando a las unidades del ecosistema las mismas funciones que una gerencia corporativa aplica a sus filiales.

| Función administrativa clásica | Expresión en el EEC | Ítems de esta matriz que la sirven |
|---|---|---|
| Registro de unidades organizativas (alta/baja de filiales) | `Organization` como raíz + onboarding de verticales vía INSTALADOR | #2, #21, #25 |
| Delegación con niveles de firma (poderes y quórum) | Pipeline de `Approval` + `minimumHumanSignoff` | #4 → P0-3 |
| Escritura pública y custodia de actas | `AuditRecord` con cadena hash SHA-256 (tamper-evident) | #5 → P0-1 |
| Expediente con evidencia verificada | Evidence Gate `claim-or-refuse` + provenance por hash | #3, #15 → P0-2, P2-3 |
| Control de plazos y SLA | Motor genérico de términos + `deadline_near` + escalamiento | #6, #17 → P1-2 |
| Presupuesto y control del gasto | Metering `ToolInvocation` + agregación de usage por organización | #22 → P2-4 |
| Órganos de control (revisión previa de actos críticos) | Revisión adversarial pre-dispatch como policy check | #11 → P1-3 |
| Gobierno del conocimiento (actas tentativas → aprobadas) | `KnowledgeItem` `tentative → confirmed` | #19 → P2 |
| Administración por unidad (configuración por filial) | Feature flags por organización | #21 → P2-4 |

Consecuencias prácticas sobre esta matriz:

1. **El orden P0 no cambia — se justifica mejor**: evidencia, auditoría y quórum no son "features de seguridad": son la **escritura pública** de la administración. Sin actas fiables no hay administración, y sin quórum no hay delegación real de poder.
2. **El paquete administrativo sube de "post-piloto" a P2 explícito (P2-4)**: feature flags por organización (#21) + agregación de usage/coste por organización (#22) son el mínimo para administrar *algo más grande* — varias organizaciones — y no solo una instancia. La tabla de §4 refleja el ascenso.
3. **Lo jurídico queda todavía más fuera**: el EEC no administra casos jurídicos; administra organizaciones que a su vez administran su dominio. Prueba del diseño: cada fila de la tabla anterior tiene sentido idéntico para un despacho, un contador o cualquier vertical futuro.
4. **Lectura del diagrama de §0**: el EEC administra verticales como una gerencia administra filiales — contrato, delegación, plazos, presupuesto, actas y auditoría; nunca opera su oficio.

"""

P2_4_ROW = (
    "| P2-4 | **Paquete administrativo**: feature flags por org (#21) + usage/coste por org (#22) "
    "| 6+ | alta de una segunda organización con flags propios y coste visible en Sistema |\n"
)

# --- 1) línea de revisión en cabecera ---
marker_fuente = "Fuente analizada:"
i = text.find(marker_fuente)
assert i != -1, "No se encontró la cabecera 'Fuente analizada'"
j = text.find("\n", i)
assert j != -1
text = text[: j + 1] + REV_LINE + "\n" + text[j + 1 :]

# --- 2) sección 0.1 antes de '## 1. Método' ---
marker_metodo = "## 1. Método"
assert text.count(marker_metodo) == 1, "Marcador '## 1. Método' no único"
text = text.replace(marker_metodo, SECTION_01 + marker_metodo, 1)

# --- 3) fila P2-4 tras la fila P2-3 en §4 ---
lines = text.splitlines(keepends=True)
out, inserted = [], False
for ln in lines:
    out.append(ln)
    if ln.startswith("| P2-3 |"):
        out.append(P2_4_ROW)
        inserted = True
assert inserted, "No se encontró la fila P2-3 en §4"
text = "".join(out)

DOC.write_text(text, encoding="utf-8")

# --- verificación ---
final = DOC.read_text(encoding="utf-8")
checks = {
    "rev_line": final.count("Rev 1.1 (2026-11-01)"),
    "section_01": final.count("## 0.1 Rev 1.1"),
    "p2_4_row": final.count("| P2-4 |"),
    "metodo_unico": final.count("## 1. Método"),
}
print("verificación:", checks)
ok = (
    checks["rev_line"] == 1
    and checks["section_01"] == 1
    and checks["p2_4_row"] == 1
    and checks["metodo_unico"] == 1
)
print("OK" if ok else "FALLO", flush=True)
sys.exit(0 if ok else 1)
