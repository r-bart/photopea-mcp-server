# Primer hito: revisión y evidencia

Rama: `codex/reliable-psd-checkpoints`. Base: `67057fc`. Resultado: READY FOR DRAFT PR dentro del alcance colas/timeouts/checkpoint PSD. El fork no se ha activado en la configuración del usuario.

## Criterios

| Criterio | Resultado | Evidencia |
|---|---|---|
| Cola no consume presupuesto de ejecución antes del envío | PASS | Gestor con reloj virtual; expiración separada |
| Timeout activo no envía B y resultado tardío sigue siendo A | PASS | Unit + socket integration; propiedad retenida |
| Texto/mensaje malformado no se declara PSD guardado | PASS | Regresiones de contrato; staging y validación |
| PSD >80 MiB llega sin base64 ni mensaje gigante | PASS | Socket real con fixture 108 MiB; Photopea real 114.697.689 bytes |
| Checkpoint reabre con capas, grupo, Levels, texto y visibilidad | PASS | Fixture real 3072×3072; snapshots antes/después idénticos |
| Composición conservada con fuentes disponibles | PASS | PNG SHA-256 `48925933616e00e3f5f3bd1962dfbb1c60fd04ecdd43d7c6e365b8619ca56d84` antes/después; ArialMT cargada |
| Transferencia interrumpida preserva revisión anterior | PASS | Corte de WS durante segundo PSD y recuperación; checksum anterior intacto |
| Fallo de disco/hash/ruta no reemplaza master | PASS | IO ENOSPC inyectado, checksum, truncación, ruta existente y carrera de destino |
| Runtime sin final confirmado conserva carril | PASS | Error real del intérprete termina en indeterminate tras 30 s |
| Restart no repite; publicación previa se reconcilia | PASS | Diario candidato, hash/estructura y pruebas de recuperación |
| Documento del usuario preservado | PASS por aislamiento | Solo puertos efímeros y fixtures propios; no se invocó MCP instalado ni se modificó su config |

Pruebas: 73/73; typecheck de src/tests y sintaxis frontend; build correcto en Node 24.14.1 Windows. CI Windows/Linux Node 22/24 configurada, todavía no ejecutada aquí. Revisión architecture-checker: PASS tras corregir todos sus P1. No existe lint previo; no se afirma haberlo ejecutado.

Evidencia local completa: `output/isolated-514e2b15-41f9-4041-874f-d748f54f0b7d/evidence.json` (excluida de Git). Master sintético: 114.697.689 bytes, SHA-256 `071d27a780c175c8244e3cccc99bc9196f6d717c42ebdfddc3a9b9f970b1cd45`. Segundo PSD después del corte: 114.697.765 bytes. Se serializó de nuevo desde el documento reabierto y no se exige igualdad binaria entre dos guardados distintos; cada transferencia compara su checksum de origen/destino. El campo de tiempos del harness incluye otros exports/reapertura, no mide únicamente el serializador. RSS capturado: 425.132.032 bytes, no pico ni memoria del navegador.

## Arquitectura y correcciones de revisión

- `OperationManager` retiene propiedad ante incertidumbre, guarda resultados tardíos y elimina closures de dispatch para no retener assets terminados.
- Frontend/bridge separan JSON pequeño y frames binarios. ACK tras escritura, un bloque en vuelo. WS actualizado a 8.21.0 y token/Origin/session/epoch.
- `ArtifactWriter` valida el temporal y publica sin reemplazo. Diario registra intención antes de publicar; una respuesta/registro fallido posterior no convierte un archivo publicado en cancelado.
- Carga ignora `done` antes de checksum/postMessage. Reporte/hash pertenece al objeto de operación y no se duplica al reconectar.
- `settled` se envía antes de liberar el gestor. La prueba con diario lento evita que B llegue con A todavía retenida en el frontend.
- Shutdown cierra servidores en finally incluso si falla el diario. Historial terminado se purga; desconocidos se conservan y se acotan explícitamente.

## Límites y siguientes entregas

El nivel reportado es `structure_checked`; reapertura es evidencia de esta fixture, no una comprobación automática de cada archivo. No se certifican smart objects, todos los modos/profundidades PSD ni 512 MiB reales. En un ensayo con fuente por defecto cambió únicamente el texto tras reabrir; una fuente explícita resolvió el fixture. Cargar fuentes y comparar compuestos sigue siendo necesario.

La exportación apunta al documento activo al despachar, con ventana cooperativa sin edición UI. `documentRef`, selectores anidados, exclusión de todo `place_image`, material variants y bundles siguen en el plan siguiente. No se ha marcado el plan completo ni sus 19 tareas como terminados. La API nueva exporta un artefacto por operación. Una orden desconocida puede permanecer retenida hasta recuperación manual: no se ofrece un reset automático que arriesgue el único editable.

El cambio actualiza ws; quedan advisories heredados en SDK/toolchain y contratos de filtros/ajustes para S.2. No se hizo audit fix --force. La publicación npm, merge de PR y migración del MCP no forman parte de esta entrega.

## Lecciones

El intérprete real de Photopea cambia decisiones que un test JS normal no detecta: eval no está disponible, try/finally no dio final confirmado, y algunas APIs inexistentes no demostraron el fallo esperado. Los scripts necesitan postcondiciones, marcas correlacionadas y aceptación real. El journal introduce yields; el orden de notificación al frontend debe preceder a liberar la cola, incluso cuando el archivo ya está publicado. No fue necesario añadir reglas generales CLAUDE.md; las garantías y límites están en CHECKPOINTS.md y sus pruebas.
