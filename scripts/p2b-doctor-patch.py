#!/usr/bin/env python3
# ============================================================
# P2-2 doctor del sistema — parche a ops-view.tsx (import + render).
# Anclas exactas, fail-loud, autoverificación final.
# ============================================================
import pathlib

ROOT = pathlib.Path('/home/z/my-project')
REL = 'src/components/eec/ops-view.tsx'
p = ROOT / REL
txt = p.read_text(encoding='utf-8')

old_imp = "import { OrgAdminPanel } from '@/components/eec/org-admin-panel'"
new_imp = old_imp + "\nimport { DoctorPanel } from '@/components/eec/doctor-panel'"
assert txt.count(old_imp) == 1, 'ancla import OrgAdminPanel no única'
assert new_imp not in txt, 'import DoctorPanel ya aplicado'
txt = txt.replace(old_imp, new_imp)

old_render = '      <OrgAdminPanel />\n'
new_render = '      <OrgAdminPanel />\n      <DoctorPanel />\n'
assert txt.count(old_render) == 1, 'ancla render OrgAdminPanel no única'
assert new_render not in txt, 'render DoctorPanel ya aplicado'
txt = txt.replace(old_render, new_render)

p.write_text(txt, encoding='utf-8')
assert '<DoctorPanel />' in p.read_text(encoding='utf-8')

print('OK parche P2-2 aplicado: ops-view (import + render DoctorPanel)')
