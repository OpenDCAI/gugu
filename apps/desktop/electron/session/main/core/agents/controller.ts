import type { InstallMethod } from '@gugu/session-core/deps';
import type {
  DependencyId,
  DependencyProbeOptions,
  HostDependencySelection,
  InstallOverride,
} from '@gugu/session-core/deps/runtime';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { events } from '@main/lib/events';
import { agentInstallProgressChannel } from '@shared/events/appEvents';
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { markInstallEnded, markInstallStarted, recordInstallProgress } from './install-progress-ledger';

import { clearResolvedPathCache } from '../sessions/impl/resolve-agent-executable';
import { clearRuntimeVersionProbeCache } from './session-runtime-compatibility';
import { agentUpdateService } from '../dependencies/agent-update-service';
import {
  ensureAgentDependenciesProbed,
  getDependencyManager,
} from '../dependencies/dependency-managers';
import { hostDependencyStore } from '../dependencies/host-dependency-store';
import { providerOverrideSettings } from '../settings/provider-settings-service';
import {
  buildAgentIconMap,
  buildAgentMetadataList,
  buildManagementAgentPayloads,
  buildAgentPayload,
  buildAgentPayloads,
  pluginInstallationStatus,
  toAgentInstallationStatus,
} from './agent-payload-builder';
import {
  agentProgramFor,
  agentProgramsOf,
  type DependencyInstallResult,
  type DependencyUpdateResult,
  type HostDependencyManager,
} from '@gugu/session-core/deps/runtime';
import { getDependencyDescriptor } from '../dependencies/registry';
import { getPlugin } from './plugin-registry';
import { partsToInstall, partsToUpdate } from './agent-programs';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import { lookupHarnessModelCatalog } from './harness-model-catalog';
import { wireHarnessModelCatalog } from './harness-model-catalog-wiring';

/** Enrich a manager HostDependency snapshot with latestVersion/updateAvailable from the coordinator. */
const enrichHostDep = (
  id: DependencyId,
  hostDep: Parameters<typeof agentUpdateService.enrichHostDependency>[1],
) => agentUpdateService.enrichHostDependency(id, hostDep);

/** 正在跑的安装:一台机器上一个 agent 一条。取消要找的就是它。 */
const inFlightInstalls = new Map<string, AbortController>();

function installKey(id: AgentProviderId): string {
  return id;
}

type InstallProgressReport = Omit<AgentInstallProgress, 'providerId'>;
type InstallProgressListener = (progress: AgentInstallProgress) => void;

/**
 * 安装进度的旁听者(#6264 资源库切到别的机器:那台机器上的这份控制器把读数经设备频道推给发起的那台桌面)。
 * 本机渲染层照旧走 `events.emit`;这里只是同一拍多一个收听口,❌ 不另起一条进度流。
 */
const installProgressListeners = new Set<InstallProgressListener>();

function reportInstallProgress(id: AgentProviderId, report: InstallProgressReport): void {
  const progress = { providerId: id, ...report } as AgentInstallProgress;
  recordInstallProgress(progress);
  events.emit(agentInstallProgressChannel, progress);
  for (const listener of installProgressListeners) listener(progress);
}

/** 这一行依赖上有没有咕咕自己装的那一份(mise 托管)。 */
function hasManagedCopy(mgr: HostDependencyManager, dependencyId: string): boolean {
  return !!mgr.getHostDependency(dependencyId as DependencyId)?.installations.some(
    (installation) => installation.provenance.ours && installation.provenance.kind === 'mise',
  );
}

type Part = { dependencyId: string; name: string };

/** 一次「安装」要装哪几个程序(#6335)—— 判据在 `partsToInstall`。 */
function installPartsFor(mgr: HostDependencyManager, id: string): Part[] {
  return partsToInstall(agentProgramsOf(getPlugin(id)), (dependencyId) => hasManagedCopy(mgr, dependencyId));
}

