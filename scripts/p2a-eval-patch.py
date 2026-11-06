#!/usr/bin/env python3
# ============================================================
# P2-1 eval harness — parche a archivos EXISTENTES de la rama:
# registry (schema zod), domain/types (COMMAND_RISK), commands/index.
# Anclas exactas, fail-loud, autoverificación final.
# ============================================================
import pathlib

ROOT = pathlib.Path('/home/z/my-project')
changed = []

def patch(rel, old, new, label):
    p = ROOT / rel
    txt = p.read_text(encoding='utf-8')
    n = txt.count(old)
    assert n == 1, f"[{label}] ancla aparece {n} veces (esperado 1) en {rel}"
    assert new not in txt, f"[{label}] resultado ya aplicado en {rel}"
    p.write_text(txt.replace(old, new), encoding='utf-8')
    changed.append((label, rel))

EVAL_SCHEMA = """  // ---- eval harness (P2-1 · matriz #13) ----
  'eval.run': z.object({
    label: z.string().min(2).max(80).optional(),
    rubric: z.object({
      name: z.string().min(2).max(80),
      description: z.string().optional(),
      essential: z.array(z.object({ id: z.string().min(1), description: z.string().min(1), pattern: z.string().min(1) })).default([]),
      forbidden: z.array(z.object({ id: z.string().min(1), description: z.string().min(1), pattern: z.string().min(1) })).default([]),
      bonus: z.array(z.object({ id: z.string().min(1), description: z.string().min(1), pattern: z.string().min(1), points: z.number().positive() })).default([]),
    }),
    output: z.object({ text: z.string().max(200_000) }),
  }),

"""
patch('src/lib/eec/commands/registry.ts',
      '  // ---- tareas ----',
      EVAL_SCHEMA + '  // ---- tareas ----',
      'registry: schema eval.run')

patch('src/lib/eec/domain/types.ts',
      "  'org.create': 'MEDIUM', 'org.flag.set': 'LOW', 'org.flag.unset': 'LOW',",
      "  'org.create': 'MEDIUM', 'org.flag.set': 'LOW', 'org.flag.unset': 'LOW',\n  'eval.run': 'LOW',",
      'types: COMMAND_RISK eval.run')

patch('src/lib/eec/commands/index.ts',
      "import { registerOrgAdminHandlers } from './handlers/org-admin-handlers'",
      "import { registerOrgAdminHandlers } from './handlers/org-admin-handlers'\n"
      "import { registerEvalHandlers } from './handlers/eval-handlers'",
      'index: import eval-handlers')

patch('src/lib/eec/commands/index.ts',
      '  registerOrgAdminHandlers()\n',
      '  registerOrgAdminHandlers()\n  registerEvalHandlers()\n',
      'index: register eval-handlers')

for rel, needles in [
    ('src/lib/eec/commands/registry.ts', ["'eval.run': z.object("]),
    ('src/lib/eec/domain/types.ts', ["'eval.run': 'LOW'"]),
    ('src/lib/eec/commands/index.ts', ['registerEvalHandlers()']),
]:
    txt = (ROOT / rel).read_text(encoding='utf-8')
    for nd in needles:
        assert nd in txt, f'postcheck: falta {nd!r} en {rel}'

print('OK parches P2-1 aplicados:')
for label, rel in changed:
    print(f'  - {label} → {rel}')
