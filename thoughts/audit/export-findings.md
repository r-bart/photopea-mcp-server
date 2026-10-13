# Exportación y carga: auditoría para liveries

Fecha: 2026-10-13. Repositorio inspeccionado: `C:/Users/rober/Documents/Projects/photopea-mcp-server`.

## Alcance y evidencia

Lectura de código y dependencias instaladas, metadata de tamaños de los archivos LMU y reproducciones sintéticas aisladas. No se abrieron documentos reales, no se contactó con la sesión Photopea activa y no se modificaron fuentes/configuración. Los únicos archivos creados están en `thoughts/audit/`.

Reproducción:

```powershell
node node_modules/tsx/dist/cli.mjs thoughts/audit/export-probes/probe.ts
node thoughts/audit/export-probes/ws-limit.mjs
```

Resultados completos: `thoughts/audit/export-probes/results.json`. Los probes demuestran el comportamiento defectuoso actual; no son tests de aceptación de una solución. `false-success.psd` es deliberadamente un archivo sintético inválido de 2 bytes.

## P0: un PSD de unos 75 MiB supera el transporte actual

- `src/bridge/websocket-server.ts:39` instancia WebSocketServer sin `maxPayload`.
- Dependencia instalada: `node_modules/ws/lib/websocket-server.js:68` usa 100 * 1024 * 1024 bytes.
- `src/frontend/index.html:573-585` convierte el archivo entero en base64 y lo envía como JSON único; `:451-453` serializa ese JSON.
- La prueba de cabecera de frame enmascarado sobre un WebSocket localhost real da `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` en servidor y cierre **1009** en cliente. No requiere reservar ni enviar 100 MiB.
- Para el mensaje PSD actual (UUID de 36 caracteres, MIME `image/vnd.adobe.photoshop`, resto de campos actuales), el sobre sin datos ocupa **136 bytes**. Límite exacto de contenido binario: **78.643.098 bytes**. El byte siguiente aumenta el base64 a un frame por encima del límite.

Metadata local (sin leer contenido): template original 41.246.822 bytes; v01 45.020.009; v15 72.164.501; v16 74.733.891; v17 **77.303.580**. V17 queda a **1.339.518 bytes (1,27746 MiB)** del techo. Su base64 ocupa 103.071.440 bytes más el sobre. No hay PSD v18 en el directorio inspeccionado. El PNG actual albedo pesa 901.904 bytes y regiones 643.019 bytes: el mismo diseño puede exportar ambos PNG y fallar guardando su fuente PSD.

**Hipótesis, no causa histórica confirmada:** si v18 aumentara como v16→v17 (2.569.689 bytes), su PSD estimado sería 79.873.269 bytes y el base64 106.497.692: sobre el límite. No tenemos binario ni log de cierre de v18 que confirmen esa explicación.

**Propuesta:** transporte binario fragmentado con ID de operación/transferencia, secuencia/offset, longitud declarada, límites de chunk y total, control de flujo y escritura incremental a temporal. Alternativa viable: upload HTTP local de Blob con token de operación de un solo uso y límites explícitos; requiere proteger la vinculación sesión/operación y probar su comportamiento real. Decidir una vía, no mantener dos protocolos grandes sin necesidad. Aumentar maxPayload únicamente desplaza el fallo y deja las copias completas en memoria.

## P0: exportación puede declarar éxito y guardar texto como PSD

- `src/bridge/websocket-server.ts:331-370` resuelve tanto `result` como `file` sin comprobar `pending.expectFiles`.
- `src/frontend/index.html:473-478` ignora `msg.expectFiles`; `:587-597` marca éxito cuando llega `done` sin binario y sin error reconocido.
- `src/tools/export.ts:31-33` hace un cast TypeScript a BridgeFileResult sin validación runtime y entrega `data` a writeLocalFile.

Reproducciones ejecutadas:

1. `executeScript(..., true)` + respuesta sintética `{type:'result', success:true, data:'ok'}` devuelve éxito textual.
2. Callback real de exportación con esa respuesta escribe `false-success.psd`, contenido literal `ok`, 2 bytes, y devuelve **Image exported to ...**.
3. Función real del frontend `handlePhotopea_done`, aislada en VM, con una exportación pendiente sin binario emite `success:true,data:null`.

**Propuesta:** resultados discriminados (`kind:'text'|'artifact'|'error'`) y contrato de salida esperado. Una exportación solo termina con binario válido del formato requerido y confirmación de persistencia. `done` sin archivo es error de protocolo explícito; nunca sustituirlo por un éxito genérico. Guardar dimensiones/formato/bytes/hash/docId/opId en el resultado.

## P1: no hay validación de formato ni persistencia transaccional

- `src/bridge/websocket-server.ts:351` decodifica base64 permisivamente con Buffer.from sin validar longitud, codificación o firma.
- `src/frontend/index.html:618-634` solo identifica unos pocos bytes; el servidor no valida ese MIME contra el formato solicitado. El detector RIFF tampoco comprueba el subtipo WEBP.
- `src/utils/file-io.ts:12-17` escribe directamente al destino con writeFile, que reemplaza/trunca existentes. No hay temporal, política de overwrite, backup, hash ni verificación posterior.
- `src/tools/export.ts:36-39` un write resuelto equivale a éxito; no hay evidencia de PSD legible ni que conserve capas. Un fallo de disco/escritura puede dejar el destino parcial; esta última consecuencia es inferencia del método usado, no se provocó un fallo de disco real.

