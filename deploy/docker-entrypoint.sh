#!/usr/bin/env sh
set -eu

mkdir -p /app/data

if [ -z "${EEC_OPERATOR_PASSWORD:-}" ] || [ -z "${EEC_SESSION_SECRET:-}" ] || [ -z "${EEC_API_TOKEN:-}" ]; then
  echo "[ALBRA EEC] Faltan EEC_OPERATOR_PASSWORD, EEC_SESSION_SECRET o EEC_API_TOKEN." >&2
  exit 1
fi

echo "[ALBRA EEC] Aplicando esquema Prisma sobre la base persistente..."
bunx prisma db push --skip-generate

echo "[ALBRA EEC] Iniciando PANEL DE CONTROL en puerto ${PORT:-3000}..."
exec bun server.js
