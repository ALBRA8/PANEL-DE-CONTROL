# EEC V2 — 06. Matriz de capacidades, decisiones, riesgos y archivos

## 1. Matriz de capacidades (REAL / SIMULADO / PENDIENTE)

| Capacidad | Estado V1 | Estado V2 | Evidencia |
|---|---|---|---|
| Pipeline de comandos + validación + idempotencia | REAL | REAL (regresión 31/31) | tests aceptación 23/24 |
| Autorización de agentes por permisos | REAL | REAL | tests 12/25, piloto 13 |
| Ejecución por agente simulado | SIMULADO (marcado) | SIMULADO (marcado; nunca default de producción) | panel: `provider: SIMULADO` |
| **Ejecución por proceso local real** | — | **REAL** | piloto 19/19; integración 6/6 |
| **Ejecución por servicio HTTP real** | — | **REAL (contrato + adaptador)** | adaptador probado unitariamente; requiere agente HTTP real para E2E |
| Health check real de agentes | — | **REAL** (spawn/--eec-health o GET /health) | piloto 3 |
| Evidencias de ejecución (pid/exit/stdout redactado) | — | **REAL** | `ExecutionProcess` + `Artifact` |
| Reconciliación tras reinicio | — (sim: reanudación) | **REAL** (runs reales → `UNRECONCILED`) | piloto 12 |
| Aprobaciones humanas | REAL | REAL + demo con política sobre task.start | piloto 5-6 |
| Autenticación de la frontera HTTP | — (abierta) | **REAL** (bearer + sesión firmada) | suite HTTP 16/16 |
| Límite de frecuencia / tamaño | — | **REAL** (memoria, por instancia) | suite 11/10 |
| Cancelación de ejecuciones reales | — | **REAL** (SIGTERM→SIGKILL + estados) | piloto 10 |
| Frontera INSTALADOR | — | CONTRATO PREPARADO + adaptador honesto "no disponible" | unitarias; sin URL real |
| Integración AGENTE-GENERAL | — | PENDIENTE (repo no accesible; sin contratos asumidos) | 01-AUDITORIA §incompleto |
| VPS/despliegue productivo verificado | — | **NO VERIFICADO** — no se afirma | riesgo R4 |

## 2. Decisiones arquitectónicas (resumen)

1. **Adaptador real ≠ default**: `local-process`/`http-agent` se registran sin `isDefault`; solo operan para agentes cuyo registro declara ese provider y un manifiesto válido. Evita que un runtime real caiga silenciosamente a sim (o viceversa).
2. **UNRECONCILED como estado de run**: en lugar de inventar `FAILED` o `SUCCEEDED` tras un reinicio sin evidencia, el run queda `UNRECONCILED` (transición a `FAILED`/`SUCCEEDED` solo por decisión humana o nueva evidencia) y la tarea pasa a `BLOCKED`. Cumple §5 literalmente.
3. **Claim atómico de tarea** (`UPDATE … WHERE status='TODO'`) + dedupe de run vivo: dos `task.start` concurrentes nunca crean dos ejecuciones.
4. **Entrada por stdin, nunca argv/shell**: elimina inyección de comandos por diseño; las allowlists son segunda barrera.
5. **Evidencia redactada en Artifact** reutilizando el modelo existente (sin nueva tabla de evidencias), con `ExecutionProcess` como único modelo nuevo (aditivo, sin `--accept-data-loss`).
6. **Frontera de identidad en la ruta HTTP, no en el pipeline**: `dispatchCommand` sigue siendo el punto único interno (workers/CLI/HTTP); solo la capa HTTP deriva identidad de credenciales. Cambios futuros de IdP no tocan handlers.
7. **Bug corregido en V1**: error de run dejaba la tarea `IN_PROGRESS` para siempre; ahora transiciona a `FAILED` (transición validada; estados ya resueltos se respetan).

## 3. Riesgos restantes y pasos exactos

