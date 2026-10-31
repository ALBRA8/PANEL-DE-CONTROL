/**
 * Recuperación v2 — corrige el fallo de la v1:
 *  v1 dejó la BD destino en WAL y NO hizo checkpoint antes del rename →
 *  los datos quedaron en custom-recovered.db-wal y el main quedó incompleto.
 *  v2: journal_mode = DELETE (todo va directo al archivo principal, nada en WAL),
 *      verificación de conteos con conexión nueva ANTES de reemplazar,
 *      escaneo por rangos fijos para tablas cuyo MIN/MAX falla (corrupción).
 *
 * Fuente: respaldo intacto del archivo corrupto original.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, copyFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = "/home/z/my-project/db";
const BACKUP = `${ROOT}/backup-corrupt-2026-10-31T16-00-32/custom.db`;
const WORK = `${ROOT}/recover-work`;
const FINAL = `${ROOT}/custom.db`;

if (!existsSync(BACKUP)) {
  console.error("No existe el respaldo original:", BACKUP);
  process.exit(1);
}

// 0) Zona de trabajo limpia
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
copyFileSync(BACKUP, `${WORK}/source.db`);
for (const s of ["-wal", "-shm"]) {
  const b = BACKUP + s;
  if (existsSync(b)) copyFileSync(b, `${WORK}/source.db${s}`);
}
console.log("[0] Respaldo copiado a zona de trabajo");

// 1) Reparación de esquema (writable_schema) con Python — aislado por sentencia
execSync(`python3 /home/z/my-project/scripts/repair-schema-row.py ${WORK}/source.db`, {
  stdio: "inherit",
});

// 2) Abrir fuente reparada
const src = new Database(`${WORK}/source.db`);
try { src.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
console.log("[2] Fuente abierta");

// 3) Leer DDL con bisección por rowid como respaldo
type Obj = { type: string; name: string; tbl_name: string; sql: string };
function readObjects(): Obj[] {
  try {
    return src
      .query<Obj, []>(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`
      )
      .all();
  } catch {
    const out: Obj[] = [];
    const grab = (a: number, b: number) => {
      try {
        const rows = src
          .query<Obj, [number, number]>(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND rowid BETWEEN ? AND ?`
          )
          .all(a, b);
        for (const r of rows) if (!out.some((o) => o.name === r.name)) out.push(r);
      } catch {
        if (a >= b) return;
        const mid = Math.floor((a + b) / 2);
        grab(a, mid);
        grab(mid + 1, b);
      }
    };
    grab(1, 2000);
    return out;
  }
}
const objects = readObjects();
const tables = objects.filter((o) => o.type === "table");
console.log(`[3] DDL: ${tables.length} tablas, ${objects.length - tables.length} índices`);

// 4) Destino en modo DELETE (sin WAL) — nada se pierde fuera del main
const DEST = `${WORK}/recovered.db`;
rmSync(DEST, { force: true });
for (const s of ["-wal", "-shm", "-journal"]) rmSync(DEST + s, { force: true });
const dst = new Database(DEST);
dst.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF; PRAGMA synchronous = OFF;");
for (const t of tables) {
  try { dst.exec(t.sql + ";"); } catch (e) { console.error(`  DDL ${t.name}: ${(e as Error).message}`); }
}
for (const o of objects.filter((x) => x.type !== "table")) {
  try { dst.exec(o.sql + ";"); } catch {}
}

// 5) Copia: rangos fijos 1..20000 por 200 con bisección; usa MIN/MAX solo si funciona
const copied: Record<string, number> = {};
for (const t of tables) {
  let n = 0;
  let a = 1;
  let b = 20000;
  try {
    const bounds = src
      .query(`SELECT COALESCE(MIN(rowid),1) a, COALESCE(MAX(rowid),0) b FROM "${t.name}"`)
      .get() as { a: number; b: number };
    if (bounds.b > 0) { a = bounds.a; b = bounds.b; }
  } catch { /* bounds falla → rango fijo */ }

  const ins = (row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    dst
      .query(
        `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
      )
      .run(...cols.map((c) => row[c]));
    n++;
  };
  const W = 200;
  for (let x = a; x <= b; x += W) {
    const y = Math.min(x + W - 1, b);
    try {
      const rows = src
        .query(`SELECT * FROM "${t.name}" WHERE rowid BETWEEN ? AND ?`)
        .all(x, y) as Record<string, unknown>[];
      dst.exec("BEGIN");
      for (const r of rows) { try { ins(r); } catch {} }
      dst.exec("COMMIT");
    } catch {
      const bisect = (p: number, q: number) => {
        if (p === q) {
          try {
            const r = src.query(`SELECT * FROM "${t.name}" WHERE rowid = ?`).get(p) as
              | Record<string, unknown>
              | null;
            if (r) { dst.exec("BEGIN"); try { ins(r); } catch {} dst.exec("COMMIT"); }
          } catch {}
          return;
        }
        const mid = Math.floor((p + q) / 2);
        bisect(p, mid);
        bisect(mid + 1, q);
      };
      bisect(x, y);
    }
  }
  copied[t.name] = n;
}
src.close();

// 6) Cierre explícito + verificación con CONEXIÓN NUEVA (lee solo el main)
dst.exec("PRAGMA journal_mode = DELETE;");
dst.close();
const chk = new Database(DEST, { readonly: true });
const ic = chk.query("PRAGMA integrity_check").all() as { integrity_check?: string }[];
const okIc = ic.length === 1 && ic[0].integrity_check === "ok";
console.log("[6] Conteos verificados desde conexión nueva (solo archivo principal):");
for (const t of ["Organization", "Project", "Task", "Notification", "Session", "Agent", "Department", "Approval", "Provider", "AgentRuntime", "Run", "Meeting", "Schedule", "Metric", "AuditRecord"]) {
  try {
    const c = chk.query(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number };
    console.log(`    ${t}: ${c.c}`);
  } catch (e) { console.log(`    ${t}: ERROR ${(e as Error).message}`); }
}
chk.close();

if (!okIc) {
  console.error("[!] integrity_check falló — NO se reemplaza la BD");
  process.exit(1);
}

// 7) Reemplazo seguro: borrar destino viejo Y sus wal/shm
for (const s of ["", "-wal", "-shm"]) {
  const p = FINAL + s;
  if (existsSync(p)) rmSync(p);
}
copyFileSync(DEST, FINAL); // copy en vez de rename: el work queda como respaldo
console.log("[7] OK — db/custom.db reemplazada (modo DELETE, sin WAL pendiente)");
