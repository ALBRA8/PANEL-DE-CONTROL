#!/usr/bin/env node
/**
 * ALBRA Panel — entrypoint de servicio Windows (payload del MSI).
 *
 * El servicio WinSW (albra-panel.xml del MSI) ejecuta `node boot.js` con
 * este archivo como working directory (payload/panel del MSI). Responsabilidades:
 *
 *   1. Resolver ALBRA_HOME (%ProgramData%\ALBRA por defecto), sanitizando
 *      el caso en que WinSW no expandiera la variable.
 *   2. Garantizar %ALBRA_HOME%\db\ y la BD del panel: si no existe, se
 *      inicializa copiando data/template.db (schema completo generado en
 *      CI con `prisma db push` — el standalone no lleva la CLI de Prisma).
 *   3. Construir DATABASE_URL (Prisma SQLite) con separador '/', válido
 *      en Windows y POSIX, ANTES de que server.js instancie el cliente.
 *   4. Levantar el servidor standalone (server.js).
 *
 * Fail-closed: sin BD ni template → exit(1) con mensaje claro (el servicio
 * reinicia y el log de WinSW lo muestra; nada silencioso).
 *
 * NUNCA poner secretos aquí: EEC_OPERATOR_PASSWORD y EEC_API_TOKEN se
 * configuran en el primer arranque del operador, nunca en el instalador.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function resolveAlbraHome() {
  let home = process.env.ALBRA_HOME || '';
  if (/%ProgramData%/i.test(home)) {
    home = home.replace(/%ProgramData%/i, process.env.ProgramData || 'C:\\ProgramData');
  }
  if (!home.trim()) {
    home = path.join(process.env.ProgramData || 'C:\\ProgramData', 'ALBRA');
  }
  return home;
}

function ensureDatabase() {
  const dbFileName = process.env.ALBRA_DB_NAME || 'panel.db';
  const dbDir = path.join(resolveAlbraHome(), 'db');
  const dbPath = path.join(dbDir, dbFileName);
  const template = path.join(__dirname, 'data', 'template.db');

  fs.mkdirSync(dbDir, { recursive: true });

  if (!fs.existsSync(dbPath)) {
    if (!fs.existsSync(template)) {
      console.error(`[boot] BD ausente y sin template: ${dbPath} (template: ${template})`);
      process.exit(1);
    }
    fs.copyFileSync(template, dbPath);
    console.log(`[boot] BD inicializada desde template: ${dbPath}`);
  }

  process.env.DATABASE_URL = 'file:' + dbPath.replace(/\\/g, '/');
  console.log(`[boot] DATABASE_URL=${process.env.DATABASE_URL}`);
}

ensureDatabase();
require('./server.js');
