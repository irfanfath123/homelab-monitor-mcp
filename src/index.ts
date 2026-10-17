#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { registerSystemTools } from "./tools/system.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerFileTools } from "./tools/files.js";
import { registerExecTools } from "./tools/exec.js";
import { registerDbTools } from "./tools/db.js";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "homelab-monitor-mcp",
    version: "0.1.0",
  });
  registerSystemTools(server);
  registerDockerTools(server);
  registerFileTools(server);
  registerExecTools(server);
  registerDbTools(server);
  return server;
}

function checkAuth(req: any, token: string): boolean {
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function runHttp() {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const token = process.env.MCP_AUTH_TOKEN || "";
  if (!token) {
    console.error("MCP_AUTH_TOKEN wajib di-set untuk mode HTTP");
    process.exit(1);
  }
  const httpServer = createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("not found");
      return;
    }
    if (!checkAuth(req, token)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end("method not allowed (stateless: POST only)");
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) req.destroy(); // batasi 1MB
    });
    req.on("end", async () => {
      try {
        // Stateless: server baru per request (SDK tidak boleh re-connect)
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (err) {
        console.error("HTTP handler error:", err);
        if (!res.headersSent) res.writeHead(500).end("internal error");
      }
    });
  });
  httpServer.listen(port, () => {
    console.error(`homelab-monitor-mcp HTTP di :${port}/mcp (stateless)`);
  });
}

async function main() {
  if (process.env.MCP_HTTP_PORT) {
    await runHttp();
    return;
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("homelab-monitor-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
