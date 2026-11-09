# ALBRA — Contrato de integración INSTALADOR ↔ PANEL DE CONTROL

**Estado:** propuesta de integración v0.1 (documento de diseño; no implica que la integración esté implementada).  
**Fecha de revisión:** 2026-11-09.  
**Repositorios:** `ALBRA8/INSTALADOR` y `ALBRA8/PANEL-DE-CONTROL`.

## 1. Objetivo del producto

El INSTALADOR es el punto de entrada único para desplegar ALBRA en un computador o VPS. El flujo inicial esperado es:

1. preparar y validar el entorno;
2. instalar el PANEL DE CONTROL;
3. configurar persistencia, secretos, red y arranque;
4. iniciar y verificar el PANEL;
5. instalar el primer agente desde un paquete autorizado;
6. registrar el agente en el PANEL y comprobar su salud;
7. permitir que el PANEL solicite al INSTALADOR nuevas operaciones sobre los productos administrados.

El objetivo no es que el INSTALADOR absorba la orquestación de agentes. El INSTALADOR prepara, instala y administra el ciclo de vida; el PANEL coordina; los agentes ejecutan su trabajo.

## 2. Responsabilidades y autoridad

### INSTALADOR
- Descubrimiento del entorno y preflight.
- Catálogo, verificación de paquetes, instalación transaccional y registro.
- Configuración de valores USER/SYSTEM/PRODUCT y almacenamiento seguro de secretos.
- Inicio, parada, reinicio, actualización, rollback, backup, restore, diagnóstico y desinstalación.
- Seguimiento de ejecuciones y evidencia real del sistema operativo.
- No declara éxito antes de completar y verificar los pasos de la operación.

### PANEL DE CONTROL (EEC)
- Orquestación de agentes, tareas, ejecuciones, aprobaciones y supervisión.
- Solicita al INSTALADOR operaciones de ciclo de vida.
- Mantiene correlación entre solicitud del PANEL y ejecución del INSTALADOR.
- No escribe directamente en las tablas internas del INSTALADOR.
- No interpreta una aceptación HTTP como instalación completada.

### Agentes
- Se distribuyen como productos/paquetes con identidad y manifiesto verificables.
- Se registran en el PANEL después de instalarse.
- Se ejecutan bajo su runtime autorizado y con permisos declarados.
- No reciben secretos o comandos arbitrarios por fuera de sus contratos.

## 3. Hallazgos comprobados en el código revisado

### INSTALADOR
- El catálogo actual declara instalables `crm` y `leads`; `krea` y `trading` aparecen bloqueados.
- El catálogo no incluye todavía un producto `panel-de-control` ni un paquete del PANEL.
- El motor de instalación trabaja desde paquetes ALBRA, verifica hash/firma, prepara staging, configura, registra, inicia y ejecuta health checks.
- La API de plataforma documentada en el código incluye `GET /api/catalog`, `POST /api/preflight`, `POST /api/install`, `GET /api/runs` y `GET /api/runs/{id}`.
- Las operaciones de producto incluyen rutas de detalle, configuración, lifecycle, health, logs, diagnostics, update, rollback, backup, restore y uninstall.
- Existe además un contrato de operaciones EEC v1.0.0 en `src/lib/albra/contracts/eec.ts`, expuesto por `/api/ops`, con Bearer, `requestId`, `issuedAt`, `expiresAt`, `nonce` y respuesta asíncrona mediante `runId` para INSTALL, UPDATE, ROLLBACK y UNINSTALL.
- El token EEC se guarda en SecretStore; la ruta administrativa de rotación lo devuelve una sola vez. Nunca debe incluirse en logs ni en el paquete.

### PANEL DE CONTROL
- Tiene un contrato de ciclo de vida v1.0.0 y un adaptador HTTP que espera rutas `/api/v1/managed...`.
- Ese adaptador no coincide con las rutas de plataforma y producto existentes del INSTALADOR.
- El adaptador y el contrato del PANEL usan `operationId`; el contrato de operaciones del INSTALADOR devuelve `requestId` y, para operaciones asíncronas, `runId`.
- El `package.json` del PANEL define build Next.js standalone y arranque con Bun. No se encontró un Dockerfile en la raíz al momento de la revisión.
- El contrato del producto CRM declara despliegue local y adaptador preferido Windows; no se debe asumir que el instalador actual ya despliega cualquier producto en Linux/VPS.

## 4. Decisión de integración

No crear un segundo motor de instalación ni duplicar el catálogo. La primera integración debe reutilizar el motor de paquetes y las rutas de plataforma del INSTALADOR para bootstrap y despliegue. El contrato EEC debe ser la frontera estable de control entre PANEL e INSTALADOR.

Se distinguen dos planos:

1. **Bootstrap/Deployment:** lo inicia el INSTALADOR para instalar el PANEL y los agentes mediante el catálogo, preflight, install y runs.
2. **Lifecycle/Control:** lo usa el PANEL después de estar operativo para solicitar operaciones, consultar estado y seguir ejecuciones mediante el contrato EEC.

