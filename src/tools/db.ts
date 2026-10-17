import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import { DatabaseSync } from "node:sqlite";
import { checkPath, normalize } from "./files.js";

// Minimal .env parser (Laravel style: KEY=VALUE, quotes, # comments).
function parseDotEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // strip trailing unquoted comment: `KEY=val # comment`
    if (!(v.startsWith('"') || v.startsWith("'"))) {
      const ci = v.search(/\s+#/);
      if (ci >= 0) v = v.slice(0, ci).trim();
    }
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function stripLeadingComments(s: string): string {
  let t = s.trim();
  for (;;) {
    if (t.startsWith("--")) {
      const i = t.indexOf("\n");
      if (i < 0) return "";
      t = t.slice(i + 1).trim();
      continue;
    }
    if (t.startsWith("/*")) {
      const i = t.indexOf("*/");
      if (i < 0) return "";
      t = t.slice(i + 2).trim();
      continue;
    }
    break;
  }
  return t;
}

type SqlCheck = { ok: true; clean: string } | { ok: false; err: string };

function validateSql(sql: string): SqlCheck {
  let t = sql.trim();
  if (!t) return { ok: false, err: "sql is empty" };
  if (t.length > 8000) return { ok: false, err: "sql too long (max 8000 chars)" };
  t = t.replace(/;\s*$/, ""); // satu trailing semicolon boleh
  if (t.includes(";"))
    return { ok: false, err: "multiple statements are not allowed" };
  if (/\binto\s+(outfile|dumpfile)\b/i.test(t))
    return { ok: false, err: "INTO OUTFILE/DUMPFILE is not allowed" };
  const first =
    stripLeadingComments(t).split(/\s+/)[0]?.toUpperCase() || "";
  if (!["SELECT", "WITH", "VALUES", "EXPLAIN", "TABLE"].includes(first))
    return { ok: false, err: `only read-only queries allowed (got '${first}')` };
  return { ok: true, clean: t };
}

// HOMELAB_DB_OVERRIDES="pgsql=127.0.0.1:5433" — untuk DB yang hostname-nya
// hanya dikenal di dalam docker network.
function getDbOverrides(): Record<string, string> {
  const raw = process.env.HOMELAB_DB_OVERRIDES || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function resolveDbEndpoint(
  host: string,
  port: number
): Promise<{ host: string; port: number }> {
  const ov = getDbOverrides()[host];
  if (ov) {
    const [h, p] = ov.split(":");
    return { host: h || host, port: p ? parseInt(p, 10) : port };
  }
  try {
    await dns.lookup(host);
    return { host, port };
  } catch {
    throw new Error(
      `cannot resolve DB host '${host}'. Set HOMELAB_DB_OVERRIDES, e.g. HOMELAB_DB_OVERRIDES=${host}=127.0.0.1:${port}`
    );
  }
}

function ensureLimit(sql: string, limit: number): string {
  const first = stripLeadingComments(sql).split(/\s+/)[0]?.toUpperCase() || "";
  if (first === "EXPLAIN") return sql;
  if (/\blimit\b/i.test(sql)) return sql;
  return `${sql} LIMIT ${limit}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new Error(`query timed out after ${ms / 1000}s`));
      }
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function queryPostgres(
  env: Record<string, string>,
  sql: string,
  limit: number,
  timeoutSecs: number
): Promise<any[]> {
  const ep = await resolveDbEndpoint(
    env.DB_HOST || "127.0.0.1",
    parseInt(env.DB_PORT || "5432", 10)
  );
  const client = new PgClient({
    host: ep.host,
    port: ep.port,
    database: env.DB_DATABASE,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    const res = await withTimeout(
      client.query(ensureLimit(sql, limit)),
      timeoutSecs * 1000,
      () => client.end().catch(() => {})
    );
    return res.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function queryMysql(
  env: Record<string, string>,
  sql: string,
  limit: number,
  timeoutSecs: number
): Promise<any[]> {
  const ep = await resolveDbEndpoint(
    env.DB_HOST || "127.0.0.1",
    parseInt(env.DB_PORT || "3306", 10)
  );
  const conn = await mysql.createConnection({
    host: ep.host,
    port: ep.port,
    database: env.DB_DATABASE,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    connectTimeout: 10000,
  });
  try {
    const [rows] = await withTimeout(
      conn.query(ensureLimit(sql, limit)),
      timeoutSecs * 1000,
      () => conn.destroy()
    );
    return rows as any[];
  } finally {
    await conn.end().catch(() => {});
  }
}

function querySqlite(
  projectDir: string,
  env: Record<string, string>,
  sql: string,
  limit: number
): any[] {
  let dbPath = env.DB_DATABASE || "database/database.sqlite";
  if (!dbPath.startsWith("/")) dbPath = path.join(projectDir, dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true, open: true } as any);
  try {
    return db.prepare(ensureLimit(sql, limit)).all() as any[];
  } finally {
    db.close();
  }
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function safeJson(v: any): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? val.toString() : val
  );
}

export function registerDbTools(server: McpServer) {
  server.tool(
    "db_query",
    "Run a READ-ONLY SQL query (SELECT/WITH) against a Laravel project's database. Credentials come from the project's .env — never returned. Rows capped by limit.",
    {
      project_dir: z
        .string()
        .describe(
          "Absolute Laravel project path inside HOMELAB_PROJECT_DIRS (contains .env)"
        ),
      sql: z.string().describe("Single SELECT query (read-only; no stacked statements)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows (default 50, max 500)"),
      timeout_secs: z
        .number()
        .int()
        .min(5)
        .max(120)
        .optional()
        .describe("Query timeout in seconds (default 30)"),
    },
    async ({ project_dir, sql, limit, timeout_secs }) => {
      const perr = checkPath(project_dir);
      if (perr) return text(`Error: ${perr}`);
      const dir = normalize(project_dir);

      let envRaw: string;
      try {
        envRaw = await fs.readFile(path.join(dir, ".env"), "utf8");
      } catch {
        return text(`Error: cannot read .env in ${dir}`);
      }
      const env = parseDotEnv(envRaw);

      const chk = validateSql(sql);
      if (!chk.ok) return text(`Error: ${chk.err}`);

      const lim = Math.min(Math.floor(limit ?? 50), 500);
      const to = Math.min(Math.floor(timeout_secs ?? 30), 120);
      const driver = (env.DB_CONNECTION || "").toLowerCase();

      try {
        let rows: any[];
        if (driver === "pgsql" || driver === "postgres" || driver === "postgresql") {
          rows = await queryPostgres(env, chk.clean, lim, to);
        } else if (driver === "mysql" || driver === "mariadb") {
          rows = await queryMysql(env, chk.clean, lim, to);
        } else if (driver === "sqlite") {
          rows = querySqlite(dir, env, chk.clean, lim);
        } else {
          return text(`Error: unsupported DB_CONNECTION '${env.DB_CONNECTION}' (supported: pgsql, mysql, sqlite)`);
        }
        const out = safeJson({ rows, rowCount: rows.length });
        const MAX = 12000;
        return text(
          out.length > MAX
            ? out.slice(0, MAX) + `\n... (truncated, ${rows.length} rows)`
            : out
        );
      } catch (e: any) {
        return text(`Error: ${e.message.split("\n")[0]}`);
      }
    }
  );
}
