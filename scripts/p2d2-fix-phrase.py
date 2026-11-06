#!/usr/bin/env python3
# Fix de redacción doc 07 §4.1: elimina el residuo incoherente
# "Pendiente para el siguiente tramo: P2-1 ..., P2-2 ..., " que quedó
# antes de la frase definitiva del sprint completo.
import pathlib, re

ROOT = pathlib.Path('/home/z/my-project')
REL = 'docs/EEC-V2/07-ADAPTACION-DESPACHO-JURIDICO.md'
p = ROOT / REL
doc = p.read_text(encoding='utf-8')

pat = re.compile(r'Pendiente para el\s*\n?siguiente tramo: P2-1 eval harness con rúbricas, P2-2 doctor del sistema, (\*\*Sprint P0\+P1\+P2 completo)')
doc2, n = pat.subn(r'\1', doc)
assert n == 1, f'patrón no encontrado (n={n})'
p.write_text(doc2, encoding='utf-8')

final = p.read_text(encoding='utf-8')
assert 'siguiente tramo: P2-1' not in final, 'residuo sigue presente'
assert final.count('Sprint P0+P1+P2 completo: 12/12') == 1
assert 'Pendiente post-piloto: P3' in final
print('OK frase corregida en', REL)
