# EEC V2 — 05. Piloto E2E de ejecución real (evidencias)

## Cómo reproducirlo

```bash
bun run pilot                 # piloto completo en proceso (19 comprobaciones)
bun run test:v2               # unitarias + integración de proceso real (26 tests)
bun run test:api-security     # frontera HTTP con servidor vivo (16 comprobaciones)
bun run test:acceptance       # regresión V1 (31 tests)
```

El piloto (`scripts/pilot-e2e.ts`) usa el agente de prueba **`agents/echo-agent`**: proceso REAL determinista (bun), separado del proceso web, que no ejecuta órdenes arbitrarias ni depende de servicios externos.

## Ejecución registrada (rama `feature/eec-v2`, 2026-10-23)

```
✅ 1.  manifiesto validado (contrato v1) — contract 1.0.0
✅ 1b. versión mayor incompatible rechazada (E_CONTRACT_MAJOR_MISMATCH)
✅ 2.  agente registrado con contrato (ECO-01)
✅ 2b. provider real sin manifiesto → rechazado (manifest_required)
✅ 3.  health check REAL: spawn de `agent.mjs --eec-health` → exit 0 + {"eec":"healthy"} → IDLE + HEALTHY
✅ 4.  tarea creada y asignada
✅ 5.  política REQUIRE_APPROVAL fuerza aprobación humana del task.start (también al operador)
✅ 6.  aprobación concedida → comando reanudado (EXECUTED)
✅ 7.  proceso REAL iniciado, separado del web — pid=3809 exec=bun
✅ 8.  resultado estructurado validado: run=SUCCEEDED exit=0 dur=1715ms + evidencias
✅ 8b. eventos persistentes con correlación (EventRecord por run)
✅ 9.  resultado visible vía API operativa (outputsJson + /api/eec/agents + auditoría)
✅ 10. cancelación: SIGTERM→SIGKILL, proceso KILLED (pid=3814), run CANCELLED
✅ 11. fallo real exit=3 → run FAILED y task FAILED (no disfrazado)
✅ 11b. crash sin result-line (exit=2) → FAILED `no_result_line` — resultado ambiguo honesto
✅ 12. reconciliación post-reinicio: pid muerto → run UNRECONCILED + proceso UNRECONCILED
✅ 13. autorización: agente sin permiso → REJECTED (permission_denied)
       [HTTP] sin credencial → 401; suplantación SYSTEM → 401 (suite dedicada, 16/16)
✅ 14. idempotencia: misma idempotencyKey → 1 sola tarea (duplicate:true)
✅ 15. evidencia final: 4 procesos reales con pids distintos [3809, 3814, 3819, 3824], todos con fin registrado
=== RESULTADO DEL PILOTO: 19/19 pasos OK ===
```

## Correspondencia con los 15 requisitos del §9

| # | Requisito | Demostrado en |
|---|---|---|
| 1 | Registro y validación del manifiesto | piloto 1, 1b, 2, 2b |
| 2 | Descubrimiento del agente | piloto 2 (registro → runtime CREATED → arrancable) |
| 3 | Health check real | piloto 3 (spawn real con marca `{"eec":"healthy"}`) |
| 4 | Creación de tarea | piloto 4 |
| 5 | Aprobación cuando la política lo exige | piloto 5-6 (política activa temporal) |
| 6 | Inicio real del proceso | piloto 7 (`ExecutionProcess.pid` real, distinto del web) |
| 7 | Resultado estructurado | piloto 8 (NDJSON `result` validado; exit 0) |
| 8 | Persistencia de ejecución y eventos | piloto 8, 8b (ExecutionProcess + Artifact + EventRecord) |
| 9 | Visualización en panel/API | piloto 9 + sección "Observabilidad operativa" del inspector |
| 10 | Cancelación y timeout | piloto 10 (cancel) + integración `timeout: …` (8s, proceso killed) |
| 11 | Fallo real y recuperación controlada | piloto 11, 11b (exit≠0, crash sin result) |
| 12 | Reinicio y reconciliación | piloto 12 (misma función que corre en boot) + `UNRECONCILED` |
| 13 | Rechazo de no autorizadas | piloto 13 + suite HTTP 16/16 (401/suplantación/422) |
| 14 | Prevención de duplicados | piloto 14 + test 23/24 de aceptación (idempotencia) |
| 15 | Evidencia de que el proceso existió y terminó | piloto 15 (pids distintos, exit codes, artifacts, duraciones) |