El contrato EEC debe exponer operaciones de descubrimiento/estado y ciclo de vida, pero no obligar al PANEL a conocer tablas, rutas internas o estructuras Prisma del INSTALADOR.

## 5. Contrato de mensajes EEC propuesto

### 5.1 Petición

La petición conserva el sobre de seguridad existente del INSTALADOR:

```json
{
  "contractVersion": "1.0.0",
  "requestId": "req_01JEXAMPLE123",
  "operation": "INSTALL",
  "productId": "leads",
  "params": {},
  "issuedAt": "2026-11-09T18:00:00.000Z",
  "expiresAt": "2026-11-09T18:04:00.000Z",
  "nonce": "nonce-aleatorio-de-al-menos-16-caracteres"
}
```

Reglas:
- `requestId` identifica la solicitud lógica del PANEL.
- `nonce` es único por solicitud y no reutilizable.
- `expiresAt` debe ser posterior a `issuedAt` y no superar cinco minutos.
- `productId` es el identificador estable del catálogo, no un nombre visible.
- `params` depende de la operación y debe validarse estrictamente.
- El PANEL debe generar IDs y nonces criptográficamente seguros.
- La autenticación Bearer se transmite por TLS; no se envía en el body.

### 5.2 Respuesta de aceptación o rechazo

```json
{
  "contractVersion": "1.0.0",
  "requestId": "req_01JEXAMPLE123",
  "accepted": true,
  "operation": "INSTALL",
  "productId": "leads",
  "result": { "runId": "run_01JEXAMPLE456" }
}
```

Un rechazo devuelve `accepted: false` y `error: { code, message }`. La respuesta de aceptación significa únicamente que el INSTALADOR aceptó/despachó la solicitud; no significa que el producto esté instalado.

### 5.3 Seguimiento y resultado final

El PANEL debe conservar el par `requestId` / `runId`. El estado final se obtiene consultando el estado de ejecución del INSTALADOR y, al terminar, consultando `STATUS`/health del producto. No se debe inventar un `operationId` sustituto ni traducir aceptación a éxito.

La futura interfaz EEC debe ofrecer una consulta estable de ejecución por `runId`, con estados normalizados: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `UNKNOWN`. El mapeo exacto desde los estados internos de Run debe implementarse y probarse antes de declararlo contractual.

## 6. Catálogo de operaciones

| Operación canónica | Capacidad actual del INSTALADOR | Observación |
|---|---|---|
| DISCOVER / LIST | `GET /api/catalog` | Añadir fachada EEC estable; devolver IDs, versión y disponibilidad. |
| PREFLIGHT | `POST /api/preflight` | Requiere packageId. |
| INSTALL | `POST /api/install` y `runId` | Asíncrona. |
| CONFIGURE | Ruta de configuración de producto | Definir scopes y validación; no confundir con configuración inicial. |
| START | Lifecycle START / ops START | Síncrona en ops v1.0.0. |
| STOP | Lifecycle STOP / ops STOP | Síncrona en ops v1.0.0. |
| RESTART | Lifecycle RESTART / ops RESTART | Síncrona en ops v1.0.0. |
| STATUS | Estado de producto / ops STATUS | Debe devolver estado y evidencia. |
| HEALTH | Health GET/POST / ops HEALTH | Separar último snapshot de ejecución nueva. |
| UPDATE | Ruta update / ops UPDATE | Asíncrona; admite targetVersion. |
| ROLLBACK | Ruta rollback / ops ROLLBACK | Asíncrona. |
| BACKUP | Ruta backup / ops BACKUP | Validar parámetros y política de retención. |
| RESTORE | Ruta restore / ops RESTORE | Requiere backupId. |
| DIAGNOSTICS | Ruta diagnostics / ops DIAGNOSTICS | Controlar datos sensibles. |
| UNINSTALL | Ruta uninstall / ops UNINSTALL | Requiere dataMode KEEP/EXPORT/DELETE. |
| REPAIR | Ruta repair de producto | Existe en la API de producto; definir confirmación y evidencia. |

La fachada EEC puede mapear estas capacidades a las rutas internas existentes. El PANEL no debe depender directamente de la estructura interna de esas rutas.

## 7. Identidad y descubrimiento

Cada producto debe tener:
- `productId` estable y único;
- nombre visible, vendor y versión;
- manifiesto y contrato de producto;
- plataformas y arquitecturas soportadas;
- runtime/dependencias declarados;
- configuración y secretos declarados;
- operaciones soportadas;
- estado de instalación y salud.

El descubrimiento EEC debe diferenciar productos disponibles, instalados, bloqueados por entitlement, incompatibles con el entorno y paquetes inválidos. No exponer rutas locales sensibles ni valores de secretos.

## 8. Instalación del PANEL como producto ALBRA

Crear un paquete ALBRA específico para el PANEL, con identificador provisional `panel-de-control` (sujeto a confirmar con el naming definitivo), versión, manifiesto, contrato, payload y firma.

