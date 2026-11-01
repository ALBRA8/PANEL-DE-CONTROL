# EEC V2 — 07. Adaptación del ecosistema ALBRA8: qué tomar de DESPACHO-JURIDICO (y qué no)

Fecha: 2026-11-01 · Rama: `feature/v2-adaptacion-verticales` (base `main` @ `2355735`) · Autor: constructor EEC V2
Fuente analizada: `ALBRA8/DESPACHO-JURIDICO` @ `d839eb0` (shallow clone leído localmente; Python 3.10+, 1072 tests, V2.5)

---

## 0. Tesis

**El EEC es la plataforma horizontal; DESPACHO-JURIDICO es un vertical.** El despacho administra casos jurídicos; el EEC administra *el entorno global de agentes* (identidad, contratos, runtimes, ejecución, aprobaciones, evidencia, observabilidad, multi-tenancy). Cualquier patrón del despacho que sea **transversal** pertenece al EEC; cualquier patrón **jurídico** se queda en el vertical.

Esta no es una opinión nuestra: es la decisión `DJ-002` del propio despacho (*"mantener el ADN universal separado del conocimiento jurídico"*) y su guía `DJ-004` para un futuro **agente contador**. El ecosistema ALBRA8 ya declaró que habrá varios verticales. Consecuencia arquitectónica directa:

```
                    ┌──────────────────────────────────────────┐
                    │  INSTALADOR (ciclo de vida/provisioning) │
                    └───────────────┬──────────────────────────┘
                                    │ registra / provisiona
                    ┌───────────────▼──────────────────────────┐
                    │   EEC — PANEL-DE-CONTROL (horizontal)    │
                    │  contratos · pipeline · aprobaciones     │
                    │  evidencia · auditoría · scheduler       │
                    │  handoffs · eval · tenancy · medición    │
                    └───┬──────────────┬──────────────┬────────┘
             contrato+  │              │ contrato+    │ contrato+
             adaptador  │              │ adaptador    │ adaptador
        ┌───────────────▼──┐  ┌────────▼───────┐  ┌───▼────────────┐
        │ DESPACHO-JURIDICO│  │ AGENTE-GENERAL │  │ CONTADOR (fut.)│
        │ vertical legal   │  │ seed/host      │  │ vertical fiscal│
        └──────────────────┘  └────────────────┘  └────────────────┘
```

Regla de oro: **el despacho pasa a ser consumidor del EEC (contrato + adaptador), no fuente de lógica horizontal.** Adoptamos patrones clean-room (como hizo ellos con sus 27 referentes), nunca código: el gemelo es Python y el EEC es TypeScript.

## 1. Método

- Lectura directa del código del gemelo (`albra/audit`, `albra/evidence`, `albra/handoffs`, `albra/identity/oidc`, `albra/marketplace`, `albra/eval`, `albra/reasoning`, `albra/matters`, `albra/scheduling`, `albra/whitelabel`, `albra/mcp`, `src/adapters`, `src/harness`, `CONTEXTO JURIDICO/*`).
- Veredictos: **ADOPTAR** (trasladar el patrón al EEC genérico), **ADAPTAR** (tomar la idea, reformularla a contratos EEC), **RECHAZAR** (es dominio jurídico o conflicta la arquitectura), **DIFERIR** (útil, pero después del piloto E2E).
- Mapeo contra artefactos reales del EEC: `src/lib/eec/domain/contracts.ts`, `prisma/schema.prisma` (37 modelos), `docs/EEC-V2/01..06`, pipeline `VALIDATION→AUTHORIZATION→POLICY→DISPATCH`.
- Honestidad: el gemelo declara CI verde y auditorías propias; **no hemos ejecutado sus tests** ni verificamos sus claims. Lo que adoptamos se re-implementa y se prueba en el EEC con nuestros criterios.

## 2. Matriz completa módulo a módulo

### 2.1 Bloque V2.0 — base del despacho

