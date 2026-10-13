# Casuística de liveries y diseño de capacidades MCP

Revisión estática, 13-10-2026. No se operó Photopea, no se modificaron liveries ni skills. Los hechos de sesión proceden de notas locales; no constituyen una reproducción causal del fallo. Rutas del MCP relativas a `C:/Users/rober/Documents/Projects/photopea-mcp-server`. Biblioteca: `C:/Users/rober/Documents/Liveries`.

## Qué necesita preservar este flujo

1. El PSD completo es la fuente editable. `LMU/M4-LMGT3-2025-BrakingLab/LEEME.md:3` registra v18 exportada en PNG/TGA pero fallo al guardar PSD por desconexión; v17 es el último editable durable. `LEEME.md:80` aclara que `build-artwork.py` no reproduce los sponsors raster recolocados. Regenerar SVG no recupera todo el trabajo.
2. Trabajamos con atlas 2048 y 4096, activos vectoriales en coordenadas 1600, grupos oficiales, ajustes Levels, stickers, carbono y capas propias. No equivale a abrir una imagen y exportar un compuesto.
3. Albedo y regiones deben corresponder a la misma revisión. `LEEME.md:134` requiere activar `Region` y el decal del alerón para regiones, mantener `Region 0` oculto y excluir Mask/Wire/Display Panel Position. Levels afecta RGB (`:118`): no normalizar el color del albedo para igualarlo al SVG.
4. Deben conservarse revisión aprobada, editable durable, exportaciones, instalación, validación 3D y publicación como estados independientes. El historial LEEME contiene múltiples títulos «actual»: consultar registro consolidado y hash, no decidir por coincidencia textual.
5. Nuestro cuello de botella más grave es perder certeza sobre qué se ejecutó y qué se guardó. Aumentar todos los timeouts solo prolonga esa incertidumbre.

## Hallazgos de código que afectan directamente al trabajo

### P0: destino de documento implícito durante una operación compuesta

`src/tools/image.ts:49-61` carga el archivo como documento nuevo, y en una segunda solicitud obtiene `app.activeDocument`, copia, cierra y pega en el documento que pase a estar activo. No captura el destino original ni lo selecciona explícitamente antes del pegado. Evidencia estática: dos solicitudes al bridge y ninguna referencia de destino. Riesgo: otro comando o un cambio manual entre fases puede desviar el pegado o hacer cerrar otro documento. No se ha reproducido aquí.

La cola debe excluir intercalación durante toda la operación lógica `place_image`; serializar cada mensaje no basta. La exportación doble tiene el mismo requisito: cambios de visibilidad, exportaciones y restauración forman una operación exclusiva. La selección manual en Photopea sigue siendo una fuente de cambios externos: validar el objetivo al ejecutar cada fase y fallar si ya no se puede identificar.

### P1: leer capas anidadas no permite dirigirse a ellas con precisión

`src/bridge/script-builder.ts:57` resuelve nombres con `app.activeDocument.layers.getByName` e índices en la raíz. `:362` devuelve recursivamente el árbol, pero los índices se reinician en cada grupo y no incluye una referencia completa que otras herramientas acepten. `:341` agrupa por nombres raíz. Nombres duplicados y capas movidas a grupos quedan fuera de un contrato seguro.

Hecho observado de nuestra sesión: `LEEME.md:149-150` describe que mover respecto a un grupo produjo anidamiento inesperado; el fallo posterior de búsqueda se confundió con timeout. Hace falta devolver un error de script con mensaje y objetivo, no aparentar desconexión ni reintentar mutaciones.

### P1: reordenación descrita de forma distinta a la implementada

