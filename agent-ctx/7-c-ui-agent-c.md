# Task ID: 7-c — UI: CRM, Calendario, Reuniones

Agente: ui-agent-c · Fecha: sesión actual
Estado: COMPLETADO — tsc y lint limpios en los 3 archivos propios.

## Archivos creados (exactamente 3, nada más fue tocado)

| Archivo | Default export | Spec |
|---|---|---|
| `src/components/eec/crm-view.tsx` | `CrmView` | §32 |
| `src/components/eec/calendar-view.tsx` | `CalendarView` | §33 |
| `src/components/eec/meetings-view.tsx` | `MeetingsView` | §34 |

## Contrato para el shell (task 7-a)

```ts
import CrmView from '@/components/eec/crm-view'        // vista 'crm'
import CalendarView from '@/components/eec/calendar-view' // vista 'calendar'
import MeetingsView from '@/components/eec/meetings-view' // vista 'meetings'
```

Requisitos que ya cumplen por sí mismas: `'use client'`, leen `useEecStore` (snapshot/command), esperan `snapshot === null` con skeletons, no registran sockets ni bootstrap (eso lo hace `useEecBootstrap` del shell).

## Decisiones técnicas

- Fetch local cliente: CRM usa `GET /api/eec/crm`, calendario `GET /api/eec/calendar`; ambos refetch tras cada comando exitoso (los datos CRM/calendario no viven en el snapshot).
- Comandos usados (payloads validados contra `commands/registry.ts`): meeting.start / meeting.end / meeting.create / meeting.invite (implícito vía participantAgentIds) / client.create / client.update_stage / opportunity.create / opportunity.update_stage / interaction.log / calendar.create / schedule.toggle.
- Campos extra del snapshot (decisionsJson, actionItemsJson, agendaJson, result) se leen de forma defensiva (`Record<string, unknown>` + JSON.parse con catch) porque el tipo `EecMeeting` no los declara; si no existen se muestra '—'.
- Calendario mensual custom (sin react-day-picker): date-fns v4 + locale es + weekStartsOn 1. Puntos por tipo: MEETING fuchsia, DEADLINE rose, SCHEDULED_RUN emerald, REMINDER amber, FOCUS_BLOCK teal.
- Dinero: `Intl.NumberFormat('es-CO', { notation: 'compact', style: 'currency', currency: 'USD' })`.
- Errores honestos: `toast.error(res.error)` de sonner si `!result.ok`; vacíos reales ('Sin clientes en esta etapa', 'Sin eventos para este día'); advertencia de scheduler real (spec §22) en la tabla de schedules.
- Paleta: slate + emerald/teal/amber/rose/violet/fuchsia; cero azul/índigo. Códigos/IDs/expresiones en font-mono.

## Verificación

- `bunx tsc --noEmit 2>&1 | grep -E "crm-view|calendar-view|meetings-view"` → 0 coincidencias.
- `bun run lint 2>&1 | grep -E "crm-view|calendar-view|meetings-view"` → 0 coincidencias.
- (Errores tsc/lint remanentes del repo pertenecen a memory-view.tsx / shell.tsx de agentes paralelos y a pipeline.ts preexistente.)
