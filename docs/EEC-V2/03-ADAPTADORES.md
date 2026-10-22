# EEC V2 — 03. Adaptadores: arquitectura y guía de creación

## Mapa de separación (§4 del mandato)

```
EEC (core) ──▶ INTERFACE (contracts.ts / agent-manifest.ts / lifecycle.ts)
                    ──▶ ADAPTER ──▶ PROVIDER (proceso local | servicio HTTP | INSTALADOR)
```

| Responsabilidad | Dónde vive | Aislada de |
|---|---|---|
| Registro y descubrimiento | `ProviderRegistry` (domain/contracts.ts) + `agent.register` | transporte |
| Validación del contrato | `contracts/agent-manifest.ts` (zod) | ejecución |
| Comprobación de salud | `adapter.health()` (spawn real o GET /health) | registro |
| Transporte | adaptador (spawn/fetch) | dominio |
| Ejecución | runtime-loop (`engine/workers.ts`) vía `AgentInterface.tick()` | UI |
| Normalización de resultados | adaptador (NDJSON → `AgentTickResult`) | persistencia |
| Persistencia y observabilidad | `ExecutionProcess` + `Artifact` + `EventRecord` + `AuditRecord` | transporte |

## Adaptadores incluidos

| Adapter | provider (clave) | Tipo | Default |
|---|---|---|---|
| `LocalSimAgentAdapter` | `local-sim` | simulación determinista (tick 18/9/7) | SÍ (solo con modo sim) |
| `LocalProcessAgentAdapter` | `local-process` | **proceso real** (spawn, stdin, NDJSON, timeout, cancel, evidencias) | NO (requiere manifiesto) |
| `HttpAgentAdapter` | `http-agent` | **servicio HTTP real** (/executions, bearer, timeouts) | NO (requiere manifiesto) |
| `LocalOrchestratorAdapter`/`LocalRuntimeAdapter`/`BuiltinToolsAdapter` | `local`/`builtin` | herencia V1 | SÍ |
| `HttpInstaladorAdapter` | `instalador-http` | frontera INSTALADOR activa (requiere `EEC_INSTALLADOR_URL`) | condicional |
| `UnavailableInstaladorAdapter` | `instalador-unavailable` | frontera honesta "no disponible" | SÍ |

**Regla anti-simulación silenciosa (§4):** los adaptadores reales NO son default; un agente registrado con provider real exige manifiesto válido; un agente con provider `local-sim` sigue marcado como `SIMULADO` en toda la observabilidad. El panel distingue `provider: REAL | SIMULADO | DESCONOCIDO`.

## Protocolo de agente LOCAL_PROCESS

- **Entrada**: JSON por **stdin** (nunca por argv/shell — la entrada de una tarea jamás se convierte en comandos):
  `{ "eec":"task.input/v1", "runId":…, "taskId":…, "agentId":…, "input":{…}, "limits":{"timeoutMs":…} }`
- **Progreso** (cualquier número de líneas): `{"type":"progress","progress":0-100,"node":"…","activity":"…"}`
- **Resultado final** (última línea): `{"type":"result","ok":true,"output":{…}}` + exit code 0.
- **Fallo**: exit ≠ 0 y/o `{"type":"result","ok":false,"error":"…"}`.
- **Cancelación**: SIGTERM → el agente debe terminar ≤3s (el EEC escala a SIGKILL).
- **Health**: ejecución puntual con `runtime.healthArgs`; salud = exit 0 + `{"eec":"healthy"}` en stdout.
- Líneas no-JSON se conservan en la evidencia stdout pero no son protocolo.

## Protocolo de agente HTTP_SERVICE

```
POST   {endpoint}/executions          → 201 { executionId }
GET    {endpoint}/executions/{id}     → 200 { state: PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED, progress, node?, activity?, output? }
DELETE {endpoint}/executions/{id}     → cancelación (mejor esfuerzo; el servicio puede no soportarla)
GET    {endpoint}/health              → 200
```
Autenticación: `Authorization: Bearer` con el valor de la variable `runtime.tokenEnv`. Respuestas no-JSON o sin `executionId`/`state` → error explícito `malformed_response`.