`src/tools/layer.ts`, herramienta `photopea_reorder_layer`, describe above/below como un paso respecto al índice actual. `src/bridge/script-builder.ts:316` mueve respecto a `app.activeDocument.activeLayer`. El destino depende de la selección activa; si target ya es la capa activa, el código intenta moverla respecto a sí misma. No calcula un vecino ni evita ese caso. Esto demuestra estáticamente la discrepancia de contrato, pero no permite afirmar si Photopea produce no-op, error o un movimiento particular. El anidamiento al usar un grupo como destino está observado en las notas de sesión, no reproducido con esta herramienta. Se necesita destino explícito y comprobar padre/posición después, además de corregir documentación.

### P1: exportación no expresa durabilidad ni conserva un paquete coherente

`src/tools/export.ts:15-42` expone PNG y PSD mediante el mismo método; la descripción afirma que todo se aplana. El código llama `saveToOE(format)` (`script-builder.ts:804`), por lo que esa afirmación sobre PSD no se demuestra y debe corregirse tras prueba de reapertura. Devuelve una ruta, sin tamaño, hash, firma, documento, capas verificadas ni estado de persistencia. `src/utils/file-io.ts:12-17` escribe directamente sobre el destino: una escritura incompleta puede dañar un archivo anterior.

El bridge admite un único resultado de archivo; el procedimiento actual de exportar regiones exige varias llamadas manuales. Una pareja de PNG correcta no demuestra que el PSD se haya guardado; un encabezado PSD válido no demuestra que sus capas estén completas.

### P1: origen de SVG y bounds tienen semánticas distintas

`src/tools/image.ts:65-86` ajusta tamaño y posición utilizando bounds de píxeles visibles; x/y sitúan la esquina de esos bounds. Es razonable para un logo recortado, pero puede desplazar una máscara SVG de atlas completo cuyo contenido ocupa solo una isla. `build-artwork.py:17` usa SVG 4096 con viewBox 1600: el origen del lienzo y el del contenido no son intercambiables.

`get_layers` usa `.value`; place_image usa una conversión propia con valores alternativos. Centralizar extracción numérica finita, reconocer cero y rechazar bounds vacíos antes de transformar. Observación local: `.as('px')` devolvió NaN; no asumir compatibilidad DOM Photoshop completa.

### P2: capacidades descritas con más precisión de la que implementan

`buildAddShape` sí está conectado: `src/tools/text.ts:73-91` registra `photopea_add_shape` y llama al builder. Sin embargo, el esquema solo permite rectangle/ellipse (`:77`): la mención polygon en el comentario del builder (`script-builder.ts:523`) no es una capacidad MCP expuesta ni un fallo alcanzable por ese parámetro. La discrepancia alcanzable es que la herramienta promete una forma vectorial redimensionable sin pérdida (`text.ts:75`), mientras el builder (`script-builder.ts:511-540`) crea artLayers y rellena/traza selecciones raster. `:718` solo crea selección replace de rectángulo/elipse, sin intersección de transparencia ni opción antialias explícita. `:637` ofrece transformaciones relativas sin resultado geométrico. `buildAddFillLayer` crea una capa raster rellena, aunque la herramienta la describe como adjustment-style. `get_layers` promete blendMode pero no lo incluye.

Estas diferencias importan al reconstruir diagonales, preservar alfa y comparar antes/después. No hace falta implementar todo Photoshop: corregir contratos y añadir solo primitivas comprobadas.

## Frontera de responsabilidades

| MCP genérico | Skills y atlas | Utilidades externas |
| --- | --- | --- |
| Identificar documentos/capas, ejecutar con exclusión, inspeccionar geometría y visibilidad, importar SVG preservando origen, guardar archivos durables, exportar variantes con estado restaurado | Coche, año, template, Customer/Team ID, nombres de capas oficiales, paletas, ejes locales UV, regiones por material, capas guía a ocultar, secuencia de revisión 3D | Generar SVG y cuadrículas numeradas, analizar diferencias/máscaras/halos, convertir y verificar TGA, instalar con backup y rollback, registrar hashes y evidencia |

