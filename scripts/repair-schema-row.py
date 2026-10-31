#!/usr/bin/env python3
"""Repara sqlite_master: elimina filas de esquema corruptas (writable_schema)."""
import sys

path = sys.argv[1]
con = sqlite3_connect = __import__("sqlite3").connect(path)
con.execute("PRAGMA writable_schema=ON")
cur = con.execute("DELETE FROM sqlite_master WHERE tbl_name='ExecutionProcess'")
con.commit()
print(f"  esquema reparado ({cur.rowcount} filas eliminadas)")
con.execute("PRAGMA writable_schema=OFF")
con.close()
