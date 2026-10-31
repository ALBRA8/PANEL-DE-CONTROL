#!/bin/bash
# Verificación E2E del tema claro/oscuro en una sola llamada
# (el sandbox mata procesos de fondo entre llamadas → todo junto)
set -u
cd /home/z/my-project

# 1) Arrancar servidores
nohup bun run dev > /tmp/next-v.log 2>&1 &
cd mini-services/eec-realtime && nohup bun --hot index.ts > /tmp/rt-v.log 2>&1 &
cd /home/z/my-project

# 2) Esperar a que Next responda
echo "== esperando :3000 =="
ok=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
  if [ "$code" = "200" ]; then ok=1; echo "Next listo tras ${i}x2s"; break; fi
  sleep 2
done
[ "$ok" = "1" ] || { echo "ERROR: Next no levantó"; tail -20 /tmp/next-v.log; exit 1; }

# 3) Esperar a que /api/eec/state dé 200 (BD nueva)
echo "== esperando /api/eec/state =="
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/eec/state 2>/dev/null)
  if [ "$code" = "200" ]; then ok=1; echo "state OK tras ${i}x2s"; break; fi
  sleep 2
done
[ "$ok" = "1" ] || { echo "AVISO: state sigue != 200"; }

# 4) Verificación de tema en navegador
echo "== navegador =="
mkdir -p /tmp/render
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:3000
agent-browser wait --load networkidle
agent-browser wait 3000
echo "-- modo oscuro (por defecto) --"
agent-browser eval "document.documentElement.className + ' | localStorage.theme=' + (localStorage.getItem('theme')||'(no seteado)')"
agent-browser screenshot /tmp/render/01-dark-home.png

echo "-- cambiar a modo claro --"
agent-browser find role button click --name "Cambiar a modo claro"
agent-browser wait 1200
agent-browser eval "document.documentElement.className + ' | localStorage.theme=' + (localStorage.getItem('theme')||'(no seteado)')"
agent-browser screenshot /tmp/render/02-light-home.png

echo "-- persistencia tras recargar --"
agent-browser reload
agent-browser wait --load networkidle
agent-browser wait 2500
agent-browser eval "document.documentElement.className + ' (tras recargar)'"
agent-browser screenshot /tmp/render/03-light-reload.png

echo "-- cambiar de vuelta a oscuro --"
agent-browser find role button click --name "Cambiar a modo oscuro"
agent-browser wait 1000
agent-browser eval "document.documentElement.className + ' | localStorage.theme=' + (localStorage.getItem('theme')||'(no seteado)')"

echo "== FIN =="
