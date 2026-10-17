import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOn } from "../ssh.js";

const hostParam = {
  host: z
    .string()
    .optional()
    .describe(
      "Server name from HOMELAB_HOSTS (e.g. 'sil-baru'). Omit to run on the local machine."
    ),
};

const PS_CMD =
  "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'";
const STATS_CMD =
  "docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// Container/service names go into shell commands — strict whitelist.
function validName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(name);
}

export function registerDockerTools(server: McpServer) {
  server.tool(
    "docker_ps",
    "List Docker containers with status (read-only, like 'docker ps')",
    hostParam,
    async ({ host }) => text(await runOn(host, PS_CMD))
  );

  server.tool(
    "docker_stats",
    "One-shot Docker container CPU/memory usage (read-only, like 'docker stats --no-stream')",
    hostParam,
    async ({ host }) => text(await runOn(host, STATS_CMD))
  );

  server.tool(
    "docker_logs",
    "Read recent logs of a Docker container (read-only)",
    {
      ...hostParam,
      container: z.string().describe("Container name (from docker_ps)"),
      tail: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Number of log lines (default 50, max 500)"),
    },
    async ({ host, container, tail }) => {
      if (!validName(container))
        return text(`Error: invalid container name '${container}'.`);
      const n = Math.floor(tail ?? 50);
      return text(await runOn(host, `docker logs --tail ${n} ${container} 2>&1`));
    }
  );

  server.tool(
    "docker_restart",
    "Restart a Docker container. WRITE action — your MCP client will ask for approval before running it.",
    {
      ...hostParam,
      container: z.string().describe("Container name (from docker_ps)"),
    },
    async ({ host, container }) => {
      if (!validName(container))
        return text(`Error: invalid container name '${container}'.`);
      return text(await runOn(host, `docker restart ${container} 2>&1`));
    }
  );
}