## Seguridad del adaptador de proceso (§4, checklist completa)

- Ejecutable y args **explícitos del manifiesto**; resueltos por realpath y validados contra `EEC_ALLOWED_EXECUTABLES` (default: el propio runtime del EEC).
- `workdir` validado contra `EEC_ALLOWED_WORKDIRS` (prefix-resolución; `../../etc` rechazado).
- **Sin shell**; stdin JSON; env mínimo del hijo (`PATH/HOME/LANG` + secretos declarados por `secretRef` — el entorno del EEC no se filtra).
- Timeout del manifiesto → SIGKILL → run `FAILED` con `timeout_after_…ms` (nunca resultado inventado).
- Salidas capturadas, **redactadas** (`redactSecrets`: patrones `sk-…`, `ghp_…`, claves privadas, `Bearer …`, + secretos activos del entorno) y persistidas como `Artifact` (`metadataJson.redacted=true`).
- Distinción persistente por ejecución: `SPAWNED → ALIVE → EXITED|KILLED|TIMEOUT|SPAWN_FAILED|UNRECONCILED` (+ `pid`, `exitCode`, `signal`, `durationMs`, artifact ids).

## Cómo crear un nuevo adaptador (guía)

1. Crea `src/lib/eec/providers/adapters/mi-transporte.ts` implementando `AgentInterface` (`providerKey` propio + `tick(ctx)` + `health(agentId)` opcional pero recomendado).
2. `tick()` debe ser **idempotente por tick y sin estado global salvo el handle del run**: primera llamada → iniciar; siguientes → sondear; final → `done:true` con `outputs` o `error`.
3. Regístralo en `src/lib/eec/boot.ts` (NO como default):
   ```ts
   if (!providerRegistry.list('AGENT').some(p => p.key === 'mi-transporte')) {
     providerRegistry.register('AGENT', 'mi-transporte', new MiTransporteAdapter(), { adapter: 'MiTransporteAdapter' })
   }
   ```
4. Si necesita configuración, añádela a `AgentManifestSchema` (contrato versionado: sube MINOR, nunca rompas MAYOR sin `SUPPORTED_MAJOR` nuevo).
5. Añade su `providerKind` en `GET /api/eec/agents` (`observability.providerKind`) para la UI.
6. Pruebas mínimas: health real, ejecución ok, fallo (exit≠0 / respuesta malformada), timeout, cancelación, y que sin manifiesto se rechaza. Ejemplo de referencia: `tests/eec-v2/local-process.real.test.ts`.

## Frontera INSTALADOR (§7)

Contrato `InstaladorInterface` (versión `eec.instalador/1.0.0`, header `x-eec-contract`, correlación `x-eec-correlation-id`):

```
GET    {EEC_INSTALLADOR_URL}/api/v1/managed                          → { refs: [{ref, kind, state?}] }
GET    {EEC_INSTALLADOR_URL}/api/v1/managed/{ref}                    → { state, detail? }
POST   {EEC_INSTALLADOR_URL}/api/v1/managed/{ref}/operations         → { operationId, state, verified }   body: { op, params }
```

Operaciones: `install|configure|start|stop|restart|upgrade|repair|backup|rollback|status`. Reglas:
- Autenticación `Authorization: Bearer $EEC_INSTALLADOR_TOKEN`; timeout 10s; 426 → `version_incompatible`.
- **`verified:true` solo si el INSTALADOR devuelve conclusión explícita.** Aceptar una solicitud NO es ejecutarla: el EEC registra la correlación y espera resultado verificable.
- Sin `EEC_INSTALLADOR_URL` → `UnavailableInstaladorAdapter`: toda operación responde `available:false, reason:not_configured`. El panel/API informan la limitación; jamás se declara un agente iniciado/detenido/instalado.
- El EEC no toca tablas internas del INSTALADOR ni duplica funciones de ciclo de vida.
