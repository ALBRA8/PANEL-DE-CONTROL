#!/usr/bin/env node
/**
 * Copia cross-platform del output standalone de Next.js.
 *
 * Reemplaza el `cp -r` POSIX que había en el script `build` (rompía en
 * cmd.exe de Windows — los runners de CI Windows no tienen coreutils).
 *
 * Copia (idempotente, limpia destino antes de copiar):
 *   .next/static  → .next/standalone/.next/static   (assets del cliente)
 *   public/       → .next/standalone/public          (si existe)
 *   boot.js       → .next/standalone/boot.js         (entrypoint de servicio MSI)
 *
 * Uso:  bun scripts/copy-standalone.js     (tras `next build`)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');

if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error(
    '[copy-standalone] falta .next/standalone/server.js — ejecuta antes `next build` (output: "standalone")'
  );
  process.exit(1);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const jobs = [
  { src: path.join(root, '.next', 'static'), dest: path.join(standalone, '.next', 'static'), required: true },
  { src: path.join(root, 'public'), dest: path.join(standalone, 'public'), required: false },
  { src: path.join(root, 'boot.js'), dest: path.join(standalone, 'boot.js'), required: false },
];

for (const job of jobs) {
  if (!fs.existsSync(job.src)) {
    if (job.required) {
      console.error(`[copy-standalone] falta origen obligatorio: ${job.src}`);
      process.exit(1);
    }
    console.log(`[copy-standalone] omitido (no existe): ${path.relative(root, job.src)}`);
    continue;
  }
  fs.rmSync(job.dest, { recursive: true, force: true });
  if (fs.statSync(job.src).isDirectory()) copyDir(job.src, job.dest);
  else fs.copyFileSync(job.src, job.dest);
  console.log(`[copy-standalone] ${path.relative(root, job.src)} -> ${path.relative(root, job.dest)}`);
}

console.log('[copy-standalone] OK');
