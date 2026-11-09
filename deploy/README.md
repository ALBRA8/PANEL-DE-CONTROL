# Despliegue del PANEL DE CONTROL con Docker

Este despliegue inicial está pensado para una máquina Linux o VPS con Docker Engine y el plugin Docker Compose.

## Requisitos

- Docker Engine con Docker Compose v2.
- 2 GB de RAM como mínimo recomendado para compilar Next.js; 4 GB recomendados.
- Espacio persistente para SQLite en el volumen `panel-data`.
- Puerto TCP 3000 disponible (o cambiar `PANEL_PORT`).

## Preparar secretos

Desde la raíz del repositorio:

```bash
cp .env.example .env
```

Edita `.env` y reemplaza obligatoriamente estos tres valores por secretos distintos y aleatorios:

- `EEC_OPERATOR_PASSWORD`: contraseña inicial del operador.
- `EEC_SESSION_SECRET`: secreto largo para firmar sesiones.
- `EEC_API_TOKEN`: token para integraciones de servicio.

Puedes generar valores con:

```bash
openssl rand -hex 32
```

No publiques el archivo `.env`, no reutilices contraseñas y restringe sus permisos:

```bash
chmod 600 .env
```

## Construir e iniciar

```bash
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs -f panel
```

Abre `http://SERVIDOR:3000` (o el puerto definido en `PANEL_PORT`).

El contenedor crea el esquema Prisma al arrancar y almacena SQLite en el volumen Docker `panel-data`. Los reinicios conservan los datos. El endpoint `/api/health` comprueba que la aplicación puede consultar la base de datos.

## Operación

```bash
# Estado de salud
curl -i http://127.0.0.1:3000/api/health

# Detener sin borrar datos
docker compose -f compose.yaml down

# Actualizar imagen y reiniciar (el volumen se conserva)
docker compose -f compose.yaml up -d --build

# Copia lógica del archivo SQLite (detén primero el servicio)
docker compose -f compose.yaml stop panel
docker compose -f compose.yaml cp panel:/app/data/panel.db ./panel-backup.db
docker compose -f compose.yaml start panel
```

**No uses `docker compose down -v`** salvo que quieras borrar deliberadamente la base de datos persistente.

## Alcance y límites de esta primera entrega

- Este paquete despliega el PANEL como servicio HTTP directo en el puerto configurado.
- El bridge Socket.IO de tiempo real y el gateway Caddy no están incluidos todavía; la interfaz debe operar con su mecanismo de polling cuando no haya bridge.
- La conexión real con INSTALADOR requiere configurar sus credenciales y completar la compatibilidad de rutas/contratos descrita en `docs/EEC-INSTALLER-CONTRACT.md`.
- El catálogo del INSTALADOR todavía no registra este paquete como producto instalable.
- La compilación y el arranque deben validarse en CI y en un VPS real antes de declarar este paquete listo para producción.

Este documento describe el paquete inicial; no constituye evidencia de un despliegue probado.