/** 一次「更新」要动哪几个程序(#6335)—— 判据在 `partsToUpdate`。 */
function updatePartsFor(mgr: HostDependencyManager, id: string): Part[] {
  const parts = agentProgramsOf(getPlugin(id));
  return partsToUpdate(parts, parts.length > 1 ? pluginInstallationStatus(id, mgr, enrichHostDep)?.programs : undefined);
}

/**
 * 进度事件带上「第几个程序」—— 只在一次装不止一个时。字节与比例仍只说当前这个程序
 * (两个分母不会同时知道,❌ 不拼合计百分比)。
 */
function partTag(index: number, parts: Part[]) {
  return parts.length > 1
    ? { part: { index: index + 1, count: parts.length, name: parts[index]!.name } }
    : {};
}

/** 安装成功之后的收尾:记下用户选的装法、把派生缓存清掉。 */
async function finishInstall<T extends { success: boolean }>(
  id: DependencyId,
  method: InstallMethod | undefined,
  registry: string | undefined,
  result: T,
): Promise<T> {
  if (result.success) {
    // Persist the chosen method as an override, or clear to auto when no method was chosen.
    // Do NOT auto-promote the inferred method — that would freeze a heuristic guess.
    const override: InstallOverride | null = method
      ? { kind: 'method', method, ...(registry ? { registry } : {}) }
      : null;
    await hostDependencyStore.setSelection('local', id, override);
    clearResolvedPathCache(id);
    clearRuntimeVersionProbeCache();
    // 安装结束必须等副本列表读到刚保存的选择；普通 agent 探测默认在后台列副本。
    await (await getDependencyManager()).probe(id, { waitForInstallations: true });
  }
  return result;
}

