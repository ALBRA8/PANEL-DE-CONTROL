# EEC V2 — 04. Seguridad: autenticación, autorización y configuración

## Modelo de identidad (§6)

**Regla implementada:** el EEC jamás confía en `requesterType`/`requesterId`/roles declarados por el cliente. La identidad se **deriva en el servidor** de una credencial validada (`src/lib/eec/security/auth.ts`):

| Credencial | Identidad efectiva | Uso |
|---|---|---|
| `Authorization: Bearer $EEC_API_TOKEN` | `HUMAN` / `operator:token` | integraciones servicio-a-servicio |
| Cookie `eec_session` (HMAC-SHA256, httpOnly, 12h) | `HUMAN` / `operator:session` | panel web (login con `EEC_OPERATOR_PASSWORD`) |
| (sin credencial) | **401** | — |
| Llamadas internas (workers/handlers/CLI) | `SYSTEM`/`AGENT` — NUNCA alcanzables vía HTTP | motor |

- Comparaciones de secretos en tiempo constante (`timingSafeEqual`).
- Sin credenciales configuradas en el servidor → las rutas de escritura responden **503 `auth_not_configured`** (frontera cerrada por defecto; nunca se simula autenticación).
- La respuesta de un comando incluye `requester:{type,id,via}`: la identidad efectiva aplicada es observable (y testeable).

## Superficie de ataque cubierta (verificada en `tests/eec-v2/api-security.sh`, 16/16)

| Vector | Protección | Prueba |
|---|---|---|
| Suplantación de `HUMAN`/`SYSTEM` por body | body ignorado; identidad solo de credencial | test 5 (SYSTEM en body → identidad efectiva HUMAN) |
| Petición anónima a ruta sensible | 401 antes de tocar el pipeline | tests 1-2 |
| Fuerza bruta de login | rate limit 10/min por IP | suite auth |
| Ráfaga sobre comandos | 60/min por IP → 429 con `retry-after` | test 11 |
| Payload gigante | límite 1 MB (content-length y tamaño real) → 413 | test 10 |
| Entrada inválida | esquema zod por comando (pipeline) → 422; type malformado → 400 | tests 7-9 |
| Comando desconocido | catálogo cerrado → 422 | test 7 |
| Secreto en salidas/logs | `redactSecrets` (patrones + env activos) antes de persistir evidencia | unitarias |
| Ejecución arbitraria por input de tarea | entrada por stdin JSON; allowlists de ejecutable/workdir; sin shell | unitarias + integración |
| Aprobaciones eludibles | gate de aprobación usa identidad DERIVADA; políticas `REQUIRE_APPROVAL` aplican a HUMAN también | piloto paso 5 |
| Cookies | httpOnly + sameSite=lax + secure en producción (salvo `EEC_INSECURE_COOKIE=1` en dev) | suite |
| Sesiones manipuladas | HMAC-SHA256; token alterado → inválido | unitarias |

## Variables de entorno (sin valores secretos)

```bash
# — OBLIGATORIAS en despliegue (sin ellas, la frontera queda cerrada: 503) —
EEC_OPERATOR_PASSWORD=…        # contraseña del operador del panel
EEC_SESSION_SECRET=…           # secreto HMAC de sesiones (rotar; invalida sesiones)
EEC_API_TOKEN=…                # token para integraciones (Bearer)

# — Adaptador de proceso local (§4) —
EEC_ALLOWED_EXECUTABLES=/abs/ruta/bin1,/abs/ruta/bin2   # extra al runtime del EEC
EEC_ALLOWED_WORKDIRS=/abs/proyecto,/abs/proyecto/agents

# — Frontera INSTALADOR (opcional; sin URL → "no disponible" honesto) —
EEC_INSTALLADOR_URL=https://instalador.interno
EEC_INSTALLADOR_TOKEN=…

# — Heredadas V1 —
DATABASE_URL=file:…/db/custom.db
EEC_SIMULATION_MODE=1|0        # default ON (honestidad: nada externo sin pedirlo)
```

## Requisitos de despliegue (documentación operativa)

1. Servir el panel **detrás de TLS** (Caddy/NGINX). La cookie se marca `secure` en producción.
2. Establecer `EEC_OPERATOR_PASSWORD`, `EEC_SESSION_SECRET` y `EEC_API_TOKEN` con valores generados; **no** usar los de desarrollo de `.env.example`.
3. Restringir por red el acceso a las rutas `/api/eec/*` si el panel no debe ser público; el rate-limit es por instancia (para multi-nodo, sustituir por almacén compartido — limitación documentada, no oculta).
4. Rotación: cambiar `EEC_SESSION_SECRET` invalida todas las sesiones; cambiar `EEC_API_TOKEN` requiere actualizar integraciones.
5. Auditoría: toda acción sensible queda en `AuditRecord` (actor derivado `operator:token`/`operator:session`) y en el bus de eventos con correlación.

## Qué NO resuelve esta frontera (honestidad)

- No hay proveedor de identidad federado (SSO/OIDC) ni multi-usuario con roles granulares: la frontera actual es de **operador único** + token de servicio. Queda preparada para sustituir `loginOperator` por un IdP sin tocar el pipeline (la identidad sigue entrando por `resolveRequester`).
- El rate-limit en memoria es por proceso; documentado como limitación, no como característica.

## Apéndice V2 — Cadena hash de auditoría, quórum y órgano de control (doc 07 · sprint P0-P2)
- **AuditChain (P0-1)**: cada `AuditRecord` se sella al crearlo con SHA-256 del payload canónico encadenado al sello previo (`chainSeq`, `prevHash`, `thisHash`; génesis = 64 ceros). Un único punto de creación (`writeAudit`) — nada entra a la escritura pública sin sello. Verificación incremental: `GET /api/eec/audit/chain`. La cadena prueba alteración posterior; no prueba verdad absoluta (mitigación futura: fingerprint externo periódico).
- **Quórum humano (P0-3)**: `minimumHumanSignoff` en `Approval` — N firmas HUMANAS DISTINTAS; duplicados rechazados; el comando no se reanuda sin quórum. Riesgo conocido: exige identidad real de usuarios (quórum 1 sigue siendo seguro hoy).
- **Órgano de control (P1-3)**: revisión adversarial pre-dispatch determinística — 7 reglas (inyección, salto de controles, suplantación, urgencia artificial, evidencia fantasma, destrucción sin motivo, destructiva explícita), score 0-100 y umbrales por política `ADVERSARIAL`; BLOCK rechaza, REVIEW fuerza quórum.
- **Delegación administrativa (P2-4)**: feature flags por organización con catálogo cerrado y override auditable (`org.flag.set/unset` sellados en la cadena); fail-closed ante flag desconocido o tipo incorrecto.
