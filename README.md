# EEC — Enterprise Execution & Control Center

Control plane empresarial para orquestar agentes de IA con **human-in-the-loop**: estado único de la verdad (`EEC STATE`), pipeline de comandos con validación/autorización/policy, proveedores neutrales vía adapters, simulación honesta y un mundo visual sincronizado en tiempo real.

## Principios de diseño

1. **EEC STATE como única fuente de verdad** — el flujo es siempre
   `REAL STATE → WORLD STATE → VISUAL STATE → RENDERING`, nunca al revés.
   La UI no muta estado: solo despacha comandos y renderiza el estado.
2. **Separación control plane / execution plane** — el EEC decide y supervisa; la ejecución vive en providers detrás de interfaces neutrales.
3. **Providers neutrales** — `EEC → INTERFACE → ADAPTER → PROVIDER`.
   Cero lock-in: cambiar de proveedor no toca el dominio ni la UI.
4. **Simulación honesta** — todo lo simulado está marcado (`sim`, eventos `SUPPRESSED_SIM`, tools con `simulated: true`). El sistema nunca fabrica actividad real.
5. **Human-in-the-loop** — acciones sensibles (tools HIGH risk, decisiones de run) pasan por la cola de aprobaciones.

## Pipeline de comandos

Todo comando humano o de agente recorre:

```
VALIDATION → AUTHORIZATION → POLICY → DISPATCH → (eventos en el bus)
```

El bus de eventos usa envelopes con `event_id`, `type`, `version`,
`correlation_id` y `causation_id` para trazabilidad completa (vista Auditoría).

## Stack

| Capa | Tecnología |
|------|------------|
| App | Next.js 15 (App Router) + React 19 + TypeScript |
| Runtime | Bun |
| BD | Prisma + SQLite (`db/custom.db`) |
| Estilos | Tailwind CSS 4 (tema claro y oscuro vía `next-themes`) |
| UI | shadcn/ui + lucide-react |
| Estado cliente | Zustand (`src/store/eec-store.ts`) |
| Tiempo real | socket.io (mini-servicio `mini-services/eec-realtime`, puerto 3030) |
| Gateway | Caddy (`:81` → Next `:3000`, `socket.io` → `:3030`) |

## Puesta en marcha

```bash
# 1. Dependencias
bun install

# 2. Variables de entorno
cp .env.example .env
#    → ajusta DATABASE_URL a una ruta absoluta válida

# 3. Esquema de base de datos
bun run db:generate
bun run db:push

# 4. (Opcional) Datos semilla de simulación — org ACME, agentes, runs, herramientas
bun scripts/seed.ts

# 5. Servidor de desarrollo (puerto 3000)
bun run dev

# 6. Mini-servicio de tiempo real (puerto 3030)
cd mini-services/eec-realtime && bun install && bun run dev
```

Accede por el gateway de Caddy en **http://localhost:81** (el acceso directo a
`:3000` funciona, pero el badge de realtime mostrará `POLL` en vez de `LIVE`
porque el socket solo se enruta correctamente a través del gateway).

> Nota: los cambios en `src/instrumentation.ts`, workers o `next.config.ts`
> requieren reiniciar el servidor (`instrumentation` no se recarga en caliente).

## Estructura

```
src/
├── app/
│   ├── api/eec/            # state, commands, meetings, approvals…
│   └── page.tsx            # shell principal
├── components/eec/         # 13 vistas: central, task-board, world-view,
│   │                       # agent-office, approvals, events-audit, crm,
│   │                       # calendar, meetings, memory, ops, inspector…
│   └── shell.tsx           # top bar (badges SIMULACIÓN, LIVE/POLL, toggle tema)
├── lib/eec/
│   ├── domain/             # types, contratos (Agent/Orchestration/Runtime/Tool)
│   ├── engine/             # bus de eventos, gateway de comandos, workers
│   ├── providers/          # interfaces + adapters (local-sim, …)
│   └── boot.ts             # arranque de instrumentation
└── store/eec-store.ts      # store Zustand (actualización optimista)
```

## Funcionalidades destacadas

- **Tablero de tareas con drag & drop** — arrastra tarjetas entre columnas
  (`INBOX → TODO → IN_PROGRESS → …`); el movimiento se despacha como comando
  `task.move` y se valida server-side contra la matriz de transiciones
  (`TASK_TRANSITIONS`). Transición inválida → toast del pipeline, sin mutar UI.
- **Modo claro y oscuro** — toggle sol/luna en la top bar; la paleta EEC se
  remapea por CSS variables sin tocar los componentes.
- **Oficina de agentes** — vista espacial del mundo visual sincronizada con el
  `WORLD STATE`.
- **Aprobaciones humanas** — cola con aprobar/rechazar; nada sensible se
  ejecuta sin decisión humana.
- **Auditoría de eventos** — bus completo con `correlation_id`/`causation_id`.

## Tests de aceptación

```bash
ls tests/eec/
```

Cobertura de los invariantes clave: fuente de verdad, pipeline, contratos de
providers, honestidad de la simulación y transiciones de tareas.

## Seguridad

- `.env` no se versiona (ver `.env.example`).
- La base de datos incluida contiene **datos simulados** de demostración
  (organización ACME). Si clonas el repo puedes regenerarla con
  `bun run db:push && bun scripts/seed.ts`.
