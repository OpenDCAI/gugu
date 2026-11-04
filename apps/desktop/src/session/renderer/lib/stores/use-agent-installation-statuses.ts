import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AgentInstallErrorPresentation,
  getAgentInstallErrorPresentation,
  getAgentUpdateErrorPresentation,
  pickLastInstallError,
  pickLastInstallSuccessAt,
  pickLastUpdateError,
} from '@renderer/features/settings/agents-page/agent-install';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost, type LibraryAgentsRpc } from '@renderer/features/library/library-host';
import type {
  AgentInstallationStatus,
  AgentInstallError,
  AgentPayload,
  AgentUpdateError,
  AgentUninstallError,
  DependencyStatus,
  HostDependencySelection,
  Installation,
  InstallMethod,
  InstallSourceVersions,
  SelectedSource,
} from '@shared/core/agents/agent-payload';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import { events } from '@renderer/lib/ipc';
import { useAgents } from './use-agents';

/**
 * 最后一段是「哪台机器」(#6264 资源库可以切到别的机器):本机 `local`,别的机器 `remote:<id>`。
 * 进行中的装 / 升级也按它分 —— ❌ 本机正在装的那家,在 d22 的网格上转进度环。
 */
function statusQueryKey(hostKey: string) {
  return ['agents', 'status', hostKey] as const;
}

function opKey(op: 'install' | 'update' | 'uninstall', hostKey: string) {
  return ['agents', op, hostKey] as const;
}

/** Prefix key for the per-registry version queries — matches every agent. */
const INSTALL_SOURCE_VERSIONS_QUERY_KEY = ['agents', 'install-source-versions'] as const;

/**
 * 渲染层里每一个「从安装状态派生」的查询都挂在这个前缀下。作废按它整体来，
 * ❌ 不要回到逐条列举 —— 见 invalidate() 上方那段。
 */
const AGENT_DERIVED_QUERY_PREFIX = ['agents'] as const;

export function useInstallSourceVersions(id: string, enabled: boolean) {
  const host = useLibraryHost();
  return useQuery<InstallSourceVersions>({
    queryKey: [...INSTALL_SOURCE_VERSIONS_QUERY_KEY, id, host.key],
    queryFn: () => host.agents.getInstallSourceVersions(id),
    enabled: enabled && host.remote?.online !== false,
    staleTime: 30 * 60 * 1000,
  });
}

/**
 * 安装/更新 RPC 的返回是一个 `Result`,不是 void —— 失败信息在 `error` 里。
 * 这两个别名让 mutation 不用 `unknown` + 强转,失败分支才能拿到类型化的 error。
 */
type AgentInstallResult =
  | { success: true; data: unknown }
  | { success: false; error: AgentInstallError };
type AgentUpdateResult =
  | { success: true; data: unknown }
  | { success: false; error: AgentUpdateError };
type AgentUninstallResult =
  | { success: true; data: unknown }
  | { success: false; error: AgentUninstallError };

type OpVars = { id: AgentProviderId; method?: InstallMethod; registry?: string };

/**
 * @@@task-fusion (#2802) — 当前正在安装的 agent 集合。
 *
 * 从全局 MutationCache 推导(而不是某个组件自己的 state),所以弹层关掉再打开、或换个入口
 * 看,「安装中…」都还在 —— 安装是个跨越 UI 生命周期的长操作。
 */
export function useInstallingAgents(): ReadonlySet<string> {
  const host = useLibraryHost();
  const pending = useMutationState({
    filters: { mutationKey: opKey('install', host.key), status: 'pending' },
    select: selectOpVars,
  });
  // useMutationState 每次渲染都返回新数组;用内容做 memo key,免得下游 useMemo 白churn。
  const ids = pending
    .map((v) => v?.id)
    .filter((id): id is AgentProviderId => !!id)
    .sort();
  const key = ids.join(',');
  return useMemo(() => new Set<string>(key ? key.split(',') : []), [key]);
}
const selectOpVars = (m: { state: { variables?: unknown } }) =>
  m.state.variables as OpVars | undefined;

/**
 * 正在装**或**正在更新的那几家(#6157)。
 *
 * 图标网格上那圈进度环画的是「咕咕正在为这一家下载东西」,而更新与安装在用户面上是同一件事
 * (spec:一家只有一种状态,安装中就是安装中)。❌ 只看安装那一路的话,点了更新的那一家在网格里
 * 看起来什么都没发生。
 */
