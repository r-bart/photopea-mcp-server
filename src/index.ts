#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve, isAbsolute } from "path";
import { homedir } from "node:os";
import { PhotopeaBridge } from "./bridge/websocket-server.js";
import { createServer } from "./server.js";
import { findAvailablePort } from "./utils/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PORT = Number(process.env.PHOTOPEA_PORT ?? 4117);

async function main(): Promise<void> {
  if(!Number.isInteger(DEFAULT_PORT)||DEFAULT_PORT<1024||DEFAULT_PORT>65535)throw new Error('PHOTOPEA_PORT must be an integer from 1024 to 65535');
  const stateDirectory=process.env.PHOTOPEA_STATE_DIR ?? join(homedir(),'.photopea-mcp');
  if(!isAbsolute(stateDirectory))throw new Error('PHOTOPEA_STATE_DIR must be absolute');
  const port = await findAvailablePort(DEFAULT_PORT);
  const bridge = new PhotopeaBridge(port, { journalDirectory: join(stateDirectory, 'operations') });

  // Serve the frontend HTML on HTTP GET /
  const httpServer = bridge.getHttpServer();

  // Read from src/frontend so it works whether running from dist/ or src/
  const projectRoot = resolve(__dirname, "..");
  const frontendHtml = readFileSync(
    join(projectRoot, "src", "frontend", "index.html"),
    "utf-8"
  );

  httpServer.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/client.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      res.end(readFileSync(join(projectRoot, "src", "frontend", "client.js"), "utf-8"));
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(frontendHtml);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await bridge.start();
  console.error(`Photopea MCP bridge running on http://127.0.0.1:${port}`);

  // Start MCP server over stdio (browser launches lazily on first tool call)
  const mcpServer = createServer(bridge);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("Photopea MCP server ready.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