| # | Módulo del gemelo | Qué es (verificado en código) | Veredicto | Mapeo al EEC | Fase V2 |
|---|---|---|---|---|---|
| 1 | **Matters** — state machine monótona de 8 estados, transiciones forward-only con UNA retrocesión explícita ("retrabajo tras rechazo"), terminal no retornable (`matters/matter.py`) | ADAPTAR | Ya tenemos `TASK_TRANSITIONS` validadas server-side; adoptar 2 ideas: (a) **monotonía explícita** documentada por transición con su motivo, (b) **estados terminales no retornables** en RUN/TASK. NO cambiar nuestros estados — solo endurecer el contrato | 5 (ciclo de vida) |
| 2 | **Agent Organigrama** — 5 agentes definidos en Markdown + YAML frontmatter (`agents/definitions/*.md`) | ADAPTAR | Definición declarativa de agentes como **artefacto versionable**: el EEC ya tiene `AgentInterface` en código; añadir un formato de manifiesto (YAML/MD) que el INSTALADOR pueda registrar sin recompilar, validado contra el contrato | 2 (contratos) |
| 3 | **Citation Audit** — gate *cite-or-refuse* fail-closed: si la afirmación legal no tiene cita de fuente oficial → se niega la emisión (`evidence/cite_gate.py`) | **ADOPTAR (eje #1)** | Generalizar a **Evidence Gate**: "claim-or-refuse" para toda salida de agente/tool. Ver §3.2 | 2+4 (contratos+seguridad) |
| 4 | **Approval Chain** — suggest→prepare→approve→execute→record con `minimum_human_signoff` por acción (`matters/store.py`: campo entero por acción) | **ADOPTAR (eje #1)** | `Approval` hoy tiene `risk` binario de decisión; añadir `minimumHumanSignoff Int @default(1)` + quórum verificado en pipeline (N firmas humanas distintas antes de dispatch) | 4 (seguridad) |
| 5 | **Matter Audit** — JSONL **hash chain SHA-256 tamper-evident** (`audit/tamper_evident.py`): `prev_hash` + `this_hash` por entrada, `verify_chain()`, `fingerprint()` | **ADOPTAR (eje #1)** | `AuditRecord` ya es append-only con `prevAuditId` (cadena referencial). Añadir **cadena hash criptográfica** (`prevHash`/`thisHash`), verificación incremental y endpoint/vista de verificación. Ver §3.1 | 4 (seguridad) |

### 2.2 Bloques V2.1–V2.2 — hardening y documentos

| # | Módulo | Qué es | Veredicto | Mapeo al EEC | Fase |
|---|---|---|---|---|---|
| 6 | **DeadlineGuard** — 12 términos procesales colombianos | RECHAZAR como módulo; **ADAPTAR el motor** | Lo jurídico (prescripción, tutela) es del vertical. El EEC ofrece **motor genérico de plazos/SLA**: tipos de término parametrizables + evento `deadline_near` + escalamiento a notificación/tarea bloqueada. `Task.dueAt` ya existe; falta el vigilante | 5 (ciclo de vida) |
| 7 | **ContradictionGuard** — detección de contradicciones en cláusulas | RECHAZAR | Dominio jurídico puro. Su *espíritu* (validadores de dominio post-generación) se expresa como **tool de validación registrada** que un vertical enchufa, no como código EEC | — |
| 8 | **AgenticCitator / Citation Graph** — 8 treatment labels, grafo SQLite de citas | RECHAZAR | Jurídico. El patrón grafo-relacional de referencias entre artefactos ya lo cubre `Artifact` + relaciones; no duplicar | — |
| 9 | **Redline DOCX + Tabular Review** — tracked changes XML, comparación N-doc × M-cláusulas | RECHAZAR | Es capacidades del vertical legal (posible skill futura *a través* del EEC). El EEC solo garantiza que `Artifact` persista y audite | — |
| 10 | **RAG Local (TF-IDF puro)** | DIFERIR | `KnowledgeInterface` ya define query/hit. Implementar retrieval es del runtime del agente, no del plano de control. Re-evaluar cuando AGENTE-GENERAL necesite recall sobre `KnowledgeItem` | — |
| 11 | **Adversarial Pipeline RED→BLUE→MAGISTRADO** — el sistema ataca su propio draft con roles estructurados y *ruling* determinístico antes de "file" (`reasoning/adversarial_pipeline.py`) | **ADAPTAR** | Patrón **revisión adversarial pre-dispatch** para ejecuciones HIGH risk en el EEC: antes de ejecutar una acción crítica, un paso de orquestación genera contraargumentos/riesgos y un "juez" determinístico (reglas, no LLM) puntúa; score < umbral → `blocked` + Approval obligatoria. Encaja como *policy check* en el pipeline, no como vista nueva | 4 (seguridad) |
| 12 | **Playbooks** (5 áreas jurídicas en Markdown) | RECHAZAR el contenido; ADAPTAR el formato | Los playbooks jurídicos son del vertical. El formato "proceso declarado en Markdown/YAML versionado que instancia Workflows del EEC" es adoptable cuando `Workflow` soporte definición declarativa | — |

### 2.3 Bloques V2.3–V2.4 — infraestructura

| # | Módulo | Qué es | Veredicto | Mapeo al EEC | Fase |
|---|---|---|---|---|---|
| 13 | **Eval Suite** — rúbricas `essential/forbidden/bonus` + test de citas fantasma (100% TPR/TNR) (`eval/rubrics.py`, `eval/runner.py`, `eval/phantom_citations.py`) | **ADAPTAR** | **Eval harness genérico** para agentes del EEC: rúbricas declarativas por tarea (criterios esenciales/prohibidos/bonus) + **casos adversariales sintéticos** (el "phantom citation test" generaliza a "el agente no debe aceptar evidencia inexistente"). Corre en el piloto E2E como gate de calidad | 6 (piloto) |
| 14 | **MCP Server** — 10 tools vía stdio JSON-RPC 2.0 + HTTP con OAuth scaffold (`mcp/server.py`) | DIFERIR con diseño | Dos usos futuros: (a) **tipo de runtime `mcp`** para agentes externos (tercer runtime además de `local-process` y `http`), (b) **fachada MCP del EEC** para operar el panel desde IDEs. Requiere primero seguridad real (§2.4 #16). Post-piloto | post-piloto |
| 15 | **Citation Graph / Corpus V1.2 / IngestionCoordinator** — fetch con provenance SHA-256 por artículo | RECHAZAR contenido; ADAPTAR provenance | El corpus es jurídico. La **cadena de provenance** (fuente → fetch → hash → registro) es el mismo patrón del Evidence Gate: toda evidencia lleva `source`, `hash`, `fetchedAt`, `verifiedAt`. Una sola implementación en el EEC | 2+4 |
| 16 | **LLM Providers + Router con fallback** (Mock/Anthropic/OpenAI/Ollama) | ADAPTAR | Ya tenemos `providerRegistry` y honestidad simulada. Adoptar el patrón **fallback explícito en cadena** (primario→secundario→mock etiquetado `simulated:true`) y health-check por provider — nunca fallback silencioso a mock en producción | 3 (runtimes) |
| 17 | **Scheduled Agents** — triggers event-driven (`matter_created`, `state_change`, `deadline_near`, `approval_pending`) + time-based (`DAILY_AT`, `INTERVAL`) (`scheduling/scheduler.py`) | **ADOPTAR** | `Schedule` hoy solo es cron. Añadir **triggers por evento del bus**: reglas `on(event).when(cond).then(command)` auditadas como `CommandRecord`. Es automatización del plano de control, no lógica de negocio | 5 (ciclo de vida) |
| 18 | **Memory Cell** — recall cross-matter con TF-IDF | DIFERIR | `MemoryInterface` + `MemoryRecord` ya existen con búsqueda; el recall semántico es mejora del runtime, no del plano de control | — |
| 19 | **Precedent Board** — promoción `tentative→confirmed` en 5 estados | ADAPTAR | Patrón **gobernanza de conocimiento**: conocimiento derivado por agentes (resúmenes, decisiones) nace `tentative` y un humano/flujo lo promueve a `confirmed`. Aplica a `KnowledgeItem.status` — evita que el agente autovalide su propio conocimiento | 5 |

### 2.4 Bloque V2.5 — comercial + módulos extra observados en código

| # | Módulo | Qué es | Veredicto | Mapeo al EEC | Fase |
|---|---|---|---|---|---|
| 20 | **Skills Marketplace** + Install Log (hash chain de instalaciones) | DIFERIR | El catálogo de skills con instalación auditable encaja con `Tool`/capacidades, pero el marketplace es producto post-piloto. El Install Log usa el MISMO hash chain del eje #1 — una sola primitiva | post-piloto |
| 21 | **White-label multi-tenant** — tenant + branding + feature flags + license (`whitelabel/tenant.py`) | ADAPTAR | El EEC ya tiene `Organization` como raíz. Añadir **feature flags por organización** (columna JSON en `Organization` o tabla `FeatureFlag`) y que toda vista/API respete flags. El branding es UI del vertical | post-piloto |
| 22 | **X402 Paid-Agent** — service matrix + usage records + ciclos de facturación USDC | RECHAZAR (billing USDC); ADAPTAR metering | La medición ya existe (`ToolInvocation` con coste). Añadir **agregación de usage por organización/agente** (vistas de coste). Settlement cripto: NO — decisión de negocio, no de arquitectura, y hoy sería funcionalidad no verificable | post-piloto |
| 23 | **Identity OIDC** — validator JWKS, role_map, tenant_map, audit de eventos de identidad (`identity/oidc/*`, ~1000 líneas) | **ADAPTAR (diseño, no código)** | V2 lo exige: identidad derivada de sesión verificada, no del cliente. El gemelo valida: (a) separación issuer/tenant/role en claims, (b) eventos de auditoría para cada verificación, (c) mapa explícito rol↔permisos. Adoptar el **diseño del pipeline**; la implementación depende de tener un IdP real (INSTALADOR) — sin IdP, mantener el boundary seguro actual documentado en `04-SEGURIDAD.md` | 4 (seguridad) |
| 24 | **Handoffs** — `HandoffEnvelope` (protocol vs transport) con `permissions`, `evidence_ids`, `audit_trail`, `confidence` por envelope; transports in-process/mock/HTTP-futuro (`handoffs/protocol.py`) | **ADOPTAR** | Es la pieza que falta entre `OrchestrationInterface` y agentes especializados: **contrato de traspaso agente→agente** con evidencia adjunta y permisos escalados. Se implementará sobre nuestro bus de eventos con `correlation_id`/`causation_id` ya presentes. Transport in-process primero; HTTP con service-auth después | 2 (contratos) |
| 25 | **GeneralAdapter / Harness** — "el agente intercambiable se monta sobre el arnés; si se va, conocimiento, bridges y skills se quedan" (`src/adapters/general_adapter.py`) | CONFIRMAR (ya lo tenemos) | Nuestro AGENTE-GENERAL ya sigue este principio (seed/host sin superpoderes). El adapter del gemelo lo confirma como patrón correcto del ecosistema: conocimiento en el arnés (CONTEXT/registry), agente reemplazable por contrato | — |
| 26 | **Doctor** — autodiagnóstico del sistema | ADAPTAR | Comando/vista "Doctor" en Sistema: verifica BD (integridad — aprendido de la corrupción real de `custom.db`), proveedores, sockets, cadena de auditoría, schedules caídos. Diagnóstico honesto con estado observado | 6 |
| 27 | **Event Bus** (`events/bus.py`) + **Resilience** + **Comms adapters** | Paridad | Nuestro bus ya tiene correlation/causation/idempotencia. Resilience del gemelo (reintentos/circuit breaker) revisar contra nuestros reintentos finitos del ciclo de vida V2 | — |

## 3. Eje #1 en detalle: Evidencia + Auditoría tamper-evident

Prioridad elegida: es el patrón del gemelo con más valor transversal y el que más refuerza la promesa V2 ("ejecución **verificable**").

### 3.1 Cadena de auditoría con hash (AuditChain)

Estado actual: `AuditRecord` es append-only con `prevAuditId` — cadena **referencial** (dice quién va antes, pero no detecta edición silenciosa).

Cambio propuesto (mínimo, no rompe nada):

```prisma
model AuditRecord {
  // ...campos actuales...
  prevAuditId    String?   // semántica actual: correcciones apuntan al previo
  prevHash       String?   // hash del registro anterior de la cadena GLOBAL
  thisHash       String?   // SHA-256(canonicalJson(this − thisHash) + prevHash)
  chainSeq       Int?      // consecutivo de cadena (para verificación incremental)
  @@index([chainSeq])
}
```

- Hash canónico: JSON estable (`sort_keys`, sin `thisHash`), UTF-8, SHA-256 — misma idea del gemelo, implementación TS.
- Escritura: el motor de comandos sella cada `AuditRecord` al final del DISPATCH (un solo punto, atómico con el insert).
- Verificación: endpoint `GET /api/eec/audit/verify?from=<seq>&to=<seq>` → `{ok, verified, brokenAt[]}`; la vista **Sistema** muestra badge "cadena verificada ✔ / rota ✘ / no verificada (desconocido)" — coherente con nuestra regla de mostrar *declarado vs observado*.
- Reparación honesta: si hay cadena rota histórica (p. ej. por la corrupción real de BD que ya sufrimos), se documenta el punto de quiebre; **nunca se re-escribe** el pasado: se sella un nuevo registro de tipo `CHAIN_SEAL` que declara el nuevo génesis.
- No aplicamos su formato JSONL: nuestra cadena vive en SQLite donde ya vive la auditoría; el JSONL sería una segunda fuente de verdad.

### 3.2 Evidence Gate genérico (claim-or-refuse)

El gate del gemelo niega afirmaciones legales sin cita oficial. Generalización para el EEC (el dominio define qué es "fuente aceptable"):

1. **Contrato**: `ToolExecutionOutput` y el resultado de tarea llevan `evidence: EvidenceRef[]` con `{id, source, kind, hash, verifiedAt}`. Nuevo tipo en `contracts.ts` (aditivo).
2. **Política**: `Policy` por riesgo — una salida con riesgo HIGH que contenga afirmaciones exigentes (marcadas por el vertical con `claimTags`, p. ej. `legal-assertion`) y sin ≥1 evidencia `verified` → **fail-closed**: la salida se marca `BLOCKED_MISSING_EVIDENCE`, no se publica, se crea `Approval` opcional y evento `EVIDENCE_MISSING`.
3. **Neutralidad**: el EEC no sabe de leyes ni artículos; solo de evidencias verificadas por hash y reglas de política. El despacho registrará sus fuentes oficiales como `KnowledgeItem`/`Artifact` con provenance; el contador, las suyas.
4. **Anti-alucinación testable**: al estilo del phantom-citation test del gemelo, el piloto E2E incluye un caso adversarial: agente cita evidencia inexistente → el gate DEBE bloquear (TPR) y evidencia real verificada DEBE pasar (TNR).

### 3.3 Quórum humano (minimum_human_signoff)

- `Approval` gana `minimumHumanSignoff Int @default(1)`.
- El pipeline de aprobación cuenta **firmas de sujetos distintos** (`decidedById` únicos) hasta el quórum; sin quórum, el command permanece `awaiting-approval`.
- Políticas de riesgo alto del EEC (ejecutar tool HIGH, transición crítica) declaran quórum 2 por defecto en seed de `Policy` — configurable por organización.

## 4. Roadmap integrado a V2 (orden profesional decidido)

| Orden | Ítem (de la matriz) | Fase V2 | Entregable verificable |
|---|---|---|---|
| P0-1 | Cadena hash en `AuditRecord` (§3.1) | 4 seguridad | tests de tamper + endpoint verify + badge en Sistema |
| P0-2 | Evidence Gate genérico (§3.2) | 2+4 | contrato `EvidenceRef` + policy fail-closed + test anti-fantasma |
| P0-3 | `minimumHumanSignoff` (§3.3) | 4 | test de quórum (2 firmas distintas) en pipeline |
| P1-1 | Contrato `HandoffEnvelope` adaptado (#24) | 2 | contrato + test de traspaso con evidencia adjunta |
| P1-2 | Triggers por evento en `Schedule` (#17) | 5 | regla `on(deadline_near)` crea tarea + evento auditable |
| P1-3 | Revisión adversarial pre-dispatch (#11) | 4 | policy check determinístico con score, test de bloqueo |
| P2-1 | Eval harness con rúbricas (#13) | 6 | runner de rúbricas en piloto E2E |
| P2-2 | Doctor del sistema (#26) | 6 | vista Sistema con verificaciones reales |
| P2-3 | Provenance de evidencia (#15) | 2+4 | campos hash/source/verifiedAt en evidencias |
| P3 (post-piloto) | MCP runtime type (#14), feature flags por org (#21), usage records (#22), marketplace (#20) | — | diseño ya esbozado en esta matriz |

Enmiendas mínimas a documentos existentes: `02-CONTRATO-AGENTES.md` (añadir `EvidenceRef` + handoff), `04-SEGURIDAD.md` (AuditChain + quórum), `05-PILOTO-E2E.md` (casos adversariales), `06-MATRIZ-CAPACIDADES.md` (estado de los ítems P0-P3).

## 5. Qué NO adoptamos y por qué (explícito)

- **Contenido jurídico alguno** (corpus, términos procesales, treatment labels, playbooks legales): dominio del vertical.
- **Su implementación OAuth/OIDC scaffold**: seguridad no se "adapta" de un scaffold; o hay IdP real (vía INSTALADOR) o se mantiene el boundary documentado y honesto.
- **JSONL como almacenamiento paralelo**: SQLite es nuestra única fuente de verdad; duplicar soporte escritura sería dos realidades.
- **Billing USDC / X402**: decisión de negocio no solicitada; solo conservamos el metering genérico.
- **Su formato de 12 módulos como checklist de features**: el EEC no compite en número de módulos; compite en ser el plano de control verificable del ecosistema.

## 6. Riesgos y honestidad

1. **No ejecutamos los 1072 tests del gemelo** — adoptamos patrones observados en su código, no sus garantías.
2. **La cadena hash no prueba verdad absoluta**: prueba alteración *posterior* bajo control del archivo; un atacante con acceso a BD puede re-sellar. Mitigación futura: fingerprint externo (publicar hash periódico fuera del sistema, p. ej. en el Install Log pattern del gemelo o en INSTALADOR).
3. **Evidence Gate fail-closed puede bloquear trabajo legítimo** si el vertical no registra bien sus fuentes. Es intencional (así lo diseñó el gemelo) y debe venir con UI clara del motivo de bloqueo.
4. **Quórum multi-firma requiere identidad real de usuarios** — hoy la sesión es local; el quórum degenerado (1) sigue siendo seguro; quórum 2 exige resolver identidad primero (vinculado a #23 e INSTALADOR).
5. Este documento **no autoriza por sí mismo cambios de código** — cada ítem P0/P1 entra por la disciplina V2 (rama feature, tests, sin merge a main sin autorización explícita).
