# EEC V2 — 01. Informe de auditoría inicial (estado de partida)

Fecha: 2026-10-23 · Rama base: `main` @ `71b46ef` · Auditor: constructor EEC V2

## Alcance auditado

Se inspeccionó el árbol completo en HEAD: `src/lib/eec/**` (domain, commands, engine, events, providers), rutas `src/app/api/eec/**` (13 rutas), `prisma/schema.prisma` (36 modelos), `tests/eec/acceptance.test.ts` (31 pruebas), componentes UI (13 vistas), scripts y configuración de despliegue (Caddy :81 → Next :3000, socket.io :3030).

## Qué funcionaba REALMENTE (verificado, no documentado)

| Capacidad | Evidencia |
|---|---|
| Pipeline de comandos VALIDATION→AUTHORIZATION→POLICY→DISPATCH con esquemas zod | `commands/pipeline.ts` + tests 08/12/23 |
| Idempotencia de comandos y eventos (`idempotencyKey`, `event_id`) | tests 23/24 |
| Máquinas de estado validadas (AGENT/RUNTIME/TASK/RUN/APPROVAL) con rechazo auditable | `domain/types.ts`, tests 08 |
| Gateway de tools con capability→policy→risk (HIGH exige aprobación de agente) | `engine/gateway.ts`, tests 06/25 |
| Event bus con envelope (`event_id`, `correlation_id`, `causation_id`) persistido | tests 07/24 |
| Workers: runtime-loop, heartbeat, scheduler, approval-expiry, notifications | `engine/workers.ts`, tests 28/29 |
| Auditoría reconstruible (WHO/WHAT/WHEN/INPUT/OUTPUT) | `engine/audit.ts`, test 19 |
| 31 pruebas de aceptación ejecutando el pipeline real contra BD real | `bun test tests/eec/` — 31/31 pass |

## Qué era SIMULADO (y así estaba marcado)

- **Único `AgentInterface` registrado: `local-sim`** — tick determinista que avanza progreso 18/9/7 por tramos; actividad derivada del progreso, no de trabajo externo.
- Tools builtin (`web.search`, `report.generate`, `email.send`…): `simulated:true`; `email.send` siempre `SUPPRESSED_SIM`.
- Modo simulación global (`EEC_SIMULATION_MODE`, persistido en memoria organizacional; eventos marcados `sim`).

No había NINGÚN adaptador de ejecución real: todo run "avanzaba" por diseño del simulador.

## Qué estaba INCOMPLETO o era solo aparente

1. **CRÍTICO (seguridad)**: `POST /api/eec/commands` aceptaba `requesterType`/`requesterId` **del body del cliente**. Consecuencias: cualquiera con acceso de red podía actuar como `HUMAN` (salta permisos y la mayor parte de gates de aprobación) o directamente como `SYSTEM` (bypass total del gate). Ver `commands/route.ts` v1.
2. **Sin autenticación en ninguna ruta** ni rate-limit ni límite de tamaño de payload.
3. `agent.start` marcaba runtime `RUNNING`/agente `IDLE` **sin ninguna comprobación de salud real**: estar en la BD equivalía a estar operativo.
4. Sin evidencias de ejecución (no se registraba proceso/pid/exit/stdout); sin reconciliación de ejecuciones reales tras reinicio.
5. `task.start` tenía dedupe de run vivo pero sin claim atómico estricto ante concurrencia real.
6. Bug latente: si un run terminaba en error, el run quedaba `FAILED` pero **la tarea quedaba `IN_PROGRESS` para siempre** (detectado por el piloto V2; corregido).
7. Integración INSTALADOR/AGENTE-GENERAL: **inexistente**. Los repos `ALBRA8/INSTALADOR` y `ALBRA8/AGENTE-GENERAL` no fueron accesibles desde este entorno (no se pudieron examinar en modo lectura); no se asume ningún contrato de ellos. La frontera se construyó como contrato preparado + adaptador honesto "no disponible" (ver 03-ADAPTADORES y 06-MATRIZ).

## Comandos oficiales del proyecto (comprobados)

```bash
bun run dev                 # Next.js en :3000 (tee dev.log)
bun run db:generate         # cliente Prisma
bun run db:push             # esquema (sin migraciones destructivas)
bun test tests/             # TODAS las pruebas (acceptance + V2)
bun run test:acceptance     # regresión V1 (31)
bun run test:v2             # unitarias+integración V2
bun run test:api-security   # frontera HTTP (arranca servidor, 16 comprobaciones)
bun run pilot               # piloto E2E de ejecución real (19 pasos)
```

## Regla de oro respetada en la evolución

El audit orientó el trabajo, no lo sustituyó: cada hallazgo anterior tiene una corrección implementada y probada en esta rama (ver `06-MATRIZ-CAPACIDADES.md`, columna "Estado V2").
