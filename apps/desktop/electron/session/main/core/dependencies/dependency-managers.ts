import type { Platform } from '@gugu/session-core/deps';
import {
  CORE_DEPENDENCIES,
  createInstallMethodDetector,
  HostDependencyManager,
  resolveActiveInstallation,
  type DependencyId,
  type DependencyStatusUpdatedEvent,
  type SelectedSource,
} from '@gugu/session-core/deps/runtime';
import { clearResolvedPathCache } from '@main/core/sessions/impl/resolve-agent-executable';
import { clearRuntimeVersionProbeCache } from '@main/core/agents/session-runtime-compatibility';
import { resolveLocalAgentSpawnEnv } from '@main/core/agents/agent-run-context';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { setGitExecutableOverride } from '@main/core/utils/exec';
import { log } from '@main/lib/logger';
import { listPlugins } from '../agents/plugin-registry';
import { agentUpdateService } from './agent-update-service';
import { hostDependencyLedgerFor, localManagedInstallDirs } from './host-dependency-ledger';
import { createLocalInstallCommandRunner } from './install-runner';
import { readManagedLauncherRelease } from './mise-installer';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';
import { AGENT_DEPENDENCIES, getDependencyDescriptor } from './registry';

type DesktopDependencyManager = HostDependencyManager<LocalExecutionContext>;

const offeredAgentDependencies = AGENT_DEPENDENCIES.filter((dependency) =>
  listPlugins().some((provider) => provider.metadata.id === (dependency.ownerId ?? dependency.id))
);

function syncGitExecutable(event: DependencyStatusUpdatedEvent): void {
  if (event.id !== 'git' || !event.hostDependency) return;

  const activeInstallation = resolveActiveInstallation(
    event.hostDependency.installations,
    event.hostDependency.used
  );

  const executable = activeInstallation
    ? (activeInstallation.pathEntry ?? activeInstallation.realpath)
    : gitExecutableFromMissingSelection(event.hostDependency.used);

  setGitExecutableOverride(executable);
}

function gitExecutableFromMissingSelection(selection: SelectedSource): string | null {
  if (selection.kind === 'pinned') return selection.realpath;
  if (selection.kind === 'path') return selection.path;
  if (selection.kind === 'cli') return selection.command;
  return null;
}

function wireDesktopBridges(manager: DesktopDependencyManager): void {
  // AgentUpdateService owns the enriched event emission (adds latestVersion/updateAvailable)
  agentUpdateService.attach(manager);
  manager.onStatusUpdated.subscribe((event: DependencyStatusUpdatedEvent) =>
    syncGitExecutable(event)
  );
  manager.onExecutableInvalidated.subscribe(({ id }: { id: DependencyId }) => {
    clearResolvedPathCache(id);
    // 二进制换了 ⇒ 之前探到的版本作废。❌ 别只清路径:路径可能一个字都没变(原地覆盖安装),
    // 而版本恰恰变了 —— 那正是版本闸要判的东西。
    clearRuntimeVersionProbeCache();
  });
}

// 咕咕自己的 agent 目录不可能出现在用户登录 shell 的 PATH 里,所以必须在**第一次探测之前**
// 由咕咕自己前置 —— 否则上次装好的那份要等到下一次安装才"忽然被找到"。放在这里是因为
// 本地 manager 就在下面一行构造,任何探测都晚于它。
ensureUserBinDirsInPath();

const localExecutionContext = new LocalExecutionContext();
const localPlatform: Platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

export const localDependencyManager = new HostDependencyManager(localExecutionContext, {
  // 我们自己那棵树里的副本是我们亲手放的,不该跟路径猜测同级 —— 见 managed-agent-home.ts。
  installMethodDetector: createInstallMethodDetector(
    localExecutionContext,
    localPlatform,
    localManagedInstallDirs(localPlatform)
  ),
  runInstallCommand: createLocalInstallCommandRunner(),
  // 这台机器那一本账(#6101)。worker 与远端读的是同一本 —— 主进程是它的属主。
  ledger: hostDependencyLedgerFor('local'),
  logger: log,
  dependencies: [...CORE_DEPENDENCIES, ...offeredAgentDependencies],
  getDependencyDescriptor,
  // 量一家 agent 的版本,用的就是它真跑起来时那份环境(#5702)。从前用的是通用外部工具环境 ——
  // 于是「面板上显示装没装 / 什么版本」和按下开始之后的那次运行,各在一个环境里,而且不报错。
  // 实测(2026-09-16 MBP):`<bin> --version` 跑的是选中那份,但读不到设置里为这一家填的变量。
  // 伴随程序(#6335)跑起来就是属主那一家的某条腿 ⇒ 环境按属主算(`getPlugin('antigravity-cli')` 会抛)。
  resolveProbeEnv: (descriptor) =>
    descriptor.category === 'agent'
      ? resolveLocalAgentSpawnEnv(descriptor.ownerId ?? descriptor.id)
      : Promise.resolve(undefined),
  // 不能执行的家(ACP 注册表那一形态,#6335):咕咕装的那份,版本读启动器上的发行标记。
  readManagedVersion: readManagedLauncherRelease,
});
wireDesktopBridges(localDependencyManager);

