# EEC V2 — 02. Contrato común de agentes (especificación v1.0.0)

Fuente canónica: `src/lib/eec/contracts/agent-manifest.ts` (esquema zod `AgentManifestSchema`).
Ejemplos ejecutables: `agents/echo-agent/manifest.json` (proceso real) y `EXAMPLE_HTTP_MANIFEST` (servicio HTTP).

## Filosofía

Un contrato **versionado, explícito y validable** para incorporar agentes heterogéneos (proceso local, servicio HTTP u otro transporte soportado) sin una integración a medida por agente. Normaliza la comunicación y el control; **no** uniforma la tecnología interna del agente.

Lo **DECLARADO** (manifiesto) nunca se presenta como **OBSERVADO** (salud/ejecución). Son campos distintos en toda la interfaz y en el panel.

## Esquema del manifiesto (v1)

```jsonc
{
  "contractVersion": "1.0.0",          // semver; MAYOR incompatible → E_CONTRACT_MAJOR_MISMATCH
  "identity": {
    "code": "ECO-01",                   // estable, [A-Z0-9-_], debe coincidir con agent.register
    "name": "Agente Eco", "version": "1.0.0", "owner": "ALBRA8",
    "description": "…"
  },
  "source": { "repo": "ALBRA8/…", "release": "tag o ruta" },
  "platform": { "os": "linux", "requirements": ["bun >= 1.0"] },
  "runtime": {
    "type": "LOCAL_PROCESS",            // o "HTTP_SERVICE"
    "executable": "bun",                // resuelto y validado contra allowlist del EEC
    "args": ["agents/echo-agent/agent.mjs"],
    "workdir": "/home/z/my-project",    // validado contra allowlist de directorios
    "healthArgs": ["agents/echo-agent/agent.mjs", "--eec-health"]
  },
  "capabilities": [
    { "op": "echo.work", "risk": "LOW", "requiresApproval": false, "description": "…" }
  ],
  "config": [ { "name": "MI_TOKEN", "secretRef": "MI_TOKEN", "required": true } ], // SOLO referencias
  "limits": { "timeoutMs": 60000, "maxRetries": 0, "idempotent": false },
  "health": { "intervalMs": 60000 }
}
```

## Reglas de validación (aplicadas en `validateManifest` y probadas)

- Sintaxis estricta zod; errores enumerados por ruta (`identity.code: …`).
- **Compatibilidad por MAYOR**: `contractVersion` 2.x se rechaza explícitamente con `E_CONTRACT_MAJOR_MISMATCH` (sin interpretación best-effort de contratos desconocidos).
- `limits.maxRetries > 0` exige `limits.idempotent = true` (§5: no repetir operaciones externas no idempotentes).
- `identity.code` del manifiesto debe coincidir con el `code` del registro (`manifest_identity_mismatch`).
- Los secretos NUNCA van en el manifiesto: solo `secretRef` (nombre de variable de entorno).

## Registro y prueba de un agente (guía)

1. **Empaqueta tu agente** como ejecutable con protocolo NDJSON en stdout (proceso local) o API `/executions` (HTTP). Ver protocolo en `03-ADAPTADORES.md`.
2. **Escribe el `manifest.json`** (copia `agents/echo-agent/manifest.json`).
3. **Regístralo** (la validación ocurre ANTES de crear la entidad; un manifiesto inválido rechaza el registro y queda auditado):

```bash
curl -X POST /api/eec/commands -H "Authorization: Bearer $EEC_API_TOKEN" \
  -d '{"type":"agent.register","payload":{
        "code":"ECO-01","name":"Agente Eco","role":"Tester",
        "provider":"local-process","capabilities":[],"skills":[],"clearance":"INTERNAL",
        "manifest": <contenido de manifest.json> }}'
```

4. **Arranca** (dispara health check REAL por spawn; si falla, el agente queda `OFFLINE/UNHEALTHY` y el comando falla — no se simula conexión):

```bash
curl -X POST /api/eec/commands … -d '{"type":"agent.start","payload":{"code":"ECO-01"}}'
```

5. **Úsalo**: `task.create` + `task.assign` + `task.start` con `input` estructurado. El EEC lo elegirá por su `provider` y ejecutará el proceso real.
6. **Obsérvalo**: panel → Inspector de agente → sección "Observabilidad operativa" (declarado vs observado + evidencias de proceso), o `GET /api/eec/agents?id=…` → `observability` + `executions`.

## Comportamiento ante contratos desconocidos

- Major distinto → registro rechazado, sin migraciones silenciosas.
- Provider real sin manifiesto → `manifest_required` (no hay contrato, no hay ejecución).
- Manifiesto presente pero ilegible en caliente → el adaptador devuelve `manifest_invalid_or_missing` y el run falla honestamente.