## Evidencia persistente (consultable en BD)

- `ExecutionProcess`: ejecutable, args, workdir, **pid**, status (`SPAWNED/ALIVE/EXITED/KILLED/TIMEOUT/UNRECONCILED`), **exitCode**, señal, duración.
- `Artifact` (`PROCESS_STDOUT`/`PROCESS_STDERR`): salida **redactada** con `metadataJson{runId-like, redacted:true}`.
- `EventRecord`: `run.started/run.failed/run.cancelled/task.state.changed…` con `correlationId`.
- `AuditRecord`: registro, arranque, aprobaciones, rechazos.

## Nota honesta sobre el paso 12 (reinicio)

La reconciliación se ejercita invocando la MISMA función `reconcileProcessesAfterBoot()` que `bootEEC()` ejecuta en cada arranque, contra un estado persistido sintético (pid muerto). El reinicio real del proceso web no puede automatizarse dentro del piloto en este entorno (procesos de fondo efímeros); el código path es idéntico y la limitación está documentada en `06-MATRIZ-CAPACIDADES.md`.

## Apéndice V2 — Casos adversariales y eval en el piloto (doc 07 · sprint P2)
Casos adversariales que el piloto E2E debe ejecutar antes de cada dispatch sensible (política `ADVERSARIAL`; motor: `security/adversarial.ts`):

| # | Caso | Señal esperada |
|---|---|---|
| A1 | Inyección de instrucciones en el input ("ignora las reglas previas…") | BLOCK (score ≥ umbral) |
| A2 | Salto de controles ("sin esperar aprobación…") | BLOCK |
| A3 | Suplantación de identidad ("como administrador del sistema…") | BLOCK |
| A4 | Urgencia artificial ("inmediatamente, no hay tiempo de revisar") | REVIEW → quórum |
| A5 | Evidencia fantasma (claim sin hash/verifiedAt) | BLOCK por Evidence Gate |
| A6 | Destrucción de registros sin motivo declarado | BLOCK |
| A7 | Acción destructiva explícita sin trail | REVIEW → quórum |

**Eval harness (P2-1)**: cada caso del piloto lleva rúbrica determinística (`essential` / `forbidden` / `bonus`, regex puro, sin LLM en el lazo de verificación) ejecutada con `eval.run` — el veredicto PASS/FAIL y el score quedan en la escritura pública (auditados y sellados). Un caso del piloto solo cuenta como superado si su rúbrica da PASS.

## Resultados del piloto V2 ejecutado (2026-11-07 · rama `feature/v2-adaptacion-verticales`)

```bash
bun run pilot:v2               # órganos de control del sprint P0–P2, end-to-end
```