const agentProbePromises = new WeakMap<DesktopDependencyManager, Promise<void>>();

/**
 * 缓存一致性校验(`isPathResolutionConsistent`)的节流:一轮 = 对每个 agent 各 spawn 一个 `which`。
 *
 * ❌ 原本每次 `agents.list` / `agents.get` 都跑一轮。这条 RPC 不是低频的:每个安装状态事件都会让
 * 渲染层作废 agents 缓存并重拉 list,而一次探测就发几十个事件 ⇒ 事件→list→which→(慢了就判
 * 「不一致」→全量重探→更多事件)… 一个客户端一连上,会话页宿主就以每秒 700+ 的速度 spawn `which`,
 * 子进程堆到近千、V8 堆几分钟冲到 4G 被杀。#4866 web 形态在 d15 上 100% 复现,owner 每 10 分钟
 * 掉线一次就是它。
 *
 * 校验只回答「PATH 上有没有」这一个比特,15 秒内的答案足够新:用户删/装一个 CLI,最多 15 秒后
 * 列表就对了(原意「不能永远挂着陈的行」照旧成立)。并发到达的调用共用同一轮;刚跑完一次全量
 * 探测也算新鲜 —— 探测本身就是最重的校验。
 */
const REVALIDATE_INTERVAL_MS = 15_000;
type AgentRevalidation = { checkedAt: number; inFlight: Promise<boolean> | null };
const agentRevalidations = new WeakMap<DesktopDependencyManager, AgentRevalidation>();

async function agentPathsStillConsistent(manager: DesktopDependencyManager): Promise<boolean> {
  const revalidate = (
    manager as DesktopDependencyManager & {
      isPathResolutionConsistent?: (id: DependencyId) => Promise<boolean>;
    }
  ).isPathResolutionConsistent;
  if (!revalidate) return true;

  const entry = agentRevalidations.get(manager) ?? { checkedAt: 0, inFlight: null };
  if (entry.inFlight) return entry.inFlight;
  if (Date.now() - entry.checkedAt < REVALIDATE_INTERVAL_MS) return true;

  entry.inFlight = Promise.all(
    offeredAgentDependencies.map((dependency) => revalidate.call(manager, dependency.id))
  )
    .then((consistent) => consistent.every(Boolean))
    .finally(() => {
      entry.checkedAt = Date.now();
      entry.inFlight = null;
    });
  agentRevalidations.set(manager, entry);
  return entry.inFlight;
}

/** 远端主机那一支已随 SSH 远程项目一起下架(#6282),这里只剩本机这一个。 */
export async function getDependencyManager(): Promise<DesktopDependencyManager> {
  return localDependencyManager;
}

export async function ensureAgentDependenciesProbed(
  manager: DesktopDependencyManager
): Promise<void> {
  if (offeredAgentDependencies.every((dependency) => manager.get(dependency.id) !== undefined)) {
    // A defined state is only a cache entry, not proof that the executable is
    // still on disk. Revalidate the cheap PATH presence bit so removing or
    // restoring a CLI while the app is running cannot leave a stale row marked
    // as installed forever. Throttled + coalesced, see `agentPathsStillConsistent`.
    if (await agentPathsStillConsistent(manager)) return;
  }

  const existing = agentProbePromises.get(manager);
  if (existing) {
    await existing;
    return;
  }

  const promise = manager.probeAll().finally(() => {
    agentProbePromises.delete(manager);
    // 本轮刚把当前上架的每一行重新量过,紧接着再扫一轮 PATH 只是重复劳动。
    agentRevalidations.set(manager, { checkedAt: Date.now(), inFlight: null });
  });
  agentProbePromises.set(manager, promise);
  await promise;
}
