// src/tools/export.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PhotopeaBridge } from "../bridge/websocket-server.js";
import {
  buildExportImage,
  buildRunScript,
  buildUndo,
  buildRedo,
} from "../bridge/script-builder.js";
import { fetchUrlToBuffer } from "../utils/file-io.js";

export function registerExportTools(server: McpServer, bridge: PhotopeaBridge): void {
  server.registerTool("photopea_get_status", {
    description: "Inspect bridge/session readiness, queue, and the active operation without opening a browser.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(bridge.getStatus()) }] }));
  server.registerTool("photopea_get_operation", {
    description: "Inspect an operation by ID, including late results and persisted artifact path/hash. Polling never repeats the operation.",
    inputSchema: { operationId: z.string().uuid() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ operationId }) => {
    const op = bridge.getOperation(operationId);
    return { isError: !op, content: [{ type: "text", text: JSON.stringify(op ?? { error: "Unknown or expired operation" }) }] };
  });
  server.registerTool("photopea_cancel_operation", {
    description: "Cancel only a queued operation. A running Photopea execution cannot be interrupted or undone by this tool.",
    inputSchema: { operationId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ operationId }) => {
    try { return { content: [{ type: "text", text: bridge.cancelOperation(operationId) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text", text: (e as Error).message }] }; }
  });
  server.registerTool("photopea_export_artifacts", {
    description: "Start one export and return its operation ID immediately. Use get_operation until completed. PSD preserves layers; raster formats flatten. Requires a NEW absolute output path; existing files are preserved. Binary transfer, SHA-256 and structural validation precede publication. Reopening is a separate editability check. Do not edit the UI during export. This milestone exports one artifact, not a variants bundle.",
    inputSchema: { format: z.enum(["png", "jpg", "webp", "psd", "svg"]), outputPath: z.string(), quality: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async params => {
    try {
      const operationId = bridge.startExport(buildExportImage(params), params.outputPath, params.format);
      return { content: [{ type: "text", text: JSON.stringify({ operationId, state: "queued_or_running" }) }] };
    } catch (e) { return { isError: true, content: [{ type: "text", text: (e as Error).message }] }; }
  });
  // 30. photopea_export_image
  server.registerTool("photopea_export_image", {
    title: "Export Image",
    description: "Export the active document to a NEW local path with binary transfer, checksum and structural validation. PSD preserves layers; raster formats flatten. Existing files are never replaced. For long PSD exports prefer export_artifacts and poll get_operation. Reopen separately to check editability; avoid manual UI edits during export.",
    inputSchema: {
      format: z.enum(["png", "jpg", "webp", "psd", "svg"]).describe("Output format: 'png' for lossless, 'jpg' for compressed photos, 'webp' for web, 'psd' for Photoshop, 'svg' for vector"),
      quality: z.number().min(1).max(100).optional().describe("Compression quality for JPG format only (1 = smallest file, 100 = best quality). Ignored for other formats."),
      outputPath: z.string().describe("Absolute local file path where the exported file will be saved (e.g. /Users/me/output.png)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (params) => {
    const script = buildExportImage(params);
    bridge.sendActivity({ type: "activity", id: "", tool: "export_image", summary: `Export as ${params.format} to ${params.outputPath}` });
    let rawResult;
    try { rawResult = await bridge.exportToFile(script, params.outputPath, params.format); }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
    if (!rawResult.success) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(rawResult) }] };

    return { content: [{ type: "text" as const, text: JSON.stringify(rawResult) }] };
  });

  // photopea_load_font
  server.registerTool("photopea_load_font", {
    title: "Load Font",
    description: "Load a custom font from a URL (TTF, OTF, or WOFF2) into Photopea. The font becomes available for add_text and edit_text. Use list_fonts to find the PostScript name after loading.",
    inputSchema: {
      url: z.string().describe("URL to a font file (.ttf, .otf, or .woff2)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (params) => {
    bridge.sendActivity({ type: "activity", id: "", tool: "load_font", summary: `Load font: ${params.url.split("/").pop()}` });
    let result;
    try { result = await bridge.loadFile(await fetchUrlToBuffer(params.url), "font"); }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
    if (!result.success) return { isError: true, content: [{ type: "text" as const, text: result.error || "Failed to load font" }] };
    return { content: [{ type: "text" as const, text: `Font loaded from: ${params.url}. Use list_fonts to find its PostScript name.` }] };
  });

  // photopea_list_fonts
  server.registerTool("photopea_list_fonts", {
    title: "List Fonts",
    description: "List available fonts in Photopea. Returns font PostScript names that can be used with add_text and edit_text.",
    inputSchema: {
      search: z.string().optional().describe("Optional search string to filter fonts by name"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (params) => {
    const search = params.search?.toLowerCase();
    const script = search
      ? `var r=[];for(var i=0;i<app.fonts.length;i++){var n=app.fonts[i].postScriptName;if(n.toLowerCase().indexOf(${JSON.stringify(search)})>=0)r.push(n);}app.echoToOE(JSON.stringify(r));`
      : `var r=[];for(var i=0;i<app.fonts.length;i++){r.push(app.fonts[i].postScriptName);}app.echoToOE(JSON.stringify(r));`;
    bridge.sendActivity({ type: "activity", id: "", tool: "list_fonts", summary: `List fonts${search ? `: ${search}` : ""}` });
    const result = await bridge.executeScript(script);
    if (!result.success) return { isError: true, content: [{ type: "text" as const, text: result.error || "Failed to list fonts" }] };
    const data = (result as import("../bridge/types.js").BridgeResult).data || "[]";
    return { content: [{ type: "text" as const, text: data }] };
  });

  // 33. photopea_run_script
  server.registerTool("photopea_run_script", {
    title: "Run Script",
    description: "Execute synchronous Photopea/ExtendScript JavaScript. Has full access to the DOM and can delete document data. Asynchronous app.open(URL), dialogs, and arbitrary postMessage exports are unsupported: use open_file and export_artifacts. A timeout retains editor ownership; query its operation ID instead of replaying mutations.",
    inputSchema: {
      script: z.string().describe("Photopea JavaScript code to execute. Must call app.echoToOE(result) to return data. Has access to the full Photopea scripting API (app, activeDocument, etc.)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (params) => {
    const script = buildRunScript(params.script);
    bridge.sendActivity({ type: "activity", id: "", tool: "run_script", summary: "Run custom script" });
    const result = await bridge.executeScript(script);
    if (!result.success) return { isError: true, content: [{ type: "text" as const, text: result.error || "Script execution failed" }] };
    const scriptResult = result as import("../bridge/types.js").BridgeResult;
    return { content: [{ type: "text" as const, text: scriptResult.data ?? "Script executed successfully" }] };
  });

  // 34. photopea_undo
  server.registerTool("photopea_undo", {
    title: "Undo",
    description: "Undo one or more recent actions in the active document. Each step reverses one operation from the history. Use after destructive operations (apply_filter, apply_adjustment, fill_selection) to revert changes.",
    inputSchema: {
      steps: z.number().int().positive().default(1).describe("Number of history steps to undo (default 1)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => {
    const script = buildUndo(params.steps);
    bridge.sendActivity({ type: "activity", id: "", tool: "undo", summary: `Undo ${params.steps} step(s)` });
    const result = await bridge.executeScript(script);
    if (!result.success) return { isError: true, content: [{ type: "text" as const, text: result.error || "Failed to undo" }] };
    return { content: [{ type: "text" as const, text: `Undid ${params.steps} step(s)` }] };
  });

  // 35. photopea_redo
  server.registerTool("photopea_redo", {
    title: "Redo",
    description: "Redo one or more previously undone actions in the active document. Only available after using undo — the redo history is cleared when new actions are performed.",
    inputSchema: {
      steps: z.number().int().positive().default(1).describe("Number of history steps to redo (default 1)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (params) => {
    const script = buildRedo(params.steps);
    bridge.sendActivity({ type: "activity", id: "", tool: "redo", summary: `Redo ${params.steps} step(s)` });
    const result = await bridge.executeScript(script);
    if (!result.success) return { isError: true, content: [{ type: "text" as const, text: result.error || "Failed to redo" }] };
    return { content: [{ type: "text" as const, text: `Redid ${params.steps} step(s)` }] };
  });
}
