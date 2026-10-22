/** Claude bridge selection is protocol-strict: only declared v2 releases
 * are eligible, and any failed selection or installation is an error. */
import { join } from 'node:path';
import { createLogger } from '../../../../../lib/logger';
import {
  newerCompat,
  pickRelease,
  shouldRefreshCompat,
  type CompatCheck,
  type VersionedCompat,
} from './pairing';

const log = createLogger('acp-bridge/claude');

export const CLAUDE_BRIDGE_KEY = 'claude-agent-acp-v2';

export type ClaudeBridgeDeps = {
  /** 用户这份 Claude 的 `--version`;读不出 = null。 */
  probeCliVersion(cliPath: string, env: Record<string, string>): Promise<string | null>;
  /** 随包的桥接版本 + 随包的配对表。 */
  readBundled(): { bridgeVersion: string; protocolVersion?: number; compat: VersionedCompat };
  /** 联网取最新的 `@gugu-acp/compat`。 */
  fetchLatestCompat(env: Record<string, string>): Promise<VersionedCompat>;
  readCache(cacheDir: string): { compat: VersionedCompat | null; lastCheck: CompatCheck | null };
  writeCache(cacheDir: string, data: { compat: VersionedCompat | null; lastCheck: CompatCheck | null }): void;
  /** 把 `spec` 装进 `destDir`(原子:装完才出现)。 */
  installBridge(spec: string, destDir: string, env: Record<string, string>): Promise<void>;
  exists(path: string): boolean;
  now(): number;
};

/** 缓存里某个桥接版本的入口。 */
export function cachedBridgeEntry(cacheDir: string, packageName: string, version: string): string {
  return join(cacheDir, `${CLAUDE_BRIDGE_KEY}@${version}`, 'node_modules', ...packageName.split('/'), 'dist', 'index.js');
}

/**
 * 会话启动等桥接下载时的两个回调:开始等(带上正在下的那一版,`<包>@<版本>`)与等完(成败都调)。
 * 命中随包 / 缓存时两个都不调 —— 启动进度里就不会多出这一步。
 */
export type BridgeWait = {
  onWaiting(bridge: string): void;
  onSettled(): void;
};

/** 按安装目录合并的下载:同一版本只装一次。结果 = 装没装成;失败在任务里记一次日志。 */
const installs = new Map<string, Promise<void>>();
/** 按「缓存目录 × CLI 版本」合并的后台查表。 */
const refreshes = new Map<string, Promise<void>>();

/** Resolve the declared v2 release, awaiting its installation when necessary. */
export async function resolveClaudeBridgeEntry(opts: {
  cliPath: string;
  env: Record<string, string>;
  cacheDir: string;
  deps: ClaudeBridgeDeps;
  wait?: BridgeWait;
}): Promise<string | undefined> {
  const { cliPath, env, cacheDir, deps, wait } = opts;
  const bundled = deps.readBundled();
  const cache = deps.readCache(cacheDir);
  const known = newerCompat(bundled.compat, cache.compat)!;
  const cliVersion = await deps.probeCliVersion(cliPath, env);
  if (!cliVersion) throw new Error('Could not read the Claude CLI version');
  const bridge = known.table.bridges[CLAUDE_BRIDGE_KEY];
  if (!bridge) throw new Error('The compatibility table has no Claude bridge');
  if (shouldRefreshCompat({ bridge, cliVersion, lastCheck: cache.lastCheck, now: deps.now() })) {
    refreshCompatInBackground({ cliVersion, env, cacheDir, deps, cachedCompat: cache.compat });
  }
  const releases = bridge.releases.filter((release) => release.protocolVersion === 2);
  if (releases.length === 0) throw new Error('The compatibility table has no ACP v2 Claude bridge release');
  const pick = pickRelease({ ...bridge, releases }, cliVersion);
  const version = pick.release.version;
  const facts = { cliVersion, bridgeVersion: version, reason: pick.reason, compatVersion: known.compatVersion };
  if (pick.reason === 'below-lowest') throw new Error(`No ACP v2 Claude bridge supports CLI ${cliVersion}`);
  if (version === bundled.bridgeVersion) {
    if (bundled.protocolVersion !== 2) throw new Error(`Bundled Claude bridge ${version} does not declare ACP v2`);
    log.info(facts, 'claude v2 bridge paired: bundled');
    return undefined;
  }

  const entry = cachedBridgeEntry(cacheDir, bridge.package, version);
  if (deps.exists(entry)) {
    log.info({ ...facts, entry }, 'claude bridge paired: cached');
    return entry;
  }
  const spec = `${bridge.package}@${version}`;
  const installed = ensureInstalled({ spec, entry, destDir: join(cacheDir, `${CLAUDE_BRIDGE_KEY}@${version}`), env, deps });
  wait?.onWaiting(spec);
  try {
    await installed;
  } finally {
    wait?.onSettled();
  }
  log.info({ ...facts, entry }, 'claude v2 bridge paired: downloaded');
  return entry;
}

/** 共享的下载任务:同一个入口只装一次;装完入口还不在也算失败。 */
function ensureInstalled(opts: {
  spec: string;
  entry: string;
  destDir: string;
  env: Record<string, string>;
  deps: ClaudeBridgeDeps;
}): Promise<void> {
  const { spec, entry, destDir, env, deps } = opts;
  const running = installs.get(entry);
  if (running) return running;
  const task = deps.installBridge(spec, destDir, env).then(() => {
    if (!deps.exists(entry)) throw new Error(`Installed Claude v2 bridge entry is missing: ${spec}`);
  });
  installs.set(entry, task);
  void task.then(() => installs.delete(entry), () => installs.delete(entry));
  return task;
}

/** 后台取最新的配对表并记下这次查过;查不到也记,免得每开一次会话就查一次。 */
function refreshCompatInBackground(opts: {
  cliVersion: string;
  env: Record<string, string>;
  cacheDir: string;
  deps: ClaudeBridgeDeps;
  cachedCompat: VersionedCompat | null;
}): void {
  const { cliVersion, env, cacheDir, deps, cachedCompat } = opts;
  const key = `${cacheDir}\u0000${cliVersion}`;
  if (refreshes.has(key)) return;
  const task = deps.fetchLatestCompat(env).then(
    (fetched) => fetched,
    (error: unknown) => {
      log.warn({ cliVersion, err: String(error) }, 'could not fetch the latest compat table');
      return null;
    },
  ).then((fetched) => {
    safeWriteCache(deps, cacheDir, {
      compat: newerCompat(cachedCompat, fetched),
      lastCheck: { cli: cliVersion, at: deps.now() },
    });
  });
  refreshes.set(key, task);
  void task.finally(() => refreshes.delete(key));
}

function safeWriteCache(deps: ClaudeBridgeDeps, cacheDir: string, data: Parameters<ClaudeBridgeDeps['writeCache']>[1]): void {
  try {
    deps.writeCache(cacheDir, data);
  } catch (error) {
    log.warn({ err: String(error) }, 'could not write the bridge cache');
  }
}
