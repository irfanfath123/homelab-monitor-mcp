import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOn, getHosts } from "../ssh.js";

const hostParam = {
  host: z
    .string()
    .optional()
    .describe(
      "Server name from HOMELAB_HOSTS (e.g. 'sil-baru'). Omit to run on the local machine."
    ),
};

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function validName(name: string): boolean {
  return /^[a-zA-Z0-9_@.-]{1,64}$/.test(name);
}

export function registerSystemTools(server: McpServer) {
  server.tool(
    "system_info",
    "Get system uptime, load average, memory and disk usage (read-only)",
    hostParam,
    async ({ host }) => {
      const [uptime, load, mem, disk] = await Promise.all([
        runOn(host, "uptime"),
        runOn(host, "cat /proc/loadavg"),
        runOn(host, "free -h"),
        runOn(host, "df -h /"),
      ]);
      const label = host ? ` (host: ${host})` : " (local)";
      return text(
        [`=== system_info${label} ===`, uptime, load, mem, disk].join("\n")
      );
    }
  );

  server.tool(
    "service_status",
    "Check systemd service status (read-only)",
    {
      ...hostParam,
      service: z.string().describe("Service name, e.g. 'docker' or 'nginx'"),
    },
    async ({ host, service }) => {
      if (!validName(service))
        return text(`Error: invalid service name '${service}'.`);
      const out = await runOn(
        host,
        `systemctl is-active ${service} 2>&1; echo ---; systemctl show ${service} -p ActiveState,SubState,MainPID 2>&1`
      );
      return text(out);
    }
  );

  server.tool(
    "port_listening",
    "List listening TCP ports and owning processes (read-only, like 'ss -tlnp')",
    hostParam,
    async ({ host }) => text(await runOn(host, "ss -tlnp 2>&1 | head -40"))
  );

  server.tool(
    "disk_detail",
    "Disk usage: all mounts plus largest top-level directories (read-only)",
    hostParam,
    async ({ host }) => {
      const [df, du] = await Promise.all([
        runOn(host, "df -h 2>&1"),
        runOn(host, "du -xhd1 / 2>/dev/null | sort -rh | head -12"),
      ]);
      return text(["=== df -h ===", df, "=== largest dirs under / ===", du].join("\n"));
    }
  );

  server.tool(
    "list_hosts",
    "List remote servers configured via HOMELAB_HOSTS env var",
    {},
    async () => {
      const hosts = getHosts();
      const names = Object.keys(hosts);
      return text(
        names.length
          ? "Configured hosts:\n" + names.map((n) => `- ${n} (${hosts[n]})`).join("\n")
          : "No hosts configured. Set HOMELAB_HOSTS, e.g.\nHOMELAB_HOSTS=server1=alice@192.0.2.10,server2=bob@192.0.2.11"
      );
    }
  );
}
