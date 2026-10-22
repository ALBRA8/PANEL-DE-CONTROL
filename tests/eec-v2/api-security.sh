#!/bin/bash
# ============================================================
# EEC V2 — SUITE DE SEGURIDAD HTTP (§6, §10 del mandato)
# bash tests/eec-v2/api-security.sh
# Arranca el servidor, prueba la frontera de autenticación y la
# suprime al final. Requiere .env con EEC_OPERATOR_PASSWORD.
# ============================================================
set -u
cd "$(dirname "$0")/../.."

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1${2:+ — $2}"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1${2:+ — $2}"; }
check(){ if [ "$1" = "$2" ]; then ok "$3" "${4:-}"; else bad "$3" "esperado=$1 obtenido=$2 ${4:-}"; fi; }

BASE="http://localhost:3000"
COOKIE_JAR=$(mktemp)
DEV_PASSWORD="${EEC_OPERATOR_PASSWORD:-eec-operator-2026}"
DEV_TOKEN="${EEC_API_TOKEN:-eec-service-token-dev-2026}"

echo "=== SUITE DE SEGURIDAD HTTP — EEC V2 ==="

# ---------- arranque del servidor ----------
pkill -f "next dev" 2>/dev/null; sleep 1
nohup bun run dev > /dev/null 2>&1 &
SERVER_PID=$!
echo "→ esperando servidor…"
READY=0
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/" --max-time 5 2>/dev/null)
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then echo "❌ servidor no arrancó"; kill $SERVER_PID 2>/dev/null; exit 1; fi
echo "→ servidor listo"

# ---------- 1. sin credencial → 401 ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"task.create","payload":{"title":"intruso","kind":"generic"}}')
check 401 "$C" "POST sin credencial → 401"

# ---------- 2. suplantación de identidad via body → 401 (no se procesa) ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"task.create","payload":{"title":"intruso","kind":"generic"},"requesterType":"SYSTEM","requesterId":"eec:system"}')
check 401 "$C" "body requesterType=SYSTEM sin credencial → 401 (suplantación imposible)"

# ---------- 3. token incorrecto → 401 ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -H "Authorization: Bearer token-incorrecto" -d '{"type":"task.create","payload":{"title":"x","kind":"generic"}}')
check 401 "$C" "bearer inválido → 401"

# ---------- 4. login incorrecto → 401; correcto → cookie ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/auth" -H 'Content-Type: application/json' -d '{"password":"incorrecta"}')
check 401 "$C" "login con contraseña incorrecta → 401"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -X POST "$BASE/api/eec/auth" -H 'Content-Type: application/json' -d "{\"password\":\"$DEV_PASSWORD\"}")
check 200 "$CODE" "login correcto → 200 + cookie de sesión"
grep -q "eec_session" "$COOKIE_JAR" && ok "cookie httpOnly establecida" || bad "cookie ausente"

# ---------- 5. con sesión: comando procesado e identidad FORZADA a HUMAN ----------
RES=$(curl -s -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"task.create","payload":{"title":"SUITE-SEC identidad","kind":"generic"},"requesterType":"SYSTEM","requesterId":"eec:system"}')
RTYPE=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('requester',{}).get('type','?'))" 2>/dev/null || echo "?")
OKCMD=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
if [ "$OKCMD" = "True" ]; then ok "comando con sesión aceptado"; else bad "comando con sesión rechazado" "$RES"; fi
if [ "$RTYPE" = "HUMAN" ]; then ok "body requesterType=SYSTEM IGNORADO → identidad efectiva HUMAN"; else bad "identidad efectiva" "esperado=HUMAN obtenido=$RTYPE"; fi

# ---------- 6. bearer de servicio también funciona ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -H "Authorization: Bearer $DEV_TOKEN" -d '{"type":"task.create","payload":{"title":"SUITE-SEC bearer","kind":"generic"}}')
check 200 "$C" "bearer de servicio válido → 200"

# ---------- 7. comando desconocido → 422 (validación de pipeline) ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"comando.inexistente","payload":{}}')
check 422 "$C" "comando desconocido → 422"

# ---------- 8. payload inválido según esquema zod → 422 ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"task.create","payload":{"title":"x"}}')
check 422 "$C" "payload con title<3 chars → 422 (validación)"

# ---------- 9. tipo de comando malformado → 400 ----------
C=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":""}')
check 400 "$C" "type vacío → 400"

# ---------- 10. body gigante → 413 ----------
python3 -c "import json; print(json.dumps({'type':'task.create','payload':{'title':'a'*1100000,'kind':'generic'}}))" > /tmp/eec-big-payload.json
C=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' --data-binary @/tmp/eec-big-payload.json)
rm -f /tmp/eec-big-payload.json
check 413 "$C" "body >1MB → 413"

# ---------- 11. rate limit (60/min en /api/eec/commands) — comando benigno inválido ----------
RL_TRIGGERED=0
for i in $(seq 1 70); do
  C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -H "Authorization: Bearer $DEV_TOKEN" -d '{"type":"task.move","payload":{"taskId":"no-existe","to":"DONE"}}')
  if [ "$C" = "429" ]; then RL_TRIGGERED=1; break; fi
done
check 1 "$RL_TRIGGERED" "rate limit activo → 429 tras ráfaga"

# ---------- 12. GET de estado sigue abierto (panel de solo lectura) ----------
C=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/eec/state")
check 200 "$C" "GET /api/eec/state sin credencial → 200 (lectura)"

# ---------- 13. logout elimina sesión ----------
curl -s -b "$COOKIE_JAR" -X DELETE "$BASE/api/eec/auth" -c "$COOKIE_JAR" > /dev/null
C=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$BASE/api/eec/commands" -H 'Content-Type: application/json' -d '{"type":"task.create","payload":{"title":"post-logout","kind":"generic"}}')
check 401 "$C" "tras logout → 401"

# ---------- limpieza ----------
pkill -f "next dev" 2>/dev/null
rm -f "$COOKIE_JAR"
bun -e "import {db} from './src/lib/db'; const a=await db.task.deleteMany({where:{title:{startsWith:'SUITE-SEC'}}}); process.exit(0)" 2>/dev/null
echo ""
echo "=== SEGURIDAD HTTP: $PASS OK, $FAIL FALLOS ==="
[ "$FAIL" = "0" ] || exit 1