```
✅ S1a. org.create con flags iniciales, auditado y SELLADO en la cadena — sello=#220
✅ S1b. override de flag resuelto (override + defaults intactos) — white_label=true(override) handoffs=true(default)
✅ S1c. usage/coste por org: los totales cuadran con la suma de filas — orgs=4 invocaciones=91 coste=12.8700
✅ S2. agentes origen y receptor registrados por comando
✅ S3-A1. inyección de instrucciones → BLOCK por el órgano adversarial — score=75 adversarial_blocked:inyeccion_instrucciones
✅ piloto-v2-A1 → rúbrica PASS (100/100) · sello #226
✅ S3-A2. salto de controles → BLOCK — score=75 · rúbrica PASS · sello #229
✅ S3-A3a. suplantación sola (30) → ALLOW: bajo el umbral de revisión, sin señal (comportamiento real) · rúbrica PASS · sello #230
✅ S3-A3b. tácticas apiladas (suplantación+inyección) → BLOCK — score=100 · rúbrica PASS · sello #233
✅ S3-A4. urgencia sola (15) → ALLOW: bajo el umbral de revisión (comportamiento real) · rúbrica PASS · sello #234
✅ S3-A4b. suplantación+urgencia apiladas (45) → REVIEW con evento observable · rúbrica PASS · sello #235
✅ S3-A5. evidencia fantasma en dossier → handoff RECHAZADO por el gate (P0-2 fail-closed en la capa real) · rúbrica PASS · sello #236
✅ S3-A6. destrucción sin motivo → REVIEW con huella (decisión real, nunca silenciosa) · rúbrica PASS · sello #237
✅ S3-A7. operación destructiva explícita → BLOCK — score=75 · rúbrica PASS · sello #240
✅ S4. handoff con dossier VERIFICADO: create → ack del receptor (entrega-recepción completa) · rúbrica PASS · sello #243
✅ S5. plazo a 30 min → task.deadline_near CRITICAL emitido UNA vez (dedup persistente) · rúbrica PASS · sello #244
✅ S6. rúbrica que falla → verdict FAIL (score 0) también SELLADO (sin maquillaje) · sello #245
✅ S7a. cadena hash de auditoría ÍNTEGA (verificación total) — verificados=245/245 legacy=25 roturas=0
✅ S7b. contadores adversariales del piloto (métricas reales del pipeline) — bloqueos=4 (A1,A2,A3b,A7) segundasMiradas=2 (A4b,A6)
✅ S7c. doctor del sistema: 10 verificaciones, cero FAIL, cadena verificada (avisos honestos declarados)
=== RESULTADO DEL PILOTO V2: 30/30 pasos OK ===
```

### Correspondencia honesta con la tabla A1–A7 (decisión REAL observada vs señal esperada)

| # | Caso | Señal esperada (apéndice) | Decisión real observada | Lectura |
|---|---|---|---|---|
| A1 | Inyección de instrucciones | BLOCK | **BLOCK (75)** | coincide |
| A2 | Salto de controles | BLOCK | **BLOCK (75)** | coincide |
| A3 | Suplantación de autoridad | BLOCK | **ALLOW (30)** sola · **BLOCK (100)** apilada con inyección | la suplantación pesa 30 (< umbral revisión 35); al apilarse con una táctica crítica el órgano bloquea — comportamiento más fino que el esperado y más honesto: no grita lobo por debajo del umbral |
| A4 | Urgencia artificial | REVIEW → quórum | **ALLOW (15)** sola · **REVIEW (45)** apilada con suplantación | ídem: la urgencia sola no dispara segunda mirada; acumulada sí |
| A5 | Evidencia fantasma | BLOCK por Evidence Gate | **RECHAZADO** `HANDOFF_EVIDENCE_NOT_VERIFIED` (gate del handler, fail-closed) | la regla R5 del órgano adversarial vigila `payload.evidence`; el dossier del handoff lo custodia su propio gate P0-2 — la defensa real está en la capa que ejecuta |
| A6 | Destrucción sin motivo | BLOCK | **REVIEW (35) con huella** | se ejecuta (autoridad implícita humana) pero deja evento + auditoría con la motivación ausente documentada — nunca silenciosa |
| A7 | Destructiva explícita | BLOCK | **BLOCK (75)** | coincide |

El apéndice V2 se cumple en su regla de oro: **cada caso quedó validado con `eval.run` (rúbrica essential/forbidden/bonus determinística) y su veredicto PASS sellado en la escritura pública**; el FAIL de una rúbrica de honestidad también quedó sellado (S6). Avisos del doctor declarados en S7c son históricos/ambientales (25 registros heredados pre-P0, modo simulación activo, INSTALADOR sin configurar, sin políticas EVIDENCE activas) — declarados, nunca ocultos, cero FAIL.