Antes de incluirlo en el catálogo se debe resolver:
- runtime soportado para Windows, macOS y Linux;
- despliegue en VPS Linux y gestión de servicios;
- persistencia de la base de datos del PANEL;
- migraciones Prisma y generación del cliente;
- variables de entorno y provisionamiento de secretos;
- puertos, proxy/TLS y política de exposición de red;
- usuario/permisos del proceso y rutas de datos;
- estrategia de actualización, backup y rollback;
- health check autenticado del PANEL;
- ciclo de bootstrap para que el PANEL reciba credenciales EEC sin incluirlas en el paquete ni mostrarlas al usuario.

No se debe instalar el PANEL como un agente genérico ni reutilizar sin más el runtime mínimo que hoy sirve a CRM/LEADS. El PANEL tiene requisitos de aplicación y persistencia propios.

## 9. Primer agente y registro

Después de que el PANEL esté saludable:
1. el usuario selecciona un agente disponible;
2. el PANEL solicita preflight/instalación al INSTALADOR;
3. el INSTALADOR verifica paquete, firma, dependencias y compatibilidad;
4. ejecuta la instalación y devuelve `runId`;
5. el PANEL consulta progreso y resultado;
6. el PANEL obtiene el estado real del producto;
7. el agente se registra en el inventario/orquestador del PANEL;
8. el PANEL ejecuta health check del agente y muestra evidencia.

El registro en el PANEL no debe preceder a una instalación confirmada. Si falla, el estado debe quedar explícitamente fallido o pendiente de reconciliación.

## 10. Seguridad

- TLS obligatorio cuando PANEL e INSTALADOR se comuniquen por red, especialmente en VPS.
- Token EEC de alcance mínimo, almacenado cifrado y nunca en logs, URLs, repositorios o paquetes.
- Provisionamiento inicial de credenciales por canal local/seguro y rotación explícita.
- Nonce anti-replay y ventana de expiración de cinco minutos como en el contrato actual.
- Rate limits y límites de tamaño de payload.
- Allowlist de operaciones y parámetros por producto.
- Validación de firmas de paquetes y hashes.
- Auditoría con actor, requestId, runId, productId, operación y resultado; redactar secretos.
- No aceptar comandos de shell arbitrarios desde el PANEL.
- Acciones destructivas (DELETE, UNINSTALL, RESTORE) requieren confirmación y política explícita.
- Si PANEL e INSTALADOR residen en el mismo host, mantener la frontera autenticada; no asumir confianza implícita por localhost.

## 11. Entornos de despliegue

El mismo contrato debe servir para:
- **Local:** INSTALADOR y PANEL en el computador del usuario, con datos y servicios locales.
- **VPS:** INSTALADOR y PANEL en servidor Linux, con servicio persistente, TLS/proxy, firewall y almacenamiento duradero.

El contrato no debe codificar rutas de Windows, direcciones localhost ni supuestos de un proveedor cloud. Las diferencias viven en adaptadores de plataforma y configuración de despliegue.

## 12. Criterios de aceptación del primer recorrido

La integración no se considera lista hasta demostrar, en una instalación limpia:

1. El INSTALADOR detecta y valida el entorno.
2. El catálogo contiene el paquete firmado del PANEL.
3. Preflight del PANEL no deja bloqueadores.
4. El PANEL se instala y registra con versión y rutas correctas.
5. El servicio del PANEL arranca automáticamente.
6. Health check autenticado del PANEL devuelve evidencia válida.
7. El PANEL puede autenticarse contra el INSTALADOR sin exponer el token.
8. El PANEL descubre catálogo y productos instalados.
9. El PANEL instala un primer agente mediante el INSTALADOR.
10. El PANEL sigue el `runId` hasta resultado final.
11. El agente queda registrado y saludable.
12. Reiniciar el host no pierde el registro ni declara vivos procesos que no lo estén.

Repetir las pruebas en un computador local y en un VPS Linux limpio.

## 13. Trabajo pendiente antes de implementar

- Definir y registrar el paquete del PANEL en el catálogo del INSTALADOR.
- Confirmar el runtime y la estrategia de servicio por sistema operativo.
- Definir la ruta EEC estable para catálogo, productos, operaciones y ejecución por runId.
- Revisar la autenticación efectiva de todas las rutas de plataforma/producto; no asumir que la protección de `/api/ops` cubre automáticamente las demás.
- Reconciliar el contrato lifecycle del PANEL con el sobre EEC real del INSTALADOR.
- Implementar pruebas de contrato y aceptación end-to-end.
- No modificar ni desplegar agentes adicionales hasta que el recorrido PANEL + primer agente pase en local y VPS.

## 14. Regla arquitectónica

**El INSTALADOR despliega y verifica. El PANEL gobierna y coordina. Los agentes ejecutan.**

Este documento describe el objetivo y los contratos propuestos. Los puntos identificados como pendientes no deben presentarse como capacidades ya implementadas.
