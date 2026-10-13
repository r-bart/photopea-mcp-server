# MCP: arquitectura, validación y seguridad

Fecha: 2026-10-13. Revisión de fuentes locales del fork; sin tocar servicios Photopea vivos, src, dependencias o lockfile. `npm audit --json` guardado en `npm-audit.json`. Reproducción exclusivamente con VM y objetos falsos: `synthetic-validation.ts`.

## Arquitectura y límites de confianza

MCP via stdio (`src/index.ts:45`) -> 34 herramientas Zod -> scripts/archivos en PhotopeaBridge -> HTTP/WS loopback -> frontend HTML -> iframe remoto Photopea -> exportación WS -> filesystem local. No hay endpoint HTTP MCP, ni Express/Hono/OAuth configurado en la aplicación. El frontend es el propietario de la correlación entre mensajes sin ID de Photopea y las solicitudes del servidor.

El servidor escucha explícitamente en 127.0.0.1 (`src/bridge/websocket-server.ts:133`); no está abierto a la LAN por defecto. HTTP solo sirve `/` y `/index.html` (`src/index.ts:30`). No hay endpoint HTTP que acepte una ruta arbitraria de disco. El acceso amplio a archivos se ejerce desde herramientas MCP autorizadas, no directamente desde HTTP.

El riesgo principal en nuestra casuística es la integridad de sesiones y archivos, seguido de la identidad de quien se conecta al bridge local. No hace falta convertir el proyecto en un servicio multiusuario remoto.

## Hallazgos priorizados

### A1. P1: handshake WS sin autenticación ni verificación de Origin

`src/bridge/websocket-server.ts:39` conecta WebSocketServer al HTTP server sin path, token u Origin allowlist. La primera conexión gana la sesión y puede declarar `status=ready`. El bloqueo de segunda pestaña protege una sesión ya establecida, pero no identifica al primer cliente.

Un cliente local no autorizado podría recibir el siguiente script y los bytes de un `open_file` legítimo, o devolver bytes falsos para una exportación legítima. Una página web de otro origen también puede intentar conectar al loopback; su viabilidad concreta depende de restricciones de acceso a red local del navegador. No se afirma que toda página pueda hacerlo en todo navegador ni que el cliente WS pueda iniciar lecturas arbitrarias: recibe trabajo posterior del cliente MCP.

Propuesta: secreto efímero por arranque, bootstrap local con token sin exposición en logs, Origin/Host/path estrictos, vínculo entre sesión de editor y conexión autenticada. Mantener 127.0.0.1. Pruebas de conexión legítima, origen ajeno, token ausente/incorrecto, token antiguo, segunda pestaña y reconexión de la misma sesión. Evaluar forma de entregar token al frontend antes de elegir query/subprotocol/cookie; no confiar solo en UUID de solicitud.

### A2. P1: entradas declarativas ejecutan código por interpolación sin validación suficiente

- `src/tools/export.ts:74`: `photopea_list_fonts.search` se inserta sin escape en una cadena JavaScript, aunque la herramienta declara `readOnlyHint: true` en línea 70.
- `src/tools/image.ts:102` y `:119`: `settings` acepta strings, booleanos y números. `src/bridge/script-builder.ts:558`–`:625` usa casts `as number`, sin validación de runtime, y concatena los valores en JavaScript.

La reproducción sintética `npx tsx thoughts/audit/synthetic-validation.ts` usa `node:vm` con app falso y solo cambia un booleano local. Resultado observado:

```
list_fonts readonly input executed injected expression: true
filter numeric input executed injected expression: true
```

No implica RCE de Node: el destino real es el intérprete de Photopea. La capacidad explícita `run_script` ya existe, pero estas herramientas permiten colar mutaciones por un contrato presentado como lectura o ajuste numérico. También fallan accidentalmente con nombres de fuente que contengan comillas.

Propuesta: serialización única de literales, esquemas discriminados y estrictos por tipo de filtro/ajuste, números finitos y rangos reales; curvas como arrays numéricos tipados. `load_font` usa otro escape parcial (`export.ts:52`), duplicación que conviene eliminar y cubrir con CR/LF/comillas/backslashes. Conservar run_script como escape explícito y marcado destructivo, no como fuga accidental.

