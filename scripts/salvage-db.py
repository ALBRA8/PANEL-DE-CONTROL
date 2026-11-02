#!/usr/bin/env python3
"""Rescate de datos del db/custom.db corrupto (2ª corrupción por snapshot-tearing).

Estrategia: leer tabla por tabla tolerando fallos por bloques de rowid,
escribir en un DB nuevo limpio (journal_mode=DELETE, receta recover-db-v2).
Las tablas ilegibles se reportan honestamente (no se inventan datos).
"""
import sqlite3
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "db/custom.db")
DST = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/db-salvo.db")
DST.unlink(missing_ok=True)
DSTW = Path(str(DST) + "-wal"); DSTW.unlink(missing_ok=True)
DSTS = Path(str(DST) + "-shm"); DSTS.unlink(missing_ok=True)

src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
dst = sqlite3.connect(DST)
dst.execute("PRAGMA journal_mode=DELETE")
dst.execute("PRAGMA synchronous=FULL")

# 1) esquema: copiar CREATE TABLE/INDEX legibles desde sqlite_master
master = src.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
).fetchall()
created, failed_schema = [], []
for typ, name, sql in master:
    if typ not in ("table", "index"):
        continue
    try:
        dst.execute(sql)
        if typ == "table":
            created.append(name)
    except Exception as e:
        failed_schema.append((name, str(e)[:80]))
dst.commit()

# 2) datos: por tabla, en bloques de rowid (una página rota no mata la tabla entera)
report = {}
BATCH = 500
for table in created:
    total, errors = 0, 0
    try:
        cols = [r[1] for r in src.execute(f'PRAGMA table_info("{table}")').fetchall()]
        if not cols:
            report[table] = "ILEGIBLE:pragma"
            continue
        collist = ", ".join(f'"{c}"' for c in cols)
        ph = ", ".join("?" * len(cols))
        lo = 0
        while True:
            chunk = None
            try:
                chunk = src.execute(
                    f'SELECT rowid, {collist} FROM "{table}" WHERE rowid > ? ORDER BY rowid LIMIT ?',
                    (lo, BATCH),
                ).fetchall()
            except Exception:
                # reintenta fila a fila dentro del bloque (salva lo salvable)
                try:
                    rows_in = src.execute(
                        f'SELECT rowid FROM "{table}" WHERE rowid > ? ORDER BY rowid LIMIT ?',
                        (lo, BATCH),
                    ).fetchall()
                except Exception:
                    errors += 1
                    break
                chunk = []
                for (rid,) in rows_in:
                    try:
                        chunk.append(src.execute(
                            f'SELECT rowid, {collist} FROM "{table}" WHERE rowid = ?', (rid,)
                        ).fetchone())
                    except Exception:
                        errors += 1
            if not chunk:
                break
            for row in chunk:
                rid, *vals = row
                try:
                    dst.execute(
                        f'INSERT OR REPLACE INTO "{table}" (rowid, {collist}) VALUES (?, {ph})',
                        [rid] + vals,
                    )
                    total += 1
                except Exception:
                    errors += 1
            lo = chunk[-1][0]
    except Exception as e:
        report[table] = f"ERROR:{type(e).__name__}:{str(e)[:60]}"
        continue
    report[table] = f"{total} filas" + (f" ({errors} errores/ilegibles)" if errors else "")

dst.commit()
ic = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close(); src.close()

print("== REPORTE DE RESCATE ==")
for k, v in sorted(report.items()):
    print(f"  {k}: {v}")
if failed_schema:
    print("esquema no recreado:", failed_schema)
print(f"integridad del destino: {ic}")
print(f"destino: {DST}")