No incorporar coordenadas M4, IDs personales, rutas Steam ni colores de materiales LMU en el servidor. La API de variantes recibe selectores y estados explícitos; la skill aporta el perfil LMU. No crear comandos `export_lmu` o `mirror_car_side` que oculten diferencias de plantilla.

La utilidad existente `sim-livery-tools/skills/livery-photopea/scripts/texture_files.py:83-165` ya instala pares con backup, staging, comprobación de cambios y rollback. Mantenerla como componente de archivos. Su par de reemplazos no es una transacción atómica frente a un simulador leyendo simultáneamente; la skill debe instalar en el momento apropiado. Evitar duplicar este instalador en MCP.

## Plan de capacidades, orden y aceptación

### A. Ejecución observable y PSD durable (primero)

Interfaz mínima orientativa: cada operación devuelve `operationId`, estado y fase; una consulta obtiene `queued/running/waiting_for_file/writing/completed/failed/unknown`, tiempos, documento objetivo y error. Separar espera en cola, ejecución y transferencia. Un timeout de cliente no cancela mágicamente el trabajo de Photopea; no reintentar por defecto un paste, move relativo, duplicate ni script arbitrario.

Si la ejecución supera el plazo y se ignora su estado, detener despacho de nuevas mutaciones sobre esa sesión hasta reconciliarla. Si ya empezó la escritura local, registrar resultado durable aunque haya expirado el cliente. Cancelar solo lo que realmente pueda cancelarse y distinguir cancelación de espera del estado del motor.

`save_document({document, outputPath, overwritePolicy})` puede ser una modalidad de exportación, sin crear una familia grande de tools. Devolver ruta, bytes, hash, firma/formato y etapa de validación. Escribir temporal en el directorio destino, verificar y reemplazar al completar; nunca sustituir un PSD bueno por una transferencia parcial. Preservar el temporal fallido con metadatos o retirarlo según política explícita.

Aceptación: fixture sintético 4096 con grupos, capas ocultas, transparencias, ajuste y texto; guardar y reabrir en documento temporal, comparar dimensiones, árbol/visibilidades, muestras o compuesto contra original. Ensayar desconexión antes/durante transferencia, escritura fallida y cliente que deja de esperar. El PSD anterior permanece intacto y cada resultado distingue `archivo guardado` de `reapertura validada`. Registrar métricas reales de tamaño/duración/memoria antes de elegir límites. La causa de v18 sigue sin probarse.

### B. Referencias explícitas y operaciones compuestas

Proponer `list_documents()` y `document` opcional en operaciones existentes. No prometer IDs persistentes sin comprobar soporte real de Photopea. Si se usan referencias efímeras, deben estar ligadas a sesión/generación y fallar al quedar obsoletas; nombres iguales requieren desambiguación.

Añadir a `get_layers` un selector reutilizable, padre, bounds finitos, visibilidad propia/efectiva y propiedades realmente disponibles. Preferir IDs comprobados; alternativa: ruta estructurada por grupos con nombre y ordinal más comprobación de identidad antes de editar. No aceptar silenciosamente el primer duplicado.

Corregir `place_image` para capturar destino y encapsular carga/copia/pegado/cierre en operación exclusiva. Cerrar únicamente el documento auxiliar creado por la operación; si la identidad queda dudosa, conservarlo y devolver estado recuperable. Reordenar con `{target, relativeTo, placement}` o padre/posición explícitos y devolver árbol parcial resultante.

Aceptación: dos documentos con el mismo nombre, duplicados de `Region 0`, tres niveles de grupos, cambio de documento activo manual, reordenación concurrente y fallo entre carga y pegado. Cero edición en documento equivocado; error de objetivo antes de mutar. Retorno de padre y bounds permite revisar el resultado.

### C. Exportación de variantes con recuperación de visibilidad

