import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// HOMELAB_HOSTS format: "name=user@host,name2=user2@host2"
// Example: "server1=alice@192.0.2.10,server2=bob@192.0.2.11"
export function getHosts(): Record<string, string> {
  const raw = process.env.HOMELAB_HOSTS || "";
  const hosts: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const name = part.slice(0, idx).trim();
      const target = part.slice(idx + 1).trim();
      if (name && target) hosts[name] = target;
    }
  }
  return hosts;
}

async function sh(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return stdout.trim() || "(no output)";
  } catch (err: any) {
    return `Error: ${err.message.split("\n")[0]}`;
  }
}

// Run a fixed read-only command on the LOCAL machine (via sh -c).
export function runLocal(cmd: string, timeoutMs = 10000): Promise<string> {
  return sh("sh", ["-c", cmd], timeoutMs);
}

// Run a fixed read-only command on a REMOTE host via SSH (key auth).
// `host` must be a name from HOMELAB_HOSTS; the target comes from config,
// never from raw user input, so no injection via the host parameter.
export function runRemote(host: string, cmd: string, timeoutMs = 20000): Promise<string> {
  const target = getHosts()[host];
  if (!target) {
    const known = Object.keys(getHosts()).join(", ") || "(none configured)";
    return Promise.resolve(
      `Error: unknown host '${host}'. Configured hosts: ${known}. Set HOMELAB_HOSTS env var.`
    );
  }
  return sh(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      target, cmd,
    ],
    timeoutMs
  );
}

// Route a command to local or remote based on the optional host param.
export function runOn(
  host: string | undefined,
  cmd: string,
  timeoutMs?: number
): Promise<string> {
  return host
    ? runRemote(host, cmd, timeoutMs ?? 20000)
    : runLocal(cmd, timeoutMs ?? 10000);
}
