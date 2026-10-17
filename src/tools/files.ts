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

// Allowed roots, colon-separated absolute paths, e.g.
// HOMELAB_PROJECT_DIRS=/home/user/projects:/srv/apps
function getAllowedDirs(): string[] {
  const raw = process.env.HOMELAB_PROJECT_DIRS || "";
  return raw
    .split(":")
    .map((s) => normalize(s.trim()))
    .filter((s) => s.startsWith("/"));
}

export function normalize(p: string): string {
  let n = p.replace(/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

// Security gate: absolute path, no '..', inside an allowed dir.
// Note: this validates the literal path string. It cannot resolve symlinks
// on the remote host — keep allowed dirs free of untrusted symlinks.
export function checkPath(p: string): string | null {
  if (!p.startsWith("/")) return "path must be absolute";
  const n = normalize(p);
  if (n.split("/").includes("..")) return "path must not contain '..'";
  const allowed = getAllowedDirs();
  if (!allowed.length)
    return "no allowed directories configured (set HOMELAB_PROJECT_DIRS)";
  const ok = allowed.some((d) => n === d || n.startsWith(d + "/"));
  if (!ok) return `path outside allowed directories: ${allowed.join(", ")}`;
  return null;
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

const PATH_DESC =
  "Absolute path inside HOMELAB_PROJECT_DIRS (e.g. '/home/user/projects/api')";

export function registerFileTools(server: McpServer) {
  server.tool(
    "list_dir",
    "List directory contents (read-only)",
    { ...hostParam, path: z.string().describe(PATH_DESC) },
    async ({ host, path }) => {
      const err = checkPath(path);
      if (err) return text(`Error: ${err}`);
      return text(
        await runOn(host, `ls -la -- ${shQuote(normalize(path))} 2>&1 | head -100`)
      );
    }
  );

  server.tool(
    "read_file",
    "Read a text file with line pagination (read-only)",
    {
      ...hostParam,
      path: z.string().describe(PATH_DESC),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line to read (default 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max lines to read (default 200, max 500)"),
    },
    async ({ host, path, offset, limit }) => {
      const err = checkPath(path);
      if (err) return text(`Error: ${err}`);
      const o = Math.floor(offset ?? 1);
      const l = Math.min(Math.floor(limit ?? 200), 500);
      const end = o + l - 1;
      return text(
        await runOn(host, `sed -n '${o},${end}p' -- ${shQuote(normalize(path))} 2>&1`)
      );
    }
  );

  server.tool(
    "edit_file",
    "Replace text in a file. WRITE action — your MCP client will ask for approval before running it. old_text must occur exactly once.",
    {
      ...hostParam,
      path: z.string().describe(PATH_DESC),
      old_text: z.string().describe("Exact text to find (must occur exactly once)"),
      new_text: z.string().describe("Replacement text"),
    },
    async ({ host, path, old_text, new_text }) => {
      const err = checkPath(path);
      if (err) return text(`Error: ${err}`);
      if (!old_text) return text("Error: old_text is empty");
      const p = shQuote(normalize(path));

      // 1. Read current content
      const current = await runOn(host, `cat -- ${p} 2>&1`);
      if (current.startsWith("Error:")) return text(current);

      // 2. Replace in memory (exactly-once guard)
      const count = current.split(old_text).length - 1;
      if (count === 0) return text("Error: old_text not found in file");
      if (count > 1)
        return text(`Error: old_text occurs ${count} times — be more specific`);
      const updated = current.replace(old_text, new_text);

      // 3. Write back via base64 pipe (no quoting issues with any content)
      const b64 = Buffer.from(updated, "utf8").toString("base64");
      const res = await runOn(host, `printf '%s' '${b64}' | base64 -d > ${p} 2>&1`);
      if (res.startsWith("Error:")) return text(res);

      return text(
        `Edited OK: ${normalize(path)} (${Buffer.byteLength(updated)} bytes written)`
      );
    }
  );
}
