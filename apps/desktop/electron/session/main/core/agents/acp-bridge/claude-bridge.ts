/**
 * 聊天面板用的 Claude 桥接,按**用户自己这份 Claude 的版本**配(#6394)。
 *
 * 桥接(`@gugu-acp/claude-agent-acp`)夹在咕咕与用户自装、会自更新的 Claude 之间。官方的对应关系是
 * 一对一、没有兼容区间;把桥接定死在安装包里,用户的 Claude 一升级就失配 —— 2.1.270 改了「空闲」信号的
 * 节奏,定死的 0.75.1 让被插过消息的回合永不结束。⇒ 桥接跟着 CLI 走,Selenium Manager 那种做法:
 *
 * 1. 读用户这份 Claude 的版本(按路径 + mtime + 大小记住,换了/升级了才重读);
 * 2. 手上的配对表 = 随包的 `@gugu-acp/compat` 与上次联网拿到的那份里**较新**的一份;
 * 3. 只有这份 Claude 比表里知道的都新,才联网取最新的表(同一版本 6 小时内只查一次)。
 *    查表在**后台**:这一次按手上的表选(最新那一版没有上限,新 CLI 落在它身上),查到新桥下一次再用;
 * 4. 按表选出管这个版本的发布:就是随包那份 → 用随包的;否则用缓存里的,没有就下载(npm,随包的 npm CLI)。
 *
 * 下载是**共享的后台任务**:同一版本只装一次,谁先要谁触发,其余的都等同一个结果。只有真会话启动
 * (`wait`)才等它,并经 `wait.onWaiting` 把这一步报到启动进度里;模型目录探针这类调用不等 ——
 * 这一次用随包的,下载在后台接着跑。
 *
 * 用户看到的、实际在跑的,始终是他自己装的那份 Claude(`CLAUDE_CODE_EXECUTABLE`);这里只换桥接。
 * 任何一步失败都退回随包的那份并**响亮记日志** —— 断网、镜像没同步不能让聊天面板起不来,
 * 但也不能悄悄发生。
 */
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

export const CLAUDE_BRIDGE_KEY = 'claude-agent-acp';

export type ClaudeBridgeDeps = {
  /** 用户这份 Claude 的 `--version`;读不出 = null。 */
  probeCliVersion(cliPath: string, env: Record<string, string>): Promise<string | null>;
  /** 随包的桥接版本 + 随包的配对表。 */
  readBundled(): { bridgeVersion: string; compat: VersionedCompat };
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
const installs = new Map<string, Promise<boolean>>();
/** 按「缓存目录 × CLI 版本」合并的后台查表。 */
const refreshes = new Map<string, Promise<void>>();

/**
 * 这次该用哪份桥接。返回入口路径;返回 `undefined` = 用随包的那份。❌ 不抛:
 * 起不来的聊天面板比「这一轮用了随包的桥接」更糟,但每一次退回都在日志里说清为什么。
 * `wait` 只给真会话启动:要配的那一版还没下完就等它;不给 = 不等,先用随包的。
 */
export async function resolveClaudeBridgeEntry(opts: {
  cliPath: string;
  env: Record<string, string>;
  cacheDir: string;
  deps: ClaudeBridgeDeps;
  wait?: BridgeWait;
}): Promise<string | undefined> {
  const { cliPath, env, cacheDir, deps, wait } = opts;
  let bundled: ReturnType<ClaudeBridgeDeps['readBundled']>;
  try {
    bundled = deps.readBundled();
  } catch (error) {
    log.warn({ err: String(error) }, 'bundled bridge or compat table unreadable; using the bundled bridge');
    return undefined;
  }
  const cache = safeReadCache(deps, cacheDir);
  const known = newerCompat(bundled.compat, cache.compat)!;

  const cliVersion = await deps.probeCliVersion(cliPath, env).catch(() => null);
  if (!cliVersion) {
    log.warn({ cliPath }, 'could not read the Claude CLI version; using the bundled bridge');
    return undefined;
  }

  const bridge = known.table.bridges[CLAUDE_BRIDGE_KEY];
  if (!bridge) {
    log.warn({ compatVersion: known.compatVersion }, 'compat table has no claude bridge; using the bundled bridge');
    return undefined;
  }

  if (shouldRefreshCompat({ bridge, cliVersion, lastCheck: cache.lastCheck, now: deps.now() })) {
    refreshCompatInBackground({ cliVersion, env, cacheDir, deps, cachedCompat: cache.compat });
  }

  const pick = pickRelease(bridge, cliVersion);
  const version = pick.release.version;
  const facts = { cliVersion, bridgeVersion: version, reason: pick.reason, compatVersion: known.compatVersion };
  if (pick.reason === 'below-lowest') {
    log.warn(facts, 'Claude CLI is older than every release in the compat table; using the lowest release');
  }
  if (version === bundled.bridgeVersion) {
    log.info(facts, 'claude bridge paired: bundled');
    return undefined;
  }

  const entry = cachedBridgeEntry(cacheDir, bridge.package, version);
  if (deps.exists(entry)) {
    log.info({ ...facts, entry }, 'claude bridge paired: cached');
    return entry;
  }
  const spec = `${bridge.package}@${version}`;
  const installed = ensureInstalled({ spec, entry, destDir: join(cacheDir, `${CLAUDE_BRIDGE_KEY}@${version}`), env, deps, facts });
  if (!wait) {
    log.info({ ...facts, entry }, 'paired claude bridge is still downloading; this caller uses the bundled bridge');
    return undefined;
  }
  wait.onWaiting(spec);
  let ok: boolean;
  try {
    ok = await installed;
  } finally {
    wait.onSettled();
  }
  if (!ok) return undefined; // 原因已由下载任务记过一次
  log.info({ ...facts, entry }, 'claude bridge paired: downloaded');
  return entry;
}

/** 共享的下载任务:同一个入口只装一次;装完入口还不在也算失败。 */
function ensureInstalled(opts: {
  spec: string;
  entry: string;
  destDir: string;
  env: Record<string, string>;
  deps: ClaudeBridgeDeps;
  facts: Record<string, unknown>;
}): Promise<boolean> {
  const { spec, entry, destDir, env, deps, facts } = opts;
  const running = installs.get(entry);
  if (running) return running;
  const task = deps.installBridge(spec, destDir, env).then(
    () => {
      if (deps.exists(entry)) return true;
      log.warn({ ...facts, entry }, 'paired claude bridge installed but its entry is missing; using the bundled bridge');
      return false;
    },
    (error: unknown) => {
      log.warn({ ...facts, err: String(error) }, 'could not download the paired claude bridge; using the bundled bridge');
      return false;
    },
  );
  installs.set(entry, task);
  void task.finally(() => installs.delete(entry));
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

function safeReadCache(deps: ClaudeBridgeDeps, cacheDir: string): ReturnType<ClaudeBridgeDeps['readCache']> {
  try {
    return deps.readCache(cacheDir);
  } catch (error) {
    log.warn({ err: String(error) }, 'bridge cache unreadable; ignoring it');
    return { compat: null, lastCheck: null };
  }
}

function safeWriteCache(deps: ClaudeBridgeDeps, cacheDir: string, data: Parameters<ClaudeBridgeDeps['writeCache']>[1]): void {
  try {
    deps.writeCache(cacheDir, data);
  } catch (error) {
    log.warn({ err: String(error) }, 'could not write the bridge cache');
  }
}
