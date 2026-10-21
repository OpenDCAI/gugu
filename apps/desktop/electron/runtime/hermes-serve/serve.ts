// `hermes serve` as an owned child, plus the bridge-owned managed overlay it reads.
//
// The user's HERMES_HOME is inherited untouched (their SOUL, skills, memory, providers, MCP servers, session
// store). Gugu's additions — this conversation's MCP servers and, on a platform session, the platform provider —
// go into Hermes' managed scope (`HERMES_MANAGED_DIR`: deep-merged per leaf over the user's config, `${VAR}`
// expanded from the process env only), in a private 0700 dir that lives as long as this bridge.
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { spawnOwnedChild, type OwnedChild } from '../../../../../packages/session-core/src/exec/owned-child.ts';
import { HERMES_TRANSPORT } from '../../../../../packages/session-plugins/src/agents/impl/hermes/platform.ts';
import { PLATFORM_PROVIDER, type Json } from './mapping.ts';

export type AcpMcpServer = {
  name?: string;
  url?: string;
  headers?: { name?: string; value?: string }[];
  command?: string;
  args?: string[];
  env?: { name?: string; value?: string }[];
};

export type PlatformRelay = { baseUrl: string; apiKey: string };

/** Secret values never enter the overlay file: it names `${GUGU_HERMES_SECRET_<n>}`, the value rides serve's env. */
export function managedOverlay(servers: readonly AcpMcpServer[], platform: PlatformRelay | null): { config: Json; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const secret = (value: string) => {
    const name = `GUGU_HERMES_SECRET_${Object.keys(env).length}`;
    env[name] = value;
    return `\${${name}}`;
  };
  const mcp: Json = {};
  for (const server of servers) {
    const name = String(server.name ?? '').trim();
    if (!name || name in mcp) throw new Error(`duplicate or empty MCP server name: ${name || '<empty>'}`);
    if (server.url) {
      const headers = Object.fromEntries((server.headers ?? []).map((h) => [String(h.name ?? ''), secret(String(h.value ?? ''))]));
      mcp[name] = { url: server.url, ...(Object.keys(headers).length ? { headers } : {}) };
    } else if (server.command) {
      const vars = Object.fromEntries((server.env ?? []).map((e) => [String(e.name ?? ''), secret(String(e.value ?? ''))]));
      mcp[name] = { command: server.command, args: server.args ?? [], ...(Object.keys(vars).length ? { env: vars } : {}) };
    } else {
      throw new Error(`MCP server ${name} has neither url nor command`);
    }
  }
  const config: Json = { mcp_servers: mcp };
  if (platform) {
    env.GUGU_HERMES_PLATFORM_KEY = platform.apiKey;
    config.providers = {
      [PLATFORM_PROVIDER]: {
        name: 'Gugu',
        base_url: platform.baseUrl,
        api_key: '${GUGU_HERMES_PLATFORM_KEY}',
        // Named providers default to Chat Completions; the protocol is the plugin's declared one (Phase 0: Responses).
        transport: HERMES_TRANSPORT,
      },
    };
  }
  return { config, env };
}

/**
 * `HERMES_MANAGED_DIR` replaces the default managed dir (`/etc/hermes` on POSIX). An organisation that already
 * pushes policy there keeps it: its `config.yaml` / `.env` are carried into the private dir and win on collision.
 */
function existingManagedDir(env: NodeJS.ProcessEnv): string | null {
  const configured = env.HERMES_MANAGED_DIR?.trim();
  const dir = configured || (process.platform === 'win32' ? '' : '/etc/hermes');
  return dir && existsSync(dir) ? dir : null;
}

function writeManagedDir(overlay: Json, env: NodeJS.ProcessEnv): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-hermes-managed-'));
  const org = existingManagedDir(env);
  let merged = overlay;
  if (org) {
    const orgConfigPath = join(org, 'config.yaml');
    if (existsSync(orgConfigPath)) {
      const orgConfig = (parseYaml(readFileSync(orgConfigPath, 'utf8')) ?? {}) as Json;
      merged = { ...orgConfig };
      for (const key of ['mcp_servers', 'providers'] as const) {
        if (overlay[key]) merged[key] = { ...(overlay[key] as Json), ...((orgConfig[key] as Json | undefined) ?? {}) };
      }
    }
    if (existsSync(join(org, '.env'))) cpSync(join(org, '.env'), join(dir, '.env'));
  }
  // JSON is valid YAML: no YAML writer needed.
  writeFileSync(join(dir, 'config.yaml'), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

export type Serve = { port: number; token: string; stop(): Promise<void> };

/** Start `hermes serve --isolated` on a free loopback port; resolves on its READY line. */
export async function startServe(opts: {
  bin: string;
  overlay: { config: Json; env: Record<string, string> };
  env: NodeJS.ProcessEnv;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}): Promise<Serve> {
  const managedDir = writeManagedDir(opts.overlay.config, opts.env);
  const token = randomBytes(32).toString('base64url');
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    ...opts.overlay.env,
    HERMES_MANAGED_DIR: managedDir,
    HERMES_GATEWAY_LOCK_DIR: join(managedDir, 'locks'),
    HERMES_DASHBOARD_SESSION_TOKEN: token,
    HERMES_PARENT_PID: String(process.pid),
  };
  const loopback = '127.0.0.1,localhost,::1';
  env.NO_PROXY = [env.NO_PROXY, loopback].filter(Boolean).join(',');
  env.no_proxy = env.NO_PROXY;
  let child: OwnedChild | null = null;
  const cleanup = () => rmSync(managedDir, { recursive: true, force: true });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child = spawnOwnedChild(opts.bin, ['serve', '--isolated', '--host', '127.0.0.1', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        onError: reject,
      });
      const proc = child.child;
      let buffered = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const ready = /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m.exec(buffered);
        if (ready) resolve(Number(ready[1]));
      });
      proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      proc.on('exit', (code, signal) => {
        cleanup();
        reject(new Error(`hermes serve exited before it was ready (code=${code} signal=${signal})`));
        opts.onExit(code, signal);
      });
    });
    const owned = child as unknown as OwnedChild;
    return { port, token, stop: () => owned.stop().finally(cleanup) };
  } catch (error) {
    (child as OwnedChild | null)?.kill();
    cleanup();
    throw error;
  }
}