### A3. P1: exportación escribe sin comprobar tipo real ni preservar el archivo anterior

`src/tools/export.ts:30`–`:33` hace un cast a BridgeFileResult después de comprobar únicamente success; el bridge acepta `result` en una petición expectFiles. `src/utils/file-io.ts:17` escribe directamente al destino, creando/truncando sin staging, backup o comprobación posterior. Una respuesta string exitosa puede escribirse como si fuera PSD; null falla pero solo después de pedir exportación. La descripción de exportación dice que todo se aplana, pero `buildExportImage` llama a saveToOE y esa afirmación no es apropiada para PSD por capas.

Propuesta: contrato discriminado de fichero, tamaño no cero, formato solicitado contra magic bytes y cabecera PSD, digest de transferencia, `.partial` junto al destino y promoción tras validar, política explícita de reemplazo con backup de versión anterior, respuesta con bytes/hash/ruta/formato y estado de verificación. Comprobar reapertura con capas para el fixture PSD de aceptación; cabecera+hash no demuestran que todas las capas estén conservadas. En Windows definir y probar semántica de rename/reemplazo y recuperación ante archivo bloqueado.

### A4. P1: límite WS y amplificación de memoria de exportación grande

WS no configura maxPayload (`websocket-server.ts:39`); versión instalada documenta 104857600 bytes (`node_modules/ws/lib/websocket-server.js:68`). Cada exportación es JSON/base64 en un solo mensaje (`frontend/index.html:573`–`:585`). Un archivo de 75 MiB ocupa 100 MiB solo en base64, antes del sobre JSON, así que excede el límite. Esto es un umbral derivado del código, no una medición del PSD v18 ni confirmación de su causa histórica.

En navegador hay ArrayBuffer, Uint8Array, cadena binaria construida byte a byte (`frontend:609`) y base64/JSON; en Node raw WS, string JSON, string base64 y Buffer. No asignar un multiplicador fijo de RAM: depende de representación y GC. Cargas también leen todo y serializan (`file-io.ts:9`, `websocket-server.ts:230`).

Propuesta: canal binario por chunks con límites explícitos de tamaño total y chunk, backpressure/ACK acotados, transferencia asociada a operation/session ID, escritura streaming a staging, digest incremental y rechazo limpio de secuencias incompletas. No aumentar maxPayload global como solución principal. La API Photopea seguirá entregando un ArrayBuffer completo; el streaming del bridge no elimina esa memoria en el iframe.

### A5. P2: fetch y lecturas sin presupuesto de tiempo/tamaño

`src/utils/file-io.ts:20` usa fetch sin AbortSignal ni tamaño máximo y consume response.arrayBuffer completo; los fetch ocurren antes de entrar en la cola/timeout del bridge (`tools/image.ts:42`, `tools/document.ts:51`). Una URL lenta puede quedarse fuera del presupuesto operativo, y varias cargas simultáneas pueden agotar memoria antes de serializar el editor. Un path local también se lee entero sin stat/preflight.

No hay allowlist de red ni restricción de rutas, pero eso es una capacidad autorizada del MCP local, no por sí solo una vulnerabilidad remota demostrada. Para liveries se necesitan Downloads, assets, exportaciones y directorios de simulador; un sandbox rígido de una sola carpeta rompería el flujo.

Propuesta: presupuesto de fetch separado, AbortSignal, lectura por flujo con límite, inspección tamaño local antes de cargar, concurrencia limitada para preparación de assets, política configurable de rutas/URLs cuando se requiera. Permitir valores adecuados a PSD grandes en lugar de topes arbitrarios pequeños.

### A6. P2: mensajes WS sin esquema ni validación del estado de operación

`websocket-server.ts:53` parsea JSON y el handler utiliza casts. `handleClientMessage` encuentra cualquier ID de la cola, elimina ese elemento y pone processing=false aun si no era la solicitud activa (`:333`–`:346`). Tipo de resultado, tamaño declarado, success booleano y base64 no se validan. Un fallo al decodificar después de quitar el pendiente deja la promesa sin resolver y se absorbe en catch de message.

