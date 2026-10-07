# Task 7-d — ops-ui (Sub Z) — Registro de trabajo

Proyecto: EEC — Enterprise Execution & Control Center
Alcance: 4 vistas de gobernanza/observabilidad (Aprobaciones §24, Eventos/Auditoría/Trazas §14/§27/§28, Memoria/Conocimiento §18/§19, Sistema/Ops §43/§17/§23/§30).

## Archivos creados (exactamente 4, ningún otro tocado)

1. `src/components/eec/approvals-view.tsx` — default export `ApprovalsView`
2. `src/components/eec/events-audit-view.tsx` — default export `EventsAuditView`
3. `src/components/eec/memory-view.tsx` — default export `MemoryView`
4. `src/components/eec/ops-view.tsx` — default export `OpsView`

## Contratos consumidos (no recreados)

- Store: `useEecStore` (command, refresh, events, connected) de `@/store/eec-store`.
- Tipos/paletas: `EecApproval`, `RISK_STYLE`, `timeAgo` de `@/lib/eec-client`.
- APIs: GET `/api/eec/approvals`, `/api/eec/audit` (+ `?entityType=&entityId=` para reconstrucción), `/api/eec/memory?q=&scope=`, `/api/eec/ops`.
- Comandos por el pipeline único: `approval.approve|reject|cancel`, `audit.correct`, `memory.write`, `knowledge.publish`, `system.simulation.toggle`, `system.deadletter.retry`.

## Decisiones clave

- Rechazo de aprobaciones con nota OBLIGATORIA (min 3 chars) validada en cliente; aprobación con nota opcional; hint de reanudación de comando pausado cuando `subjectType === 'COMMAND'`.
- Corrección de auditoría inmutable: `audit.correct` crea registro nuevo encadenado vía `prevAuditId`; la UI muestra el chain ('corrección de …') y valida JSON del output antes de enviar.
- Memoria: escritura siempre DELIBERADA (nota visible §18); conocimiento con nota del filtro de clasificación ≤ clearance (§19).
- Ops de solo lectura salvo Switch de simulación (optimista con revert si el pipeline rechaza) y reintento de dead-letters {limit:50} (toast muestra `result.retried`).
- Eventos en vivo capados a 150 filas visibles del filtro (contador honesto de ocultos) como "virtualización simple".
- Paleta sin azul/índigo (emerald/teal/amber/rose/violet/orange/fuchsia/slate); font-mono para códigos/JSON/ids; toasts sonner; estados vacíos honestos; responsive + aria-labels.

## Verificación

- `bunx tsc --noEmit | grep -E "approvals-view|events-audit-view|memory-view|ops-view"` → LIMPIO (se corrigió un import faltante de Tabs en memory-view durante la iteración).
- `bun run lint | grep -E "approvals-view|events-audit|memory-view|ops-view"` → 0 hallazgos en mis archivos (errores remanentes del repo: shell.tsx y pipeline.ts de otros agentes, fuera de alcance).

## Handoff para el shell (7-a)

Cablear vistas con imports:
```ts
import ApprovalsView from '@/components/eec/approvals-view'
import EventsAuditView from '@/components/eec/events-audit-view'
import MemoryView from '@/components/eec/memory-view'
import OpsView from '@/components/eec/ops-view'
```
No requieren props; approvals/ops/events/memory gestionan su propio fetch y auto-refresh (8s / 15s / realtime store / on-filter).