export function useBusyInstallAgents(): ReadonlySet<string> {
  const host = useLibraryHost();
  const installing = useInstallingAgents();
  const updating = useMutationState({
    filters: { mutationKey: opKey('update', host.key), status: 'pending' },
    select: selectOpVars,
  });
  const updatingIds = updating
    .map((v) => v?.id)
    .filter((id): id is AgentProviderId => !!id)
    .sort();
  const key = [...installing].sort().concat(updatingIds).join(',');
  return useMemo(() => new Set<string>(key ? key.split(',') : []), [key]);
}

/**
 * 连结果一起取出来的版本 —— 供「最近一次安装失败」用。
 *
 * 失败信息**不能**从宿主级 `installMutation.data` 读:那是整台机器上最近一次安装的结果,
 * 渲染到某个 agent 的卡片里就会把别的 agent 的报错顶上去。按 `variables.id` 过滤才对。
 */
const selectOpState = (m: {
  state: { variables?: unknown; data?: unknown; error?: unknown; submittedAt?: number };
}) => ({
  vars: m.state.variables as OpVars | undefined,
  data: m.state.data as AgentInstallResult | undefined,
  error: m.state.error as Error | null | undefined,
  submittedAt: m.state.submittedAt ?? 0,
});

/**
 * 订阅一次安装的实时读数。
 *
 * 为什么不塞进那条状态事件：状态答的是「装没装、什么版本」，一次安装只发几次；进度是
 * 每秒一条的流。混在一起会让状态缓存被高频事件反复作废（见 appEvents 里那条注释）。
 *
 * 安装一结束就清空 —— ❌ 不留着上一次的数字，否则下次点安装会先闪一下旧读数。
 */
function useInstallProgress(
  id: AgentProviderId,
  isRunning: boolean,
  agentsRpc: LibraryAgentsRpc,
): AgentInstallProgress | null {
  const [progress, setProgress] = useState<AgentInstallProgress | null>(null);

  useEffect(() => {
    if (!isRunning) {
      setProgress(null);
      return;
    }
    // 本机:主进程的进度事件;别的机器:那台机器经设备频道推回来的同一份读数(#6264)。
    const stop = agentsRpc.onInstallProgress((event: AgentInstallProgress) => {
      if (event.providerId !== id) return;
      setProgress(event);
    });
    return stop;
  }, [id, isRunning, agentsRpc]);

  return progress;
}

/**
 * 一家的安装实时读数,给图标网格上那圈环用(#6157)。
 *
 * `isRunning` 为假时**不订阅** —— 所以三十个图标里只有真在装的那几个挂着事件监听,
 * 而不是每个图标都去听一条每秒一条的流。
 */
export function useAgentInstallProgress(
  id: string,
  isRunning: boolean,
): AgentInstallProgress | null {
  const host = useLibraryHost();
  return useInstallProgress(id as AgentProviderId, isRunning, host.agents);
}

/**
 * Returns installation statuses for all agents on this machine, and provides
 * mutations for install, update, setUsedInstallation, refreshLatestVersion, and probeAll.
 *
 * Also subscribes to `agentInstallationStatusUpdatedChannel` to keep the cache
 * live-patched when the main process emits status changes.
 */