Propuesta: esquemas discriminados, ID activo y generación de sesión obligatorios, validar antes de modificar cola, errores explícitos, límites y rechazos antes de asignar buffers. Cubrir mensajes malformados, duplicados, tardíos, ID desconocido/no activo y tipo de resultado incorrecto. El estado de timeout debe ser indeterminado hasta drenar/reconciliar Photopea: avanzar la cola no cancela el editor.

### A7. P2: contratos y anotaciones contradicen el comportamiento

Filtros, ajustes, gradientes y transformaciones describen modificación destructiva pero marcan destructiveHint=false (`tools/image.ts:104`, `:121`, `:142`, `:161`). open_file/place_image pueden acceder a URLs pero declaran openWorldHint=false. add_shape promete vector no destructivo, mientras el builder crea artLayer con selección y fill (`script-builder.ts:509` y siguientes). Esto afecta directamente a cómo el agente elige herramientas para logos y reescalados.

Propuesta: auditar las 34 herramientas con tabla comportamiento/contrato/validación/anotaciones y una prueba de efecto para cada familia, no solo snapshots del script. Ajustar descripciones a lo probado. Añadir esquema de target estable para documentos/capas/grupos antes de extender automatizaciones por lote.

### A8. P2: higiene de origen en iframe y observabilidad

`frontend:528` sí comprueba event.source contra contentWindow, una defensa útil. No comprueba event.origin y los envíos usan targetOrigin='*' (`:484`, `:512`). Añadir el origen esperado de Photopea como complemento sin venderlo como solución de la autenticación WS.

La UI de logs usa textContent (`frontend:362`–`:370`), no innerHTML: no se encontró inyección HTML en esos campos. Los logs/actividades incluyen paths y URLs completas (`document.ts:46`, `image.ts:37`, export.ts:27), que podrían contener parámetros firmados. Logging nuevo debe incluir ID, fase, bytes, duración, cola, estado final y códigos de error; excluir bytes, código completo, credenciales/query de URLs y tokens. Stderr actual se usa correctamente en vez de ensuciar stdout MCP.

## Dependencias: resultado y alcance real

Audit online consultado en esta revisión: **19 paquetes afectados** (1 low, 6 moderate, 9 high, 3 critical). No equivale a 19 rutas explotables. Clasificación mediante `package-lock.json` de todos los nodes afectados: **10 paquetes de producción**, **9 de desarrollo**. Detalle y enlaces oficiales de advisories en `npm-audit.json`.

Producción: @hono/node-server 1.19.12 moderate; @modelcontextprotocol/sdk 1.29.0 high; body-parser 2.2.2 low; express-rate-limit 8.3.2 moderate; fast-uri 3.1.0 high; hono 4.12.10 high; ip-address 10.1.0 high; proxy-addr 2.0.7 critical; qs 6.15.0 moderate; ws 8.20.0 high.

Desarrollo: @vitest/mocker 2.1.9 moderate; esbuild 0.27.5 y 0.21.5 moderate; nanoid 3.3.11 high; postcss 8.5.8 high; source-map-js 1.2.1 high; tinypool 1.1.1 critical; vite 5.4.21 high; vite-node 2.1.9 moderate; vitest 2.1.9 critical.

- **ws** es directamente alcanzable en el bridge. Priorizar versión corregida y pruebas de transporte; audit identifica `GHSA-96hv-2xvq-fx4p` (fragmentación/DoS, rango <8.21.0) y `GHSA-58qx-3vcg-4xpx` (memoria no inicializada, <8.20.1). No se ejecutó explotación ni flood.
- **SDK OAuth**: advisory exige flujo de cliente OAuth; este código solo crea servidor stdio. No se identificó ruta de exposición de ese fallo concreto. Actualizar SDK/lock con compatibilidad para reducir deuda.
- **proxy-addr/Hono/Express/body-parser/qs/rate-limit**: son dependencias runtime transitivas, pero no hay servidor Express/Hono/proxy trust/static middleware en nuestra entrada HTTP. No presentar el critical proxy-addr como RCE o filtración confirmada del bridge.
- **fast-uri**: dependencia que puede participar en validación de esquemas del SDK; no se demostró aquí ruta desde input hasta una decisión de seguridad afectada. Requiere revisión de alcance tras actualización.
- **Vitest/Vite**: no forman parte de npm start. Los advisories de UI/dev server requieren esas superficies activas. `npm test` usa vitest run; no configura UI. Los avisos tinypool requieren gadget/entrada adicional; no se demostró explotación del suite. Actualizar toolchain por separado porque npm propone salto mayor de Vitest.