export const agentsController = createRPCController({
  // ── Metadata ────────────────────────────────────────────────────────────────

  // @@@task-fusion (#2802) — 先探测再作答。
  //
  // 原本本地直接读缓存;而 `status` 在没有任何缓存态时的
  // 兜底值是字面量 `'missing'`(见 agent-payload-builder)——**「还没看过」被当成「没装」
  // 报出去**。开机的 `probeAll()` 是 fire-and-forget,渲染层完全可能抢在它前面问,于是拿到一
  // 份全员未安装的名单;composer 的「尚未安装」标签读的就是这个,会当场说谎。
  //
  // `ensureAgentDependenciesProbed` 在所有 agent 都已有状态时立即返回,所以开机探测跑完之后
  // 这一行无需重探;开机与查询共用同一轮完成结果,不把未知状态编成未安装。
  list: async () => {
    const mgr = await getDependencyManager();
    await ensureAgentDependenciesProbed(mgr);
    return buildAgentPayloads(mgr.platform, mgr, enrichHostDep);
  },

  /** 全量图标表 —— 每个注册过的家都有一份,与上架闸无关(见 buildAgentIconMap)。 */
  listIcons: async () => buildAgentIconMap(),

  listManagement: async () => {
    const mgr = await getDependencyManager();
    await ensureAgentDependenciesProbed(mgr);
    return buildManagementAgentPayloads(mgr.platform, mgr, enrichHostDep);
  },

  get: async (id: string) => {
    const mgr = await getDependencyManager();
    await ensureAgentDependenciesProbed(mgr);
    return buildAgentPayload(id, mgr.platform, mgr, enrichHostDep);
  },

  getManagement: async (id: string) => {
    const mgr = await getDependencyManager();
    await ensureAgentDependenciesProbed(mgr);
    const payloads = await buildManagementAgentPayloads(mgr.platform, mgr, enrichHostDep);
    return payloads.find((payload) => payload.id === id) ?? null;
  },

  // ── Installation status ──────────────────────────────────────────────────────

  // 伴随程序(#6335)那几行不单独出门 —— 折进属主那一家(`pluginInstallationStatus`)。
  listAgentInstallationStatus: async () => {
    const mgr = await getDependencyManager();
    return Array.from(mgr.getAll().values())
      .filter((s) => s.category === 'agent' && !getDependencyDescriptor(s.id)?.ownerId)
      .map((state) => {
        const folded = pluginInstallationStatus(state.id, mgr, enrichHostDep);
        if (folded) return folded;
        const rawHostDep = mgr.getHostDependency(state.id as DependencyId);
        return toAgentInstallationStatus(
          state.id,
          state,
          rawHostDep ? enrichHostDep(state.id as DependencyId, rawHostDep) : undefined,
        );
      });
  },

  getAgentInstallationStatus: async (id: string) => {
    const mgr = await getDependencyManager();
    if (!mgr.get(id as DependencyId)) return null;
    return pluginInstallationStatus(id, mgr, enrichHostDep) ?? null;
  },

  // ── Install / update ─────────────────────────────────────────────────────────

  install: async (
    id: AgentProviderId,
    method?: InstallMethod,
    registry?: string,
    /**
     * 发起方自己的取消(#7199):云端 agent.create 被取消时,这次安装跟着停 —— 以前只有设置页的
     * 「取消安装」按得到它。经 RPC 从界面来的调用传不了 AbortSignal,只认真的 AbortSignal。
     */
    options?: { signal?: AbortSignal },
  ) => {
    const mgr = await getDependencyManager();
    const key = installKey(id);
    // 同一台机器上同一个 agent 只允许一次安装在跑 —— 第二次点安装接管不了第一次的进度条,
    // 两条命令还会往同一个落点写。
    if (inFlightInstalls.has(key)) throw new Error('An installation operation is already running.');
    const controller = new AbortController();
    const external = options?.signal instanceof AbortSignal ? options.signal : undefined;
    const forwardAbort = () => controller.abort(external?.reason);
    if (external?.aborted) forwardAbort();
    else external?.addEventListener('abort', forwardAbort, { once: true });
    inFlightInstalls.set(key, controller);
    markInstallStarted(id);
    try {
      // 一家几个程序就逐个装(#6335),进度都记在这一家名下、带上「第几个」。
      // 前一个装好、后一个失败时**不回滚**前一个:每个程序都是一份完整的依赖,装好的那条腿照样能用,
      // 再点一次「安装」只补缺的那个(`installPartsFor`)。
      const parts = installPartsFor(mgr, id);
      let result: DependencyInstallResult | undefined;
      for (const [index, part] of parts.entries()) {
        const dependencyId = part.dependencyId as DependencyId;
        // 下载源(npm 镜像)只对主程序有意义 —— 伴随程序的安装选项上没有 registry,带过去就挑不到选项。
        const partRegistry = dependencyId === id ? registry : undefined;
        result = await finishInstall(dependencyId, method, partRegistry, await mgr.install(dependencyId, method, {
          registry: partRegistry,
          /**
           * 用户没指定源时,按测速排出来的顺序试(#6157)。
           *
           * 那趟计时来自面板一打开就发的「查各源最新版本」—— ❌ 不为选源另发一趟请求。
           * 还没测过就是空数组,安装照旧走 descriptor 的推荐源。
           */
          ...(partRegistry === undefined
            ? { registries: agentUpdateService.installSourceOrder(dependencyId) }
            : {}),
          signal: controller.signal,
          onProgress: (report) => reportInstallProgress(id, { ...report, ...partTag(index, parts) }),
        }));
        if (!result.success) return result;
      }
      return result!;
    } finally {
      external?.removeEventListener('abort', forwardAbort);
      markInstallEnded(id);
      if (inFlightInstalls.get(key) === controller) inFlightInstalls.delete(key);
    }
  },

  /** 中止正在跑的那次安装。没有在跑就是 false —— ❌ 不假装成功。 */
  cancelInstall: async (id: AgentProviderId) => {
    const controller = inFlightInstalls.get(installKey(id));
    if (!controller) return false;
    controller.abort();
    return true;
  },

  update: async (
    id: AgentProviderId,
    method?: InstallMethod,
    registry?: string,
  ) => {
    const mgr = await getDependencyManager();
    const key = installKey(id);
    if (inFlightInstalls.has(key)) throw new Error('An installation operation is already running.');
    const controller = new AbortController();
    inFlightInstalls.set(key, controller);
    try {
      // 一家几个程序时只动咕咕那一份有新版本的那几个(#6335,`updatePartsFor`)。
      const parts = updatePartsFor(mgr, id);
      let result: DependencyUpdateResult | undefined;
      for (const [index, part] of parts.entries()) {
        const dependencyId = part.dependencyId as DependencyId;
        // 下载源只对主程序有意义(见 install)。
        const partRegistry = dependencyId === id ? registry : undefined;
        const previous = await hostDependencyStore.getSelection('local', dependencyId);
        reportInstallProgress(id, { phase: 'starting', elapsedMs: 0, ...partTag(index, parts) } as InstallProgressReport);
        result = await mgr.update(dependencyId, method, {
          registry: partRegistry, signal: controller.signal,
          onProgress: (report) => reportInstallProgress(id, { ...report, ...partTag(index, parts) }),
        });
        if (!result.success) return result;
        if (hasManagedCopy(mgr, dependencyId)) {
          result = await finishInstall(dependencyId, 'mise', partRegistry ?? previous?.registry, result);
        }
      }
      return result!;
    } finally {
      if (inFlightInstalls.get(key) === controller) inFlightInstalls.delete(key);
    }
  },

  uninstall: async (id: AgentProviderId, method?: InstallMethod) => {
    const mgr = await getDependencyManager();
    // 卸载只卸咕咕装的那几份(spec):伴随程序只在咕咕自己那一份在时才一起卸,
    // 用户自己装在 `~/.local/bin/agy` 的那份 ❌ 不碰(#6335)。先记下来 —— 卸完主程序再判就晚了。
    const companions = agentProgramsOf(getPlugin(id))
      .slice(1)
      .map((part) => part.dependencyId as DependencyId)
      .filter((dependencyId) => hasManagedCopy(mgr, dependencyId));
    const retire = async (dependencyId: DependencyId) => {
      const previous = await hostDependencyStore.getSelection('local', dependencyId);
      await hostDependencyStore.setSelection('local', dependencyId,
        previous?.registry ? { kind: 'auto', registry: previous.registry } : null);
      await mgr.probe(dependencyId);
    };
    let result = await mgr.uninstall(id, method);
    if (!result.success) return result;
    await retire(id);
    for (const dependencyId of companions) {
      result = await mgr.uninstall(dependencyId, method);
      if (!result.success) return result;
      await retire(dependencyId);
    }
    return result;
  },

  // ── Settings ─────────────────────────────────────────────────────────────────

  getDefaultSettings: async (id: string): Promise<ProviderCustomConfig> => {
    const meta = await providerOverrideSettings.getItemWithMeta(id);
    return meta.defaults;
  },

  getSettings: async (id: string) => {
    return providerOverrideSettings.getItemWithMeta(id);
  },

  updateSettings: (id: string, config: Partial<ProviderCustomConfig>): Promise<void> =>
    providerOverrideSettings.updateItem(id, config),

  // ── Selection + probe ────────────────────────────────────────────────────────

  setUsedInstallation: async (
    id: DependencyId,
    selection?: HostDependencySelection,
  ): Promise<void> => {
    // undefined = no-op; null = explicit auto (clear override)
    if (selection === undefined) return;
    await hostDependencyStore.setSelection('local', id, selection);
    // ❌ 这里**不再**挨个通知各份派生缓存作废(#5605)。从前是三行 clear,漏掉第四份(模型目录)
    //    就让「换了一份拷贝」必须重启 app 才生效 —— 而那张「谁改了要记得通知谁」的表是
    //    「写者 × 缓存」那么大、靠注释维护的:渲染层那张表上三份缓存里有两份就是漏掉之后补上去的,
    //    模型目录是第四份。现在每一份都按**自己的输入**判新鲜:
    //      · `resolveAgentExecutable` 每次都先读这份选择,再谈缓存(选择命中时压根不碰那个 memo);
    //      · 运行时版本探针按「执行上下文 × 可执行文件 × 参数」记,换了拷贝就是另一个键;
    //      · 模型目录按 `inputsHash`(跑哪一份 + 哪份 env + 版本)判。
    //    ⇒ 输入变了自然查不中,没有人需要记得。
    const mgr = await getDependencyManager();
    await mgr.probe(id);
  },

  refreshLatestVersion: async (id: DependencyId): Promise<void> => {
    await agentUpdateService.refreshLatestVersion(id);
  },

  getInstallSourceVersions: async (id: DependencyId) => {
    const mgr = await getDependencyManager();
    const target = { platform: process.platform as string, arch: process.arch as string };
    return agentUpdateService.fetchInstallSourceVersions(id, mgr.getInstallOptions(id), target);
  },

  probe: async (id: DependencyId) => {
    const mgr = await getDependencyManager();
    return mgr.probe(id);
  },

  probeOverride: async (
    id: DependencyId,
    selection: { path?: string; cli?: string },
  ) => {
    const mgr = await getDependencyManager();
    return mgr.probeOverride(id, selection);
  },

  probeAll: async (options?: DependencyProbeOptions) => {
    const mgr = await getDependencyManager();
    return mgr.probeAll(options);
  },

  listMetadata: async () => {
    return buildAgentMetadataList();
  },

  /**
   * 这家 harness 现在能跑哪些模型 —— 问 harness 自己（ACP `session/new` 的
   * `configOptions[category=model]`），不是查咕咕仓库里的一张手写表。
   *
   * ❌ 刻意**不**并进 `agents.list()` 的 payload：目录要按 harness 起进程探，与安装状态是两件事、
   * 两种新鲜度。「同一张目录在两台机器上答案不同」（d15 报 gpt-5.6，MBP 报 gpt-5.6-sol/terra/luna）
   * 也说明它只对跑它的那台机器成立。
   *
   * 返回的是**四态**而不是「有/没有」：没装 / 没登录 / 坏了，用户的下一步动作完全不同。
   * `force` 供界面「刷新」用：刚装完、刚登录完，不该让他等 TTL。
   *
   * ⚠️ 这条 RPC **绝不等 harness 进程**(`lookupHarnessModelCatalog` 而不是
   * `getHarnessModelCatalog`)。owner 2026-08-26 在 macOS 上实测切到 mimocode 要 30s ——
   * 那 30s 整个压在这里,composer 干等。现在:手上有什么先答什么,该探的在后台探,
   * 回包带 `refreshing` 让渲染层知道还要盯着。`force` 也一样不等 —— 它只是让缓存作废并起一趟,
   * 结果照旧由轮询取回。⇒ **没有任何一条路径让用户为一次 harness 冷启买单。**
   *
   * 依赖探测只负责提供缓存版本；它不能挡住目录 RPC。冷启动时全量探测可能包含不可用的
   * harness，等待它会让 composer 永远停在 `unknown`。目录探测自己会把缺失/协议失败翻译成
   * `unavailable`，所以这里让依赖探测后台运行，失败只记录诊断，不吞掉目录结果。
   */
  modelCatalog: async (id: string, leg: SessionpageLeg, force?: boolean) => {
    wireHarnessModelCatalog();
    const mgr = await getDependencyManager();
    void ensureAgentDependenciesProbed(mgr).catch((error: unknown) => {
      process.emitWarning(
        error instanceof Error ? error.message : String(error),
        { code: 'AGENT_DEPENDENCY_PROBE' },
      );
    });
    return lookupHarnessModelCatalog(id, {
      // 目录替哪条腿读(#6246):两条腿的配置根可能不同,渲染层按它所在的那条腿问。
      leg,
      // 版本是缓存的主作废闸：harness 一升级，清单就可能变（codex 0.144.6 的缓存报出
      // 0.146.0 不认识的 id，就是这条闸缺席造成的）。
      // 版本问**那条腿的程序**(#6335:Antigravity 终端腿是 `agy`,不是 `agy_acp_server`)。
      harnessVersion:
        mgr.get(agentProgramFor(getPlugin(id), leg).dependencyId as DependencyId)?.version ?? null,
      ...(force ? { force: true } : {}),
    });
  },
});
