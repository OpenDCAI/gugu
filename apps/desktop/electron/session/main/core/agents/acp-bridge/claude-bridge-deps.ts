/**
 * `claude-bridge.ts` 的真实现:读版本、读随包的包、跑随包的 npm、写缓存。逻辑与判断都在那边,
 * 这里只有 IO —— 那边的单测注入假件,不碰 electron、不连网。
 */
import { execFile } from '@gugu/core/local/childProcess';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { execWithStallWatch, resolveBundledNpmInvocation } from '../../../../../engine-downloader';
import { CLAUDE_BRIDGE_KEY, type ClaudeBridgeDeps } from './claude-bridge';
import { getPlugin } from '../plugin-registry';
import { parseCliVersion, parseCompat, type CompatCheck, type VersionedCompat } from './pairing';

const COMPAT_PACKAGE = '@gugu-acp/compat';
const BUNDLED_BRIDGE_ALIAS = '@agentclientprotocol/claude-agent-acp';

export function claudeBridgeCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGuguHome(env), 'acp-bridges');
}

const versionMemo = new Map<string, string | null>();

function execText(command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  // Windows 上 npm 装的 claude 是 `.cmd` 壳,execFile 不经 shell 跑不了(CVE-2024-27980)。
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const file = shell ? `"${command}"` : command;
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, shell, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

function compatFromPackageJson(pkg: { version?: unknown; gugu?: { compat?: unknown } }): VersionedCompat {
  if (typeof pkg.version !== 'string') throw new Error(`${COMPAT_PACKAGE} package.json has no version`);
  return { compatVersion: pkg.version, table: parseCompat(pkg.gugu?.compat) };
}

export const realClaudeBridgeDeps: ClaudeBridgeDeps = {
  async probeCliVersion(cliPath, env) {
    let key = cliPath;
    try {
      const st = statSync(cliPath);
      key = `${cliPath}\u0000${st.mtimeMs}\u0000${st.size}`;
    } catch {
      /* 读不到 stat 就不记忆 */
    }
    if (versionMemo.has(key)) return versionMemo.get(key)!;
    const out = await execText(cliPath, ['--version'], env, 30_000);
    const version = parseCliVersion(out, getPlugin('claude').capabilities.hostDependency.versionLine);
    if (key !== cliPath) versionMemo.set(key, version);
    return version;
  },
  readBundled() {
    const req = createRequire(join(app.getAppPath(), 'package.json'));
    const bridgePkg = req(`${BUNDLED_BRIDGE_ALIAS}/package.json`) as { version: string };
    const compatPkg = req(`${COMPAT_PACKAGE}/package.json`) as { version?: unknown; gugu?: { compat?: unknown } };
    return { bridgeVersion: bridgePkg.version, compat: compatFromPackageJson(compatPkg) };
  },
  async fetchLatestCompat(env) {
    // 走随包的 npm:用户的 registry / 镜像 / 代理配置(.npmrc、npm_config_*)照常生效。
    const npm = resolveBundledNpmInvocation({ ...process.env, ...env }, app.getAppPath());
    const out = await execText(npm.command, [...npm.args, 'view', `${COMPAT_PACKAGE}@latest`, 'version', 'gugu', '--json'], npm.env as Record<string, string>, 60_000);
    return compatFromPackageJson(JSON.parse(out) as { version?: unknown; gugu?: { compat?: unknown } });
  },
  readCache(cacheDir) {
    const file = join(cacheDir, 'compat-cache.json');
    if (!existsSync(file)) return { compat: null, lastCheck: null };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { compat?: { compatVersion: string; table: unknown } | null; lastCheck?: CompatCheck | null };
    return {
      compat: raw.compat ? { compatVersion: raw.compat.compatVersion, table: parseCompat(raw.compat.table) } : null,
      lastCheck: raw.lastCheck ?? null,
    };
  },
  writeCache(cacheDir, data) {
    mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, 'compat-cache.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  },
  async installBridge(spec, destDir, env) {
    const parent = join(destDir, '..');
    mkdirSync(parent, { recursive: true });
    const staging = join(parent, `.staging-${CLAUDE_BRIDGE_KEY}-${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    const npmCache = join(staging, '.npm-cache');
    try {
      const npm = resolveBundledNpmInvocation({ ...process.env, ...env }, app.getAppPath());
      // --omit=optional:不要 SDK 自带的那份原生 claude(~200MB)—— 桥接跑的是用户自己那份。
      await execWithStallWatch(
        npm.command,
        [...npm.args, 'install', '--prefix', staging, '--no-save', '--no-package-lock', '--omit=optional', '--omit=dev',
          '--no-audit', '--no-fund', '--cache', npmCache, spec],
        { env: npm.env },
        staging,
      );
      rmSync(npmCache, { recursive: true, force: true });
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
      renameSync(staging, destDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  },
  exists: (p) => existsSync(p),
  now: () => Date.now(),
};
