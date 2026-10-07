# EEC — Enterprise Execution & Control Center

Control plane de agentes. **La capa visual nunca inventa actividad operacional** — toda la UI refleja `EEC STATE` (Prisma/SQLite) alimentado por el pipeline `COMANDO → EVENTO → ESTADO`.

## Arranque (RUN INSTRUCTIONS)

```bash
# 1. Base de datos (schema ya aplicado; seed idempotente)
bun run db:push          # sincroniza prisma/schema.prisma
bun scripts/seed.ts      # organiza ACME + agentes + CRM + workflows (skip si ya existe)

# 2. Servidor de la app (el sistema lo lanza automáticamente; puerto 3000)
#    La instrumentación (src/instrumentation.ts) arranca el motor (workers + providers).
next dev -p 3000        # equivalente: bun run dev

# 3. Bridge realtime (socket.io, puerto 3030 vía gateway XTransformPort)
cd mini-services/eec-realtime && bun run dev &
```

UI única: `http://localhost:3000/` (preview del sandbox: usar el Preview Panel).
Smoke test: `curl http://localhost:3000/api/eec/state | jq .health`

## Variables de entorno (.env)

| Variable | Default | Uso |
|---|---|---|
| `DATABASE_URL` | `file:/home/z/my-project/db/custom.db` | SQLite operacional |
| `EEC_SIMULATION_MODE` | `1` | `0`=producción (tools externas activas solo con providers reales). Persistido/alterable desde UI → Sistema |
| `EEC_API_URL` | `http://localhost:3000` | Upstream que consulta el bridge realtime |
| `EEC_POLL_MS` | `900` | Intervalo de polling del bridge |
| `EEC_REALTIME_PORT` | `3030` | Puerto del mini-servicio socket.io (fijo en código) |

## Probar el ciclo completo (2 minutos)

1. **Central** — observa agentes IDLE/WORKING y runs avanzando.
2. **Tareas** → *Nueva tarea* (kind `research`, asigna a Vega) — mira el run progresar en Central.
3. **Aprobaciones** — aprueba un `email.send` gated (riesgo HIGH) → la tool se ejecuta marcada SIM.
4. **Mundo HQ** — programa/inicia la reunión: los agentes se mueven (evento `agent.location.changed`) y pasan a IN_MEETING.
5. **Sistema** — lanza caos: `system.chaos.runtime_crash` y luego recupera el runtime (o espera al heartbeat monitor).
6. **Eventos** — feed en vivo del bus; **trazabilidad completa** en Reconstrucción (audit + events por entidad).

## Arquitectura

```
UI (12 vistas, solo lee estado / emite comandos)
        │ POST /api/eec/commands
        ▼
COMMAND PIPELINE  validación → autorización → política → [gate aprobación HIGH/CRITICAL] → dispatch
        │                                              │
        ▼                                              ▼
   EVENT BUS (persistencia, idempotencia, retry, dead-letter, replay)  → socket.io :3030 → UI
        │
        ▼
ENGINE: state machines · runtime loop · capability gateway · workflow · scheduler
        memory/knowledge (provenance + clearance) · evaluation · audit · observability
        │
        ▼
PROVIDER REGISTRY (§43): AgentInterface · OrchestrationInterface · RuntimeInterface ·
ToolInterface · MemoryInterface · KnowledgeInterface · NotificationInterface
Adapters por defecto: local-sim (simulación honesta). Reemplazables sin tocar el core.
```

## Reglas de oro implementadas

- **REAL STATE → WORLD STATE → VISUAL STATE** (nunca al revés).
- Los agentes no conectados se muestran `OFFLINE / NOT CONNECTED`.
- El movimiento solo se anima con eventos reales de ubicación.
- Comandos duplicados (`idempotencyKey`) y eventos duplicados (`event_id`) no generan efectos repetidos.
- Auditoría inmutable: correcciones = registro nuevo con `prevAuditId`.
- Secretos redactados (`[REDACTED]`) en logs/eventos/audit.
- Simulación: tools externas suprimidas y marcadas `sim=true`.

## Tests de aceptación (30+ escenarios, spec §53)

```bash
bun test tests/eec/acceptance.test.ts
```

Cubre: registro/descubrimiento/heartbeat, asignación, runs, tools vía gateway, propagación de
eventos, máquina de estados (rechazo auditable), evaluación de calidad, ciclo de aprobación con
reanudación de comando, denegación de permisos, caos/recovery de runtime, retry/cancelación,
memoria con provenance, filtro de conocimiento por clasificación, reconstrucción de auditoría,
sincronización visual, reemplazo de orquestador y de adapter de agente, idempotencia de
comandos y eventos, violación de seguridad, pipeline CRM, ciclo completo de reunión,
scheduler, notificaciones y sanitización de secretos.