| # | Riesgo | Severidad | Pasos para resolverlo |
|---|---|---|---|
| R1 | Rate-limit y buckets en memoria (por instancia) | Media | Sustituir `security/rate-limit.ts` por Redis/almacén compartido; la interfaz `checkRate()` ya aísla el cambio |
| R2 | Autenticación de operador único (sin SSO/multi-usuario) | Media | Sustituir `loginOperator` por IdP (OIDC); `resolveRequester` ya centraliza la derivación de identidad |
| R3 | `GET /api/eec/*` de lectura sin credencial | Baja (panel interno) | Añadir `resolveRequester` a los GET si el despliegue es público; es un cambio mecánico por ruta |
| R4 | Despliegue VPS/producto no verificado desde este entorno | Alta si se expone públicamente | Desplegar con TLS + variables de §04; ejecutar `bun run test:api-security` contra el despliegue real antes de exponer |
| R5 | INSTALADOR sin endpoints reales conocidos | Media | Cuando `ALBRA8/INSTALADOR` publique su API, implementar `HttpInstaladorAdapter` contra ella (contrato ya especificado en 03); hasta entonces toda operación responde "no disponible" |
| R6 | AGENTE-GENERAL y especialistas no integrados | Media | Cada agente publica su `manifest.json` (02); registro + health + tarea funcionan sin tocar sus repos |
| R7 | Reinicio real no automatizable en el piloto | Baja | Mismo code path probado; opcionalmente añadir prueba de integración con orquestador externo |

## 4. Archivos creados / modificados (resumen de entrega)

**Nuevos**
- `src/lib/eec/contracts/agent-manifest.ts` — contrato v1 (zod) + validación + ejemplos
- `src/lib/eec/contracts/lifecycle.ts` — frontera INSTALADOR (tipos + versión)
- `src/lib/eec/security/auth.ts` — identidad server-side, sesiones HMAC, redacción de secretos
- `src/lib/eec/security/rate-limit.ts` — ventana deslizante
- `src/lib/eec/providers/adapters/local-process.ts` — proceso real (spawn/allowlists/NDJSON/timeout/cancel/evidencias/reconciliación)
- `src/lib/eec/providers/adapters/http-agent.ts` — servicio HTTP real
- `src/lib/eec/providers/adapters/instalador.ts` — frontera INSTALADOR (activa + honesta)
- `src/app/api/eec/auth/route.ts` — login/logout/estado
- `src/components/eec/operator-login.tsx` — autenticación del panel
- `agents/echo-agent/{agent.mjs,manifest.json}` — agente de prueba real
- `scripts/pilot-e2e.ts` — piloto 19 pasos
- `tests/eec-v2/{v2.test.ts,local-process.real.test.ts,api-security.sh}` — pruebas V2
- `docs/EEC-V2/01…06` — esta documentación
- modelo `ExecutionProcess` en `prisma/schema.prisma` (aditivo)

**Modificados**
- `src/app/api/eec/commands/route.ts` — autenticación + rate-limit + tamaño + identidad forzada
- `src/app/api/eec/agents/route.ts` — observabilidad declarado/observado + ejecuciones
- `src/lib/eec/boot.ts` — registro de adaptadores reales + reconciliación post-boot
- `src/lib/eec/domain/types.ts` — `UNRECONCILED` + `RUN_TRANSITIONS` + provider `LIFECYCLE`
- `src/lib/eec/commands/registry.ts` — `manifest` en agent.register, `input` en task.start
- `src/lib/eec/commands/handlers/agent-handlers.ts` — manifiesto obligatorio para providers reales + health check real en start
- `src/lib/eec/commands/handlers/task-handlers.ts` — claim atómico + input + cancelación de procesos
- `src/lib/eec/engine/workers.ts` — tarea → FAILED cuando su run falla (bug V1)
- `src/lib/eec-client.ts` + `src/components/eec/shell.tsx` + `agent-inspector.tsx` — 401→login, sección de observabilidad
- `package.json` — scripts `test`, `test:acceptance`, `test:v2`, `test:api-security`, `pilot`
- `.env.example`, `README.md`
