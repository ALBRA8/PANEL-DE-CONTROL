# Task 7-b — world-ui — Registro de trabajo

## Alcance
Capa visual del HQ y de la oficina individual del EEC, consumiendo la infraestructura existente
(`@/store/eec-store`, `@/lib/eec-client`, `POST /api/eec/commands`, `GET /api/eec/agents?id=`).

## Archivos creados (exactamente 2, ningún otro tocado)
1. `src/components/eec/world-view.tsx` — default export `WorldView` ('use client')
2. `src/components/eec/agent-office.tsx` — default export `AgentOffice({ agentId })` ('use client')

## Decisiones clave
- **Ley de oro**: el movimiento de avatares usa `layoutId={`agent-${agentId}`}` (framer-motion, spring).
  La animación ocurre únicamente cuando el snapshot cambia tras un evento real
  `agent.location.changed`; en montaje inicial no hay animación y sin evento no hay movimiento.
- **Ticker "Últimos movimientos"**: deriva de `events` filtrando `event_type === 'agent.location.changed'`
  (máx 8), con from/to resueltos a nombres de sala vía `snapshot.locations`; estado vacío explícito.
- **Honestidad**: OFFLINE → avatar gris con borde discontinuo + 'NOT CONNECTED' (solo acción Conectar);
  agentes sin ubicación en bandeja separada; sin datos → 'Sin registros todavía'; errores de comando
  inline (sin toasts fantasmas).
- **Reuniones**: Iniciar → `meeting.start {meetingId}`; Finalizar → `meeting.end {meetingId, decisions: [], actionItems: []}`.
- **Controles agente** (misma lógica que tarjetas): OFFLINE→Conectar; IDLE/WORKING→Pausar+Suspender;
  PAUSED→Reanudar+Suspender; SUSPENDED→Despertar; resto→Suspender.
- **Paleta**: slate/emerald/teal/amber/rose/violet/fuchsia — sin azul/índigo; font-mono para códigos;
  responsive (grid HQ `min-w-[900px]` + `overflow-x-auto`, panel apilado en móvil); listas con
  `max-h-* overflow-y-auto`.

## Estado de verificación
- `bunx tsc --noEmit | grep -E "world-view|agent-office"` → limpio (0 errores).
- `bun run lint | grep -E "world-view|agent-office"` → limpio (0 errores; los 8 errores del repo son
  preexistentes en memory-view.tsx / shell.tsx / pipeline.ts de otros agentes).

## Notas para siguientes agentes
- El shell puede montar `<WorldView />` para la vista `world` y `<AgentOffice agentId={...} />`
  (p. ej. cuando `selectedAgentId` está definido); ambos son autónomos y no requieren props extra.
- Los componentes dependen de `snapshot` no nulo del store (mostran skeleton mientras carga).