export function useAgentInstallationStatuses() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const agentsRpc = host.agents;
  const key = statusQueryKey(host.key);
  // 装/更新的结果提示原本整条链都是硬编码英文,顶在中文界面上 —— owner 点名的就是这个。
  const { translate } = useSessionMessages();

  const { data: agents } = useAgents();
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(a.id, a.name);
    return map;
  }, [agents]);
  const nameOf = (id: string) => agentNameMap.get(id) ?? id;

  // #6264 资源库 / 会话 / 新建框在别的机器上:问那台机器(见 library-host.ts);它离线时不问,手上有上次的就照旧画。
  const query = useQuery<AgentInstallationStatus[]>({
    queryKey: key,
    queryFn: () => agentsRpc.listAgentInstallationStatus(),
    enabled: host.remote?.online !== false,
    staleTime: 30_000,
  });

  /**
   * 把「从安装状态派生的那一族缓存」一次作废。`keepStatus` 留给已经手工打准 status 的调用方。
   * 这是这一族唯一知道成员是谁的地方 —— 见下方 invalidate() 上的那段账。
   */
  const invalidateDerived = (opts?: { keepStatus?: boolean }) => {
    void queryClient.invalidateQueries({
      queryKey: AGENT_DERIVED_QUERY_PREFIX,
      ...(opts?.keepStatus
        ? { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[1] !== 'status' }
        : {}),
    });
  };

  // Live-patch cache from background events — the event is already a full DTO
  useEffect(() => {
    // 这条事件只说**本机**:资源库看的是别的机器时,❌ 拿它去打那台机器的缓存。
    if (host.remote) return;
    const stop = events.on(
      agentInstallationStatusUpdatedChannel,
      (event: AgentInstallationStatus) => {
        queryClient.setQueryData<AgentInstallationStatus[]>(key, (prev) => {
          if (!prev) return [event];
          const existingIndex = prev.findIndex((s) => s.id === event.id);
          if (existingIndex === -1) return [...prev, event];
          return prev.map((s, index) => (index === existingIndex ? event : s));
        });
        // 事件已经把 status 那份**手工打准**了,所以这里只作废其余派生缓存 —— 连 status 一起
        // 作废会立刻触发一次重取,把刚打的补丁又冲掉,等于白打。
        invalidateDerived({ keepStatus: true });
      },
    );
    return stop;
  }, [host.key]);

  /**
   * 装完 / 卸完 / 重新检测之后，**所有从安装状态派生的缓存一次全作废**。
   *
   * 为什么按前缀，而不是一条条列：这个形状已经漏过四次，每次都是同一个症状——主进程那边
   * 已经是新的，界面还捧着旧的，用户要么等 staleTime 过期、要么切走再切回、要么重启应用：
   *   · #2802 漏了 `agents/metadata`（选择器一直挂「尚未安装」好几分钟）
   *   · 漏了 `agents/install-source-versions`（点了「检查更新」，数字纹丝不动）
   *   · #5605 漏了 `agents/modelCatalog`
   *   · #5719 漏了 `agents/management`（资源库→智能体那张列表的「已安装/未安装」标签，
   *     owner 真机实测：装完必须切换页面或重启才更新）
   *
   * 逐条列举要求每加一个派生缓存就记得回来补一行，而四次实证说明没人记得住。所以改成
   * **按 `['agents', …]` 这个前缀整体作废** —— 渲染层每一个从安装状态派生的查询都在这个
   * 前缀下（status / metadata / management / icons / modelCatalog / modelCredential /
   * install-source-versions），于是「新加的派生缓存忘了登记」这一类 bug 归零，而不是
   * 这次不复现。
   *
   * 代价可控：react-query 默认只**重新拉取挂着的查询**（refetchType: 'active'），
   * 没在屏幕上的那些只是标脏，等下次用到再说。
   */
  const invalidate = () => {
    invalidateDerived();
  };

  /**
   * @@@task-fusion (#2802) — 失败 toast 必须说清为什么。
   *
   * mutation 成功 ≠ 安装成功:RPC 正常返回一个 `Result`,安装本身可能是失败的。原本这里把
   * 类型化的 `error` 整个丢掉,只弹一句「Failed to install X」——owner 实遇,除了「失败了」
   * 什么都不知道(既不知道是没有安装命令、还是命令跑挂了、还是装完探测不到)。
   * 文案由 `getAgentInstallErrorPresentation` 按错误类型写,这里把它接上。
   */
  /**
   * 失败文案要回答「那个路径上是谁」，就得拿到这次失败时本机枚举到的副本。读缓存而不是
   * 闭包捕获：`invalidate()` 只把数据标脏、不清空，所以这里读到的仍是命令跑之前那份枚举，
   * 正是要用来解释这次失败的那份。
   */
  const installationsOf = (id: string): Installation[] | undefined =>
    queryClient.getQueryData<AgentInstallationStatus[]>(key)?.find((s) => s.id === id)
      ?.installations;

  const failureToast = (title: string, description: ReactNode) =>
    toast({ title, description, variant: 'destructive' });

  const diagnosticToastDescription = (presentation: {
    message: string;
    diagnostic: string | null;
  }): ReactNode => {
    if (!presentation.diagnostic) return presentation.message;
    return createElement(
      'details',
      { className: 'max-w-[min(32rem,calc(100vw-3rem))]' },
      createElement('summary', { className: 'cursor-pointer' }, presentation.message),
      createElement(
        'pre',
        { className: 'mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs' },
        presentation.diagnostic,
      ),
    );
  };

  const installMutation = useMutation<
    AgentInstallResult,
    Error,
    { id: AgentProviderId; method?: InstallMethod; registry?: string }
  >({
    mutationKey: opKey('install', host.key),
    mutationFn: ({ id, method, registry }) =>
      agentsRpc.install(id, method, registry) as Promise<AgentInstallResult>,
    onSuccess: (result, vars) => {
      invalidate();
      const name = nameOf(vars.id);
      if (result.success) {
        toast({ title: translate('agentsPage.installSucceeded', { name }) });
      } else {
        failureToast(
          translate('agentsPage.installFailedTitle', { name }),
          diagnosticToastDescription(
            getAgentInstallErrorPresentation(result.error, {
              installations: installationsOf(vars.id),
              translate,
            }),
          ),
        );
      }
    },
    onError: (error, vars) => {
      failureToast(
        translate('agentsPage.installFailedTitle', { name: nameOf(vars.id) }),
        error.message,
      );
    },
  });

  const updateMutation = useMutation<
    AgentUpdateResult,
    Error,
    { id: AgentProviderId; method?: InstallMethod; registry?: string }
  >({
    mutationKey: opKey('update', host.key),
    mutationFn: ({ id, method, registry }) =>
      agentsRpc.update(id, method, registry) as Promise<AgentUpdateResult>,
    onSuccess: (result, vars) => {
      invalidate();
      const name = nameOf(vars.id);
      if (result.success) {
        toast({ title: translate('agentsPage.updateSucceeded', { name }) });
      } else if (result.error.type === 'cancelled') {
        toast({ title: translate('agentsPage.updateCancelled') });
      } else {
        failureToast(
          translate('agentsPage.updateFailedTitle', { name }),
          diagnosticToastDescription(
            getAgentUpdateErrorPresentation(result.error, {
              installations: installationsOf(vars.id),
              translate,
            }),
          ),
        );
      }
    },
    onError: (error, vars) => {
      failureToast(
        translate('agentsPage.updateFailedTitle', { name: nameOf(vars.id) }),
        error.message,
      );
    },
  });

  const uninstallMutation = useMutation<
    AgentUninstallResult,
    Error,
    { id: AgentProviderId; method?: InstallMethod }
  >({
    mutationKey: opKey('uninstall', host.key),
    mutationFn: ({ id, method }) =>
      agentsRpc.uninstall(id, method) as Promise<AgentUninstallResult>,
    onSuccess: invalidate,
  });

  const setUsedMutation = useMutation<
    void,
    Error,
    { id: string; selection: HostDependencySelection }
  >({
    mutationFn: ({ id, selection }) => agentsRpc.setUsedInstallation(id, selection),
    onSuccess: invalidate,
  });

  const refreshLatestMutation = useMutation<void, Error, string>({
    mutationFn: (id) => agentsRpc.refreshLatestVersion(id),
    onSuccess: invalidate,
  });

  const probeAllMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      await agentsRpc.probeAll();
    },
    onSuccess: invalidate,
  });

  return {
    ...query,
    install: installMutation.mutate,
    installAsync: installMutation.mutateAsync,
    update: updateMutation.mutate,
    uninstall: uninstallMutation.mutate,
    setUsedInstallation: setUsedMutation.mutate,
    refreshLatestVersion: refreshLatestMutation.mutate,
    probeAll: probeAllMutation.mutate,
    isInstalling: installMutation.isPending,
    isUpdating: updateMutation.isPending,
    isUninstalling: uninstallMutation.isPending,
    installingMethod: installMutation.isPending ? installMutation.variables?.method : undefined,
    installingRegistry: installMutation.isPending ? installMutation.variables?.registry : undefined,
    updatingMethod: updateMutation.isPending ? updateMutation.variables?.method : undefined,
    uninstallingMethod: uninstallMutation.isPending
      ? uninstallMutation.variables?.method
      : undefined,
  };
}

