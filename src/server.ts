// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PhotopeaBridge } from "./bridge/websocket-server.js";
import { registerDocumentTools } from "./tools/document.js";
import { registerLayerTools } from "./tools/layer.js";
import { registerTextTools } from "./tools/text.js";
import { registerImageTools } from "./tools/image.js";
import { registerExportTools } from "./tools/export.js";
import { VERSION } from "./version.js";
import { EditorSession } from './livery/session.js';
import { LiveryWorkflows } from './livery/workflows.js';
import { registerLiveryTools } from './tools/livery.js';

export function createServer(bridge: PhotopeaBridge): McpServer {
  const server = new McpServer({ name: "photopea-mcp-server", version: VERSION });
  const session=new EditorSession(bridge),workflows=new LiveryWorkflows(session);
  registerDocumentTools(server, bridge);
  registerLayerTools(server, bridge,session);
  registerTextTools(server, bridge);
  registerImageTools(server, bridge,workflows);
  registerExportTools(server, bridge);
  registerLiveryTools(server,session,workflows);
  return server;
}