No se ejecutó npm audit fix ni actualizaciones forzadas. Separar actualización runtime (ws primero), SDK transitivas y toolchain, con lock revisado y matriz Node/Windows definida. Docker usa node:18-slim y package engines dice >=18; planificar una versión Node soportada según compatibilidad verificada, junto con el salto de herramientas.

## Cobertura y métricas verificables

13 archivos src, 34 registerTool. Conteo de líneas por split de salto final: script-builder 847, frontend HTML 645 (incluye estilos/markup), bridge 391, types 269; herramientas document/export/image/layer/text 121/132/246/219/98. Son métricas de tamaño, no de complejidad ciclomática.

Solo 3 ficheros test versionados: script-builder, frontend-connection, websocket-bridge. El primero inspecciona strings de script; integración usa sockets locales reales y cliente simulado; frontend usa VM/DOM falso y solo prueba dos reconexiones. No ejecutan el intérprete real de Photopea ni validan un PSD por capas.

Existe TODO explícito del timeout en `tests/integration/websocket-bridge.test.ts:132`. La prueba llamada returns error when not connected (`:87`) solo comprueba isReady=false, no espera resultado de executeScript. Puerto fijo 14117 y sleeps reales generan fragilidad con ejecuciones concurrentes.

No hay configuración de coverage, proveedor instalado declarado ni umbrales; no se atribuye porcentaje. No hay `.github/` ni CI versionado. `test:e2e` referencia vitest.e2e.config.ts ausente. tsconfig excluye tests, así que tsc no comprueba su tipado. package version=0.1.1 pero createServer anuncia 0.1.0 (`src/server.ts:11`). `clean` aún usa rm -rf aunque build ya se adaptó a Windows.

## Criterios para el plan global

1. Reproducir regresiones con reloj inyectado, puerto efímero y frontend simulado: tardíos, timeouts en espera/ejecución/transferencia, malformed messages, export sin archivo y operaciones compuestas entrelazadas.
2. Implementar identidad y estados de operación antes de nuevas capacidades: queued/running/exporting/transferring/persisted/failed/indeterminate; el cliente nunca debe inferir cancelación de un timeout.
3. Incorporar transporte binario, almacenamiento con staging y verificación como una unidad de integridad; pruebas sintéticas que crucen 75 MiB y roundtrip PSD real guardado en directorio temporal.
4. Corregir interpolación y esquemas junto con contratos declarativos; tests de inputs de comillas y settings invalidos sin ejecutar documentos reales.
5. Autenticar bridge local; mantener fácil reconexión del mismo editor. Aceptación negativa en pruebas sintéticas, sin tocar sesión de usuario.
6. Actualizar deps/CI en cambio separado. Publicar conteo de tests y evidencia de checks; coverage por ramas de estados críticos si se añade proveedor, no porcentaje decorativo.

### Métrica estructural AST reproducible

`node thoughts/audit/structural-metrics.mjs` produce structural-metrics.json: 126 funciones/métodos/callbacks TypeScript. Aproximación declarada: 1 + if, bucles, case no-default, catch, ternarios y &&/||/??; excluye funciones anidadas de la cuenta del padre y no analiza JavaScript embebido en HTML. No es complejidad ciclomática canónica ni un score de calidad.

| Función | Línea | Líneas | Ramas aproximadas |
|---|---:|---:|---:|
| place_image callback (tools/image.ts) | 35 | 60 | 19 |
| buildApplyAdjustment | 551 | 44 | 17 |
| handleClientMessage | 327 | 41 | 14 |
| buildApplyFilter | 596 | 40 | 13 |
| buildAddText | 407 | 58 | 10 |
| open_file callback (tools/document.ts) | 44 | 28 | 10 |
| processNext | 267 | 55 | 8 |

Las ramas concentran interés de prueba en composición de place_image, validación de settings y máquina de estados del bridge. El tamaño por sí solo no justifica reescritura ni severidad.