/**
 * View-model type for a single agent's installation state. Consumed by the
 * install cards as the single source of truth (`vm`).
 */
export type HostDependencyInstallation = {
  /** The raw status DTO for this agent from the host probe, or null before the first probe. */
  data: AgentInstallationStatus | null;
  installations: Installation[];
  /** The authoritative source (persisted override or auto). */
  used: SelectedSource | undefined;
  /**
   * 这次安装的实时读数；没有在装、或这一拍还没有读数时是 null。
   * ⚠️ `bytesTotal` 缺席 = 这次量不出分母，界面**只能**显示已完成量与速度，
   * ❌ 不许自己凑一个百分比（product spec）。
   */
  installProgress: AgentInstallProgress | null;
  /** 中止正在跑的那次安装。没有在跑时解析成 false。 */
  cancelInstall: () => Promise<boolean>;
  /** Dependency status — 'available', 'missing', 'outdated', etc. (not the query status). */
  status: DependencyStatus;
  /** True while an install mutation is in flight for this host. */
  isInstalling: boolean;
  /** True while an update mutation is in flight for this host. */
  isUpdating: boolean;
  /** True while an uninstall mutation is in flight for this host. */
  isUninstalling: boolean;
  /**
   * 这个 agent 最近一次安装失败的说法;正在装、或最近一次是成功时为 null。
   *
   * toast 转瞬即逝:用户读完它、去改装法或换个镜像源时,那句话已经没了 —— 而他要改的正是报错
   * 说的那件事。安装表单要能就地留着它。#4271
   */
  lastInstallError: AgentInstallErrorPresentation | null;
  /** 最近一次更新失败的说法(本次会话内),正在更新时为 null。 */
  lastUpdateError: AgentInstallErrorPresentation | null;
  /** 最近一次成功安装的发起时刻(本次会话内),没有则 null。供「刚装好」用。 */
  lastInstallSucceededAt: number | null;
  /** The install method currently being installed, if any. */
  installingMethod: InstallMethod | undefined;
  /** The concrete registry currently being installed, if any. */
  installingRegistry: string | undefined;
  /** The install method currently being updated, if any. */
  updatingMethod: InstallMethod | undefined;
  /** The install method currently being uninstalled, if any. */
  uninstallingMethod: InstallMethod | undefined;
  install(method: InstallMethod, registry?: string): Promise<void>;
  update(method?: InstallMethod, registry?: string): Promise<void>;
  uninstall(method?: InstallMethod): Promise<void>;
  setUsed(selection: HostDependencySelection): Promise<void>;
  refresh(): Promise<void>;
  fetchLatestVersion(): Promise<void>;
  probeOverride(selection: { path?: string; cli?: string }): Promise<Installation | null>;
};