Interfaz pequeña: `export_variants({document, outputs:[{name,format,outputPath,visibility:[{layer,visible}]}], restoreVisibility:true})`. Las modificaciones declaradas se resuelven y validan antes de empezar. Adquirir exclusión por toda la secuencia, capturar estado inicial, exportar cada variante a staging, restaurar al finalizar. Para dos archivos no prometer commit atómico del sistema de archivos: publicar un manifiesto de conjunto completo solo después de verificar ambos, o usar directorio nuevo de revisión.

Guardar PSD como checkpoint de edición antes de exportar variantes y conservar su correspondencia de revisión. El checkpoint y los outputs tienen hashes separados. La restauración de visibilidad no implica revertir cambios de historial o modified flag. Si desconecta antes de restaurar, informar qué capas quedaron alteradas y guardar un manifiesto de restauración; no declarar restauración por ejecutar `finally` sin bridge vivo.

Aceptación LMU sintética: Region/Region 0, máscara del alerón fuera del grupo, Levels y guías. PNG albedo sin guías y con ajuste esperado; regiones exactas sin filtración de albedo; misma geometría del decal en ambos. Error en segundo export preserva primeros resultados como incompletos, mantiene revisión anterior y comunica restauración verificada o pendiente. La utilidad externa solo instala conjuntos completos.

### D. Importación vectorial y geometría verificable

Extender `place_image` con contrato explícito de origen `canvas` frente a `contentBounds` y política de escala; devolver bounds antes/después y selector creado. Para SVG de atlas, preservar dimensiones y origen del documento fuente. No asumir que copy/paste conserva margen transparente: probar y corregir mediante offsets medidos.

Añadir después una operación de transformación con posición absoluta/centro y precondición de bounds, conservando proporciones por defecto. Transformaciones compartidas entre albedo y máscara se aplican como conjunto exclusivo, con comprobación y reporte de fallo parcial. No garantizar rollback por un simple undo: varias acciones pueden ocupar distinto número de estados.

Aceptación: SVG 4096/viewBox1600 con isla mínima lejos del origen, transparencia periférica, wordmark rotado, espejo de geometría sin espejo de letras, PNG totalmente transparente y bounds de cero. Comparar píxeles/offsets contra fixture conocido; error claro para contenido vacío.

### E. Recolores y diagnóstico (tras estabilizar guardado)

Una primitiva genérica de rellenar/recolorear preservando alfa y selección por polígono/transparencia puede reducir scripts repetidos. El diagnóstico por color y proximidad permanece en Python; genera máscara/SVG, Photopea rasteriza y compone. No ofrecer `remove_all_green` ni declarar sombras/materiales corregidos mediante edición de albedo.

Aceptación: logo con antialias, tonos de borde, otros patrocinadores con mismo verde fuera de la máscara, parche diagonal y alfa invariable. Comparación limitada a región declarada. El caso iRacing de fantasmas spec/decal queda en la skill (`APRENDIZAJES-GENERALES.md:33-37`), con comprobación real del simulador.

## Desconocidos que requieren prueba controlada

- Causa real del fallo v18; tamaño por sí solo no la prueba.
- Identificadores de documento/capa disponibles y estabilidad después de reordenar, duplicar y reabrir.
- Cuánto estado persiste entre scripts, y forma correcta de encapsular captura/restauración; las notas dicen que no se deben depender de variables globales entre llamadas.
- Semántica exacta de `saveToOE('psd')` para grupos/ajustes y límites de recursos del navegador con nuestros PSD.
- Bounds de contenido frente a canvas durante copy merged/paste de SVG; comportamiento de grupos y Layer.move debe verificarse en Photopea real.
- Compatibilidad de hue/saturation: en sesión la llamada no dio el efecto esperado; no elevarla a capacidad fiable con pruebas que solo comprueban cadenas JS.

La revisión de código detecta contratos y riesgos. El cierre requiere tests de protocolo con fallos inyectados y una prueba real con fixtures independientes; nunca usar la única sesión con v18 sin guardar como banco de pruebas.

