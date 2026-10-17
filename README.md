# homelab-monitor-mcp

MCP server for homelab monitoring — let any MCP-compatible AI assistant
(Claude Desktop, ChatGPT, VS Code, ...) check your servers' health in
plain language.

Ask things like:

- "gimana kondisi serverku?"
- "container apa aja yang jalan di sil-baru?"
- "berapa load dan sisa disk?"

## Install (30 seconds)

No clone, no manual setup. In your MCP client config:

```json
{
  "mcpServers": {
    "homelab-monitor": {
      "command": "npx",
      "args": ["-y", "homelab-monitor-mcp"]
    }
  }
}
```

For Claude Desktop, add it to `claude_desktop_config.json` and restart.
`npx` downloads and runs the server automatically.

## Monitoring remote servers via SSH

Define your servers once with the `HOMELAB_HOSTS` env var
(`name=user@host` pairs, comma-separated). SSH key auth is used
(no passwords); the key must already work for these hosts.

```json
{
  "mcpServers": {
    "homelab-monitor": {
      "command": "npx",
      "args": ["-y", "homelab-monitor-mcp"],
      "env": {
        "HOMELAB_HOSTS": "server1=alice@192.0.2.10,server2=bob@192.0.2.11"
      }
    }
  }
}
```

Every tool takes an optional `host` parameter: omit it to check the
local machine, or pass a configured name (`sil-baru`) to check that
server over SSH. Use the `list_hosts` tool to see what's configured.

## Tools

| Tool | Description | Write? |
| ---- | ----------- | ------ |
| `system_info` | Uptime, load average, memory and disk usage | read-only |
| `docker_ps` | Running containers (like `docker ps`) | read-only |
| `docker_stats` | Container CPU/memory usage, one-shot | read-only |
| `docker_logs` | Recent logs of a container (`--tail N`) | read-only |
| `service_status` | systemd service state | read-only |
| `port_listening` | Listening TCP ports and processes | read-only |
| `disk_detail` | All mounts + largest directories | read-only |
| `list_hosts` | Show configured remote servers | read-only |
| `docker_restart` | Restart a container (client asks approval first) | **write** |
| `list_dir` | List directory contents | read-only |
| `read_file` | Read a text file (paginated) | read-only |
| `edit_file` | Replace text in a file (client asks approval first) | **write** |
| `run_command` | Run dev commands: tests, build, typecheck (allowlisted binaries, client asks approval) | **write** |
| `db_query` | Read-only SQL (SELECT/WITH) against a Laravel project's DB, credentials from its `.env` | read-only |

File tools (`list_dir`, `read_file`, `edit_file`) are restricted to
directories in `HOMELAB_PROJECT_DIRS` (colon-separated), e.g.
`HOMELAB_PROJECT_DIRS=/home/user/projects:/srv/apps`.
Paths outside it, relative paths, and `..` are rejected.

Write tools (`docker_restart`, `edit_file`) always ask for your approval
in the MCP client before running.

`run_command` executes binaries from an allowlist
(`HOMELAB_ALLOW_COMMANDS`, default: npm, npx, node, python3, pytest, tsc,
go, cargo, make, git) inside `HOMELAB_PROJECT_DIRS` only. Shell
metacharacters (`;`, `|`, `$`, backticks, redirections) are rejected, so
only a single simple command can run. Also asks approval.

`db_query` takes a Laravel project dir + a SELECT query, reads DB
credentials from the project's `.env` (never returned), and enforces
read-only: only `SELECT`/`WITH`/`EXPLAIN`, single statement, no
`INTO OUTFILE`. Supports PostgreSQL, MySQL/MariaDB, SQLite. If the DB
hostname only resolves inside Docker, map it with
`HOMELAB_DB_OVERRIDES="pgsql=127.0.0.1:5433".

## Requirements

- Node.js 18+
- Docker (only for the `docker_*` tools)
- SSH key access (only for remote hosts)

## Remote access (ChatGPT / web clients)

For clients that connect over the network (e.g. ChatGPT), run in HTTP mode:

```bash
MCP_HTTP_PORT=3000 \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
HOMELAB_HOSTS="server1=alice@192.0.2.10" \
HOMELAB_PROJECT_DIRS="/home/user/projects" \
node dist/index.js
```

- Serves MCP at `http://<host>:3000/mcp` (Streamable HTTP, stateless)
- `MCP_AUTH_TOKEN` is **required** — requests need
  `Authorization: Bearer <token>`
- Expose it with Cloudflare Tunnel / Tailscale Funnel, then add the public
  URL as a remote MCP server in your client.

## Local development

```bash
npm install
npm run build
npm start
```

## Publishing

```bash
npm login
npm publish --access public
```

## License

MIT
