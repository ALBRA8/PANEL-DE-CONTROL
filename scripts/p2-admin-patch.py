#!/usr/bin/env python3
# ============================================================
# P2-4 paquete administrativo — parche quirúrgico a archivos EXISTENTES
# de feature/v2-adaptacion-verticales (correr tras checkout de la rama).
# Anclas exactas, fail-loud: si un ancla no aparece EXACTAMENTE una vez,
# aborta sin escribir nada. Autoverificación al final.
# ============================================================
import re, sys, pathlib

ROOT = pathlib.Path('/home/z/my-project')
changed = []

def patch(rel, old, new, label):
    p = ROOT / rel
    txt = p.read_text(encoding='utf-8')
    n = txt.count(old)
    assert n == 1, f"[{label}] ancla aparece {n} veces (esperado 1) en {rel}"
    assert new not in txt, f"[{label}] el resultado ya está aplicado en {rel}"
    p.write_text(txt.replace(old, new), encoding='utf-8')
    changed.append((label, rel))

# ---------- 1. prisma/schema.prisma: modelo OrgFlag + relación ----------
SCHEMA_MODEL = """model OrgFlag {
  id        String       @id @default(cuid())
  orgId     String
  org       Organization @relation(fields: [orgId], references: [id])
  key       String
  valueJson String       @default("null")
  reason    String?
  setBy     String
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  @@unique([orgId, key])
}

"""
patch('prisma/schema.prisma',
      '// ============ PERMISOS / POLÍTICAS ============',
      SCHEMA_MODEL + '// ============ PERMISOS / POLÍTICAS ============',
      'schema: modelo OrgFlag')
patch('prisma/schema.prisma',
      '  projects   Project[]\n}',
      '  projects   Project[]\n  flags      OrgFlag[]\n}',
      'schema: relación Organization.flags')

# ---------- 2. domain/types.ts: riesgo de los comandos org.* ----------
patch('src/lib/eec/domain/types.ts',
      "  'handoff.create': 'MEDIUM', 'handoff.ack': 'LOW', 'handoff.reject': 'LOW',",
      "  'handoff.create': 'MEDIUM', 'handoff.ack': 'LOW', 'handoff.reject': 'LOW',\n"
      "  'org.create': 'MEDIUM', 'org.flag.set': 'LOW', 'org.flag.unset': 'LOW',",
      'types: COMMAND_RISK org.*')

# ---------- 3. commands/registry.ts: schemas zod org.* ----------
ORG_SCHEMAS = """export const COMMAND_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // ---- administración por organización (P2-4 · matriz #21/#22) ----
  'org.create': z.object({
    code: z.string().min(2).max(40),
    name: z.string().min(2),
    mission: z.string().optional(),
    /** flags iniciales del alta (validados contra catálogo cerrado en el handler). */
    flags: z.record(z.string(), z.unknown()).default({}),
  }),
  'org.flag.set': z.object({
    orgId: id.optional(), orgCode: z.string().optional(),
    key: z.string().min(1),
    value: z.unknown(),
    reason: z.string().max(300).optional(),
  }).refine(a => a.orgId || a.orgCode, 'orgId o orgCode requerido'),
  'org.flag.unset': z.object({
    orgId: id.optional(), orgCode: z.string().optional(),
    key: z.string().min(1),
    reason: z.string().max(300).optional(),
  }).refine(a => a.orgId || a.orgCode, 'orgId o orgCode requerido'),
"""
patch('src/lib/eec/commands/registry.ts',
      'export const COMMAND_SCHEMAS: Record<string, z.ZodTypeAny> = {\n',
      ORG_SCHEMAS + '\n',
      'registry: schemas org.*')

# ---------- 4. commands/index.ts: registro de handlers ----------
patch('src/lib/eec/commands/index.ts',
      "import { registerHandoffHandlers } from './handlers/handoff-handlers'",
      "import { registerHandoffHandlers } from './handlers/handoff-handlers'\n"
      "import { registerOrgAdminHandlers } from './handlers/org-admin-handlers'",
      'index: import org-admin')
patch('src/lib/eec/commands/index.ts',
      '  registerHandoffHandlers()\n',
      '  registerHandoffHandlers()\n  registerOrgAdminHandlers()\n',
      'index: register org-admin')

# ---------- 5. ops-view.tsx: panel de administración en Sistema ----------
patch('src/components/eec/ops-view.tsx',
      "import { Badge } from '@/components/ui/badge'",
      "import { Badge } from '@/components/ui/badge'\n"
      "import { OrgAdminPanel } from '@/components/eec/org-admin-panel'",
      'ops-view: import panel')
patch('src/components/eec/ops-view.tsx',
      'aria-label="Operación del sistema">\n',
      'aria-label="Operación del sistema">\n      <OrgAdminPanel />\n',
      'ops-view: render panel')

# ---------- 6. doc 07 §4.1: estado P2-4 ----------
DOC = 'docs/EEC-V2/07-ADAPTACION-DESPACHO-JURIDICO.md'
doc_p = ROOT / DOC
doc = doc_p.read_text(encoding='utf-8')

# 6a. fila nueva en la tabla de estado, tras la fila P1-3
m = re.search(r'^\| P1-3 revisión adversarial \(#11\) \| ✅ implementado \|[^\n]*\|\n', doc, re.M)
assert m, 'doc: no se encontró la fila P1-3'
P2_ROW = ("| P2-4 paquete administrativo (#21+#22) | ✅ implementado | "
          "`engine/org-flags.ts` (catálogo cerrado de 7 flags, override fail-closed) + `usage/coste por org` "
          "(atribución ToolInvocation→Task→Project→Organization, CENTRAL para lo no atribuido) + comandos "
          "`org.create/org.flag.set/org.flag.unset` (auditados y sellados en la cadena) + `/api/eec/orgs` + panel en Sistema + "
          "alta de segunda organización (`scripts/eec-org2-seed.ts`); tests `p2-admin.test.ts` |\n")
doc = doc[:m.end()] + P2_ROW + doc[m.end():]

# 6b. frase de pendientes: P2-4 ya no está pendiente
doc2, nsub = re.subn(
    r'P2-3 provenance de\s*\nevidencia y \*\*P2-4 paquete administrativo\*\* \(feature flags por org \+ usage/coste por org\)\.',
    'P2-3 provenance de evidencia. **P2-4 paquete administrativo: ✅ implementado** (ver tabla).',
    doc)
assert nsub == 1, f'doc: frase de pendientes no encontrada (subs={nsub})'
doc_p.write_text(doc2, encoding='utf-8')
changed.append(('doc07 §4.1: fila P2-4 + pendientes', DOC))

# ---------- autoverificación ----------
marks = [
    ('prisma/schema.prisma', ['model OrgFlag', 'flags      OrgFlag[]']),
    ('src/lib/eec/domain/types.ts', ["'org.create': 'MEDIUM'"]),
    ('src/lib/eec/commands/registry.ts', ["'org.create': z.object(", "'org.flag.unset': z.object("]),
    ('src/lib/eec/commands/index.ts', ['registerOrgAdminHandlers()']),
    ('src/components/eec/ops-view.tsx', ['<OrgAdminPanel />']),
    (DOC, ['P2-4 paquete administrativo (#21+#22) | ✅ implementado', 'P2-4 paquete administrativo: ✅ implementado']),
]
for rel, needles in marks:
    txt = (ROOT / rel).read_text(encoding='utf-8')
    for nd in needles:
        assert nd in txt, f'postcheck: falta {nd!r} en {rel}'

print('OK parches aplicados:')
for label, rel in changed:
    print(f'  - {label} → {rel}')