**Propuesta:** validar longitud transferida, hash incremental y cabeceras antes de promover el temporal al destino. PSD: firma/version/reservados/channels/dimensiones/depth/mode y estructura de longitudes sin cargarlo entero; PNG: firma completa, IHDR/dimensiones y comprobación estructural, con decodificación independiente en validación de integración. Una cabecera correcta no demuestra un PSD íntegro. Guardar checkpoint versionado por defecto; reemplazo explícito con backup/rename probado en Windows y limpieza segura del temporal. Mantener el original intacto cuando falla validación, disco, cierre o transporte. Usar reapertura de copia sintética para verificar capas, no confundir SHA con prueba de editabilidad.

## P1: alto coste de memoria y CPU por archivos enteros

Exportación: ArrayBuffer Photopea → `fileBuffer` → Uint8Array (vista) → concatenación de un carácter por byte (`src/frontend/index.html:609-615`) → btoa → JSON.stringify → cola WebSocket → raw.toString/JSON.parse en servidor (`websocket-server.ts:56`) → Buffer.from. PostMessage no usa lista de transferibles (`frontend/index.html:484-485` y `:511-512` para carga), por lo que puede añadir copias entre contextos.

Carga: `readLocalFile` lee todo (`file-io.ts:9`), `loadFile` convierte a base64 y retiene JSON serializado en pendingLoads (`websocket-server.ts:230-247`), frontend hace atob + otro Uint8Array (`index.html:498-507`). Varias cargas en cola conservan varios payloads completos sin cuota. El maxPayload citado es del servidor receptor: **no afirmar que ese mismo techo limite la dirección servidor→navegador**.

No se midió el pico real de heap del navegador ni se ejecutó el bucle con PSD real: la amplificación está demostrada por el código, sus magnitudes exactas dependen de V8, ropes, GC y Photopea. La API saveToOE ya entrega un ArrayBuffer completo; fragmentar el transporte no convierte la serialización interna de Photopea en streaming.

**Propuesta:** eliminar base64 de archivos grandes; liberar referencias por fase; cuotas de bytes y de operaciones en cola; medir RSS Node y heap navegador en fixtures sintéticos de 45/77/80/150/300 MB y cancelación durante transferencia. Exponer bytes transferidos y fase; el progreso de transferencia no debe presentarse como progreso de serialización PSD.

## P1: descarga y carga no tienen presupuesto completo ni postcondición

- `src/utils/file-io.ts:20-26`: fetch/arrayBuffer sin AbortSignal, límite de bytes, inspección Content-Length ni presupuesto propio. Body completo antes de entrar en la cola.
- `src/tools/document.ts:49-72`: carga por URL/local considera éxito el ACK del bridge; no comprueba identidad, tamaño, modo o estructura del documento abierto.
- `src/frontend/index.html:494` lee filename pero no lo usa; la metadata de apertura debe salir del documento real.
- `src/tools/document.ts:69` usa split('/') sobre rutas Windows: puede mandar la ruta completa como filename; ahora no tiene efecto funcional porque el frontend lo ignora.

**Propuesta:** separar descarga/transferencia/apertura con límites y timeout por fase, AbortController para IO cancelable, progreso honesto y postcondición que vincule el documento resultante con la operación. Nunca reintentar abrir automáticamente si el tiempo de espera expiró después de enviar a Photopea.

## P2: contrato de guardado confuso para preservar masters

`src/tools/export.ts:18` afirma que todo se aplana, pero `script-builder.ts:804-815` solo llama saveToOE(format), sin flatten explícito. Corregir descripción y comprobar en integración que PSD mantiene grupos, capas ocultas y nombres. `close_document(save:true)` (`document.ts:111-119`, `script-builder.ts:200-203`) no elige ruta ni acredita persistencia local: no sustituye un checkpoint exportado y verificado.

## Orden propuesto adaptado a nuestro trabajo

1. Corregir identidad/cola/timeouts y resultado tipado junto al guardado atómico para impedir falsos checkpoints. Es prerequisito del transporte grande.
2. Añadir transferencia binaria fragmentada con límites y estados de trabajo; pruebas justo bajo/sobre 78.643.098 bytes, corte de conexión, orden/duplicados, disco fallido y ausencia de archivo.
3. Añadir `save_checkpoint` que preserve PSD en ruta versionada y entregue hash, tamaño, documento y estado verificado. Distinguir archivo guardado, formato validado y reapertura con capas comprobada.
4. Añadir exportación compuesta para liveries que capture documento/visibilidad, exporte albedo y regiones (o spec iRacing), restaure estado y genere manifiesto con hashes y checkpoint de origen. Persistencia por conjunto mediante manifiesto final: si falla una pieza, no presentar el conjunto como listo para instalar.
5. Integración real posterior en documentos sintéticos 4K/8K con grupos y capas ocultas; luego copia de template, nunca el único documento con trabajo sin guardar. Medir antes de establecer objetivos rígidos de tiempo/memoria.

Aceptación mínima: ningún timeout o cierre puede reportar éxito de archivo inexistente, de texto o de otra operación; ninguna exportación fallida destruye el checkpoint anterior; PSD >80 MB atraviesa el transporte con hash idéntico; albedo/regiones proceden de la misma versión y conservan dimensiones; los errores indican si falló serialización, transferencia, validación o escritura.
