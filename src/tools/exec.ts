import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOn } from "../ssh.js";
import { checkPath, normalize, shQuote } from "./files.js";

const hostParam = {
  host: z
    .string()
    .optional()
    .describe(
      "Server name from HOMELAB_HOSTS (e.g. 'sil-baru'). Omit to run on the local machine."
    ),
};

// Default binaries allowed. Override with:
// HOMELAB_ALLOW_COMMANDS=npm,node,python3,pytest
const DEFAULT_ALLOW = [
  "npm",
  "npx",
  "node",
  "python3",
  "pytest",
  "tsc",
  "go",
  "cargo",
  "make",
  "git",
];

function getAllowList(): string[] {
  const raw = process.env.HOMELAB_ALLOW_COMMANDS;
  if (!raw) return DEFAULT_ALLOW;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Single simple command only — no chaining, substitution, or redirection.
const FORBIDDEN = /[;&|$`><\n\r]/;

function validateCommand(cmd: string): string | null {
  const t = cmd.trim();
  if (!t) return "command is empty";
  if (t.length > 500) return "command too long (max 500 chars)";
  if (FORBIDDEN.test(t))
    return "command must be a single simple command (no shell metacharacters: ; & | $ ` > <)";
  const bin = (t.split(/\s+/)[0] || "").split("/").pop() || "";
  const allow = getAllowList();
  if (!allow.includes(bin))
    return `'${bin}' is not in the allowlist (${allow.join(", ")}). Set HOMELAB_ALLOW_COMMANDS to change it.`;
  return null;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export function registerExecTools(server: McpServer) {
  server.tool(
    "run_command",
    "Run a dev command (tests, build, typecheck, git) inside a project directory. EXECUTION action — your MCP client will ask for approval before running it. Single command only; the binary must be in HOMELAB_ALLOW_COMMANDS.",
    {
      ...hostParam,
      command: z
        .string()
        .describe("e.g. 'npm test' or 'npx tsc --noEmit' (no shell metacharacters)"),
      workdir: z
        .string()
        .describe("Absolute project path inside HOMELAB_PROJECT_DIRS"),
      timeout_secs: z
        .number()
        .int()
        .min(5)
        .max(600)
        .optional()
        .describe("Timeout in seconds (default 120, max 600)"),
    },
    async ({ host, command, workdir, timeout_secs }) => {
      const perr = checkPath(workdir);
      if (perr) return text(`Error: ${perr}`);
      const cerr = validateCommand(command);
      if (cerr) return text(`Error: ${cerr}`);
      const dir = shQuote(normalize(workdir));
      const timeoutMs = Math.min(Math.floor(timeout_secs ?? 120), 600) * 1000;
      // command is validated metachar-free; cd prefix is ours.
      const out = await runOn(host, `cd -- ${dir} && ${command.trim()} 2>&1`, timeoutMs);
      const MAX = 8000;
      return text(
        out.length > MAX
          ? out.slice(0, MAX) + `\n... (truncated, ${out.length} chars total)`
          : out
      );
    }
  );
}