/**
 * Returns the installation status and full per-agent view-model for a single
 * agent. `agentPayload` (optional) hydrates a synthetic installation before the
 * first probe completes so the UI can render immediately.
 */
export function useAgentInstallationStatus(
  id: string,
  agentPayload?: AgentPayload,
): HostDependencyInstallation {
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const {
    data: statuses,
    install: installMutate,
    update: updateMutate,
    uninstall: uninstallMutate,
    setUsedInstallation,
    refreshLatestVersion,
    probeAll,
  } = useAgentInstallationStatuses();

  // Derive per-agent pending state from the global MutationCache so it
  // survives the sheet being closed and reopened while the operation runs.
  const pendingInstalls = useMutationState({
    filters: { mutationKey: opKey('install', host.key), status: 'pending' },
    select: selectOpVars,
  });
  const installVar = pendingInstalls.find((v) => v?.id === id);
  const isInstalling = !!installVar;
  const installingMethod = installVar?.method;
  const installingRegistry = installVar?.registry;

  const pendingUpdates = useMutationState({
    filters: { mutationKey: opKey('update', host.key), status: 'pending' },
    select: selectOpVars,
  });
  const updateVar = pendingUpdates.find((v) => v?.id === id);
  const isUpdating = !!updateVar;
  const installProgress = useInstallProgress(id as AgentProviderId, isInstalling || isUpdating, host.agents);
  const updatingMethod = updateVar?.method;

  const pendingUninstalls = useMutationState({
    filters: { mutationKey: opKey('uninstall', host.key), status: 'pending' },
    select: selectOpVars,
  });
  const uninstallVar = pendingUninstalls.find((v) => v?.id === id);
  const isUninstalling = !!uninstallVar;
  const uninstallingMethod = uninstallVar?.method;

  const statusEntry = statuses?.find((s) => s.id === id) ?? null;

  const installations = useMemo<Installation[]>(() => {
    if (statusEntry) return statusEntry.installations;
    if (!agentPayload) return [];
    // Synthetic installation before the first probe completes
    const syntheticPath = agentPayload.command;
    return [
      {
        id: syntheticPath ?? 'auto',
        realpath: syntheticPath ?? 'auto',
        pathEntry: syntheticPath,
        isActive: true,
        manageable: false,
        provenance: { kind: 'unknown', confidence: 'inferred' } as const,
        status: agentPayload.status,
        version: agentPayload.version,
        latestVersion: agentPayload.latestVersion,
        updateAvailable: agentPayload.updateAvailable,
      },
    ];
  }, [statusEntry, agentPayload]);

  // 最近一次安装失败,按**这个 agent** 取。挑选口径在 `pickLastInstallError`(带测试),
  // 这里只负责把缓存喂进去。
  const settledInstalls = useMutationState({
    filters: { mutationKey: opKey('install', host.key) },
    select: selectOpState,
  });
  const lastInstallError = pickLastInstallError(settledInstalls, id, isInstalling, {
    installations,
    translate,
  });
  const lastInstallSucceededAt = pickLastInstallSuccessAt(settledInstalls, id);
  // 更新失败与安装失败同一条路子(#6101):留在卡里,❌ 不只活 6 秒。
  const settledUpdates = useMutationState({
    filters: { mutationKey: opKey('update', host.key) },
    select: selectOpState,
  });
  const lastUpdateError = pickLastUpdateError(settledUpdates, id, isUpdating, {
    installations,
    translate,
  });

  const used: SelectedSource | undefined = statusEntry?.used ?? agentPayload?.used;
  const status: DependencyStatus = statusEntry?.status ?? agentPayload?.status ?? 'missing';

  const install = useCallback(
    (method: InstallMethod, registry?: string) =>
      new Promise<void>((resolve) => {
        installMutate(
          { id: id as AgentProviderId, method, registry },
          { onSettled: () => resolve() },
        );
      }),
    [installMutate, id],
  );

  const update = useCallback(
    (method?: InstallMethod, registry?: string) =>
      new Promise<void>((resolve) => {
        updateMutate(
          { id: id as AgentProviderId, method, registry },
          { onSettled: () => resolve() },
        );
      }),
    [updateMutate, id],
  );

  const uninstall = useCallback(
    (method?: InstallMethod) =>
      new Promise<void>((resolve, reject) => {
        uninstallMutate({ id: id as AgentProviderId, method }, {
          onSuccess: (result) => result.success ? resolve() : reject(new Error(
            'output' in result.error ? result.error.output : result.error.type,
          )),
          onError: reject,
        });
      }),
    [uninstallMutate, id],
  );

  const setUsed = useCallback(
    (selection: HostDependencySelection) =>
      new Promise<void>((resolve) => {
        setUsedInstallation({ id, selection }, { onSettled: () => resolve() });
      }),
    [setUsedInstallation, id],
  );

  /**
   * 中止正在跑的那次安装。
   *
   * 走独立 RPC 而不是取消这条 mutation：真正要停的是**主进程里那条安装命令**，
   * 而 react-query 的取消只会让渲染层不再等结果 —— 命令照跑，用户按了没用。
   */
  const cancelInstall = useCallback(() => host.agents.cancelInstall(id), [host.agents, id]);

  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        probeAll(undefined, { onSettled: () => resolve() });
      }),
    [probeAll],
  );

  const fetchLatestVersion = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        refreshLatestVersion(id, { onSuccess: () => resolve(), onError: reject });
      }),
    [refreshLatestVersion, id],
  );

  const probeOverride = useCallback(
    (selection: { path?: string; cli?: string }) => host.agents.probeOverride(id, selection),
    [host.agents, id],
  );

  return {
    data: statusEntry,
    installations,
    used,
    status,
    isInstalling,
    installProgress,
    cancelInstall,
    isUpdating,
    isUninstalling,
    lastInstallError,
    lastUpdateError,
    lastInstallSucceededAt,
    installingMethod,
    installingRegistry,
    updatingMethod,
    uninstallingMethod,
    install,
    update,
    uninstall,
    setUsed,
    refresh,
    fetchLatestVersion,
    probeOverride,
  };
}
