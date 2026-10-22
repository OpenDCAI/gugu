// #6264「会话页里的别的机器」(按 Zed):别的机器上的项目与本机项目混排在同一个侧栏里,机器是项目的属性,
// ❌ 没有「当前机器」。这里只管「名下有哪些别的机器、和它们连没连上」;项目、任务、会话本身与本机的
// 是同一张表、同一套界面(behavior gugu-server.md 第 8 条,一套工作台):连上一台就把它的项目清单
// 并进 projectManager,之后的一切调用按实体所在机器走那台机器的连接(lib/machine-routing.ts)。
//
// 机器离线时,它的项目和会话照样列在侧栏里(项目清单照账号上记着的那份 #113,会话照会话目录的底稿)、标离线,❌ 从侧栏消失;
// 连上之后原地换成此刻的。
// 项目只在用到时挂(projectManager.ensureMounted),列出 ❌ 挂。
import { comparer, makeAutoObservable, observable, reaction, runInAction } from 'mobx';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import type { SessionHostClient } from '@shared/lib/ipc/session-host-client';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import type { EventDefinition } from '@shared/lib/ipc/events';
import {
  projectCreatedChannel,
  projectDeletedChannel,
  projectVisibilityChangedChannel,
} from '@shared/core/projects/projectEvents';
import {
  closeMachineClient,
  machineClient,
  machineLinkState,
  onEachMachine,
  reconnectMachine,
  subscribeMachineLink,
  type MachineLinkState,
} from '@renderer/lib/machine-clients';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import { hostConnectionState, type HostConnectionState } from './connection-status';
import { findHomeProject } from './machine-home';
import {
  accountBindingsOf,
  accountCopyKey,
  accountCopyReplacesLive,
  accountFoldersOf,
  accountProjectsOf,
  forgetRetiredProjectCaches,
} from './account-projects';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { machineSessionListClient } from './machine-session-list';
import {
  liveDeviceSessions,
  retainDeviceSessions,
  subscribeDeviceSessions,
  updateDeviceSessions,
  type DeviceSessions,
} from '@/session/shared/remote-sessions/session-directory';
import { readCachedSessionList } from '@/session/shared/remote-sessions/session-list-cache';
import type { SessionShellPeer } from '@shared/lib/ipc/shell-port';
import { normalizeAgentType } from '@gugu/core/agentTypes';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { sessionListFromDigest, startSessionListSync, type SessionListSync } from '@/session/shared/remote-sessions/session-list-sync';
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants';
import {
  remoteHostReachable,
  cloudComputerWakeFailureOf,
  findRemoteHostsBridge,
  onRemoteHostsBridgeChange,
  type CloudComputerWakeFailure,
  type RemoteHostDevice,
  type RemoteHostsBridge,
} from '@/session/shared/remote-hosts';
import {
  browserStorage,
  loadRecentFolders,
  pushRecentFolder,
  saveRecentFolders,
  type RecentFolders,
} from './remote-recent-folders';

const REMOTE_PREFIX = 'remote:';

/** 缓存 / 机器选择器里区分机器的键:`remote:<deviceId>`。 */
export function remoteSessionKey(deviceId: string): string {
  return `${REMOTE_PREFIX}${deviceId}`;
}

export function isRemoteKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(REMOTE_PREFIX);
}

/** `remote:<deviceId>` → deviceId。 */
export function deviceIdFromRemoteKey(key: string): string | null {
  if (!isRemoteKey(key)) return null;
  const rest = key.slice(REMOTE_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

export type RemoteHostState = {
  device: RemoteHostDevice;
  /** 到那台机器会话页宿主的线此刻怎样(tooOld = 那台机器上的咕咕 server 太旧)。 */
  link: MachineLinkState;
  /** 连上过、拿到过它的项目清单。 */
  synced: boolean;
};

/**
 * 名册行上的 engine 是 agent 类型(`claude-code`),目录行上是 harness id(`claude`):按开户时同一个换法换过去,
 * 图标才对得上。这台桌面还不认得的 harness(那台机器更新)原样留着 —— 只是取不到图标、显示首字母,❌ 让整个 @ 落空。
 */
function engineOf(harness: string): string {
  try {
    return normalizeAgentType(harness);
  } catch {
    return harness;
  }
}

/** #7199 分机器模块里一台没醒着的云电脑:状态 + 叫醒没成的原因(见 RemoteHostsStore.cloudScope)。 */
export type CloudScope = { state: 'asleep' | 'waking' | 'wake-failed'; failure: CloudComputerWakeFailure | null };

/** #7199 这一端叫醒云电脑这件事走到哪了:在叫 / 没叫醒(带原因)。叫醒了就不再记。 */
export type CloudWake = { status: 'waking' } | { status: 'failed'; failure: CloudComputerWakeFailure };

export class RemoteHostsStore {
  /** deviceId → 这台机器此刻的读数。 */
  readonly hosts = observable.map<string, RemoteHostState>();
  /** #7199 deviceId → 这一端叫醒那台云电脑走到哪了。 */
  readonly wakes = observable.map<string, CloudWake>();
  /** #7199 正在叫的那一次:同一台再叫就等同一个结果(❌ 没醒就当醒了往下走)。 */
  private readonly wakeInFlight = new Map<string, Promise<boolean>>();
  /** #7403 deviceId → 请它换成匹配版本的那一次(请时它报的版本 + 结果):同一个版本只请一次,各处等同一个结果。 */
  private readonly versionMatchAsked = new Map<string, { version: string | null; requested: Promise<boolean> }>();
  /**
   * 「在这台机器的这个项目里新开一条会话」的一次性意图(侧栏项目行上的「+」→ 新建页)。
   * 新建页挂上时取走;取走即清,❌ 下次进新建页还停在那台机器上。
   */
  newSessionTarget: { deviceId: string; projectPath: string | null } | null = null;
  /** 每台机器最近在上面开过会话的文件夹(这台桌面上记的,重启后还在;见 remote-recent-folders.ts)。 */
  recentFoldersByDevice: RecentFolders = loadRecentFolders(browserStorage());
  /** 连着时问到的每台机器的主目录(那台机器报的 $HOME);心跳报了的以心跳为准(见 homeDir)。 */
  homeDirs: Record<string, string> = {};
  /** 会话目录(与手机同一份,见 session-directory.ts):每台别的机器上有哪些会话。侧栏的远程行读它,❌ 读挂载的项目。 */
  directory: Readonly<Record<string, DeviceSessions>> = liveDeviceSessions();
  private bridge: RemoteHostsBridge | null = null;
  /** 每台连上过的机器一份会话列表同步(这一端的目录只有这里写)。 */
  private readonly listSyncs = new Map<string, SessionListSync>();
  private readonly linkOffs = new Map<string, () => void>();
  private readonly homeProjectPromises = new Map<string, Promise<string>>();
  /** #113 deviceId → 经连接读到它的清单之后、连着期间看到的账号上那份(内容指纹;见 accountCopyReplacesLive)。 */
  private readonly accountSeenLive = new Map<string, string>();
  private stopDevices: (() => void) | null = null;
  private started = false;

  constructor() {
    makeAutoObservable<
      RemoteHostsStore,
      'bridge' | 'linkOffs' | 'homeProjectPromises' | 'accountSeenLive' | 'stopDevices' | 'started' | 'listSyncs'
    >(this, {
      bridge: observable.ref,
      directory: observable.ref,
      listSyncs: false,
      linkOffs: false,
      homeProjectPromises: false,
      accountSeenLive: false,
      stopDevices: false,
      started: false,
    });
  }

  /** 会话页挂上时调一次;桥可能晚于会话页装好,也可能随登出被拆 —— 两种都跟着走。 */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    forgetRetiredProjectCaches(browserStorage());
    sidebarStore.machines = {
      machineOf: (projectId) => machineRegistry.machineOf(projectId),
      label: (deviceId) => this.device(deviceId)?.label ?? null,
      homeDir: (deviceId) => this.homeDir(deviceId),
      sessionsOf: (deviceId) => this.sessionsOf(deviceId),
      isAssistantHome: (deviceId) => this.device(deviceId)?.assistantHome === true,
      projectGroupOf: (projectId) => projectGroupsStore.chatIdOf(projectId),
      projectGroupRepresentativeOf: (projectId) => projectGroupsStore.isRepresentative(projectId),
    };
    // #7341 第二步:各台机器上的本地项目绑的项目群(同群 = 同一个项目,侧栏合成一行)。
    projectGroupsStore.start(() => [...this.hosts.entries()].filter(([, state]) => state.synced).map(([deviceId]) => deviceId));
    subscribeDeviceSessions(() => runInAction(() => (this.directory = liveDeviceSessions())));
    onRemoteHostsBridgeChange(() => this.attach(findRemoteHostsBridge()));
    this.attach(findRemoteHostsBridge());
    // #7199 打开云电脑上的会话 = 叫醒它的三件事之一(规定草稿 cloud-computer「休眠与唤醒」):打开 / 切到一条在睡着的云电脑上的
    // 会话就叫醒它,切回窗口时也算一次「打开」。看着的时候它又睡着了 ❌ 再叫(那样它永远睡不着、一直扣积分)。
    // 侧栏列出、点开项目这些只读的看 ❌ 叫醒(那会让每次打开咕咕都把它叫起来)。
    const viewedMachine = (): string | null => {
      const nav = appState.navigation;
      if (nav.currentViewId !== 'session') return null;
      const projectId = (nav.viewParamsStore.session as { projectId?: unknown } | undefined)?.projectId;
      return typeof projectId === 'string' ? machineRegistry.machineOf(projectId) : null;
    };
    // 设备表里的「醒着」可能还是睡下之前的(库里那一行要等心跳超时才翻,宿主每 30 秒才问一次管家):醒着也走叫醒那一格 ——
    // 它先现问管家,真醒着就只是问一下(❌ 发 /wake),其实睡着了就叫醒。正在醒 ❌ 再叫。
    const wakeIfAsleep = (deviceId: string | null) => {
      const presence = deviceId ? this.device(deviceId)?.cloudComputer : null;
      if (deviceId && (presence === 'asleep' || presence === 'awake')) void this.wakeCloudComputer(deviceId);
    };
    reaction(
      // 换了看的会话,或那台机器刚出现在设备表里(启动时)才算一次;它自己睡下 / 醒来不算。
      () => {
        const deviceId = viewedMachine();
        return { deviceId, known: deviceId !== null && this.hosts.has(deviceId) };
      },
      ({ deviceId }) => wakeIfAsleep(deviceId),
      { fireImmediately: true, equals: comparer.structural }
    );
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wakeIfAsleep(viewedMachine());
      });
    }
  }

  /**
   * #7199 叫醒这台云电脑(在它上面开会话、打开它上面的会话、在模块顶上选了它):正在叫就不再叫一遍;醒了它的线会自己连上
   * (心跳翻成在线 → reconcile 重连)。没叫醒就把原因记下,由各处说给人听。老宿主没有这一格 = false。
   */
  wakeCloudComputer(deviceId: string): Promise<boolean> {
    const wake = this.bridge?.wakeCloudComputer;
    if (!wake) {
      log.warn('[machines] 宿主没有叫醒云电脑这一格(老宿主)', { deviceId });
      return Promise.resolve(false);
    }
    const pending = this.wakeInFlight.get(deviceId);
    if (pending) return pending;
    runInAction(() => this.wakes.set(deviceId, { status: 'waking' }));
    const run = wake(deviceId).then(
      () => {
        runInAction(() => this.wakes.delete(deviceId));
        return true;
      },
      (error: unknown) => {
        const failure = cloudComputerWakeFailureOf(error);
        log.warn('[machines] 叫醒云电脑没成', { deviceId, failure });
        // 管家此刻说它醒着(打开会话时对醒着的它现问的那一下没成):❌ 记成「没能唤醒」—— 没叫过它。
        runInAction(() => {
          if (this.device(deviceId)?.cloudComputer === 'awake') this.wakes.delete(deviceId);
          else this.wakes.set(deviceId, { status: 'failed', failure });
        });
        return false;
      }
    );
    const tracked = run.finally(() => this.wakeInFlight.delete(deviceId));
    this.wakeInFlight.set(deviceId, tracked);
    return tracked;
  }

  /**
   * #7199 分机器的模块(资源库、已安排、设置)那一句话要的:这台是没醒着的云电脑时它此刻的状态与叫醒没成的原因;
   * 醒着 / 不是云电脑 = null(照常按在线与否说)。
   */
  cloudScope(deviceId: string | null | undefined): CloudScope | null {
    if (!deviceId) return null;
    const state = this.connectionState(deviceId);
    if (state !== 'asleep' && state !== 'waking' && state !== 'wake-failed') return null;
    return { state, failure: this.wakeFailure(deviceId) };
  }

  /** 叫醒那台云电脑没成的原因;没在叫 / 叫醒了 = null。 */
  wakeFailure(deviceId: string): CloudComputerWakeFailure | null {
    const wake = this.wakes.get(deviceId);
    return wake?.status === 'failed' ? wake.failure : null;
  }

  device(deviceId: string): RemoteHostDevice | null {
    return this.hosts.get(deviceId)?.device ?? null;
  }

  /** 这个项目在哪台别的机器上;本机项目 = null。 */
  machineOfProject(projectId: string): RemoteHostDevice | null {
    const deviceId = machineRegistry.machineOf(projectId);
    return deviceId ? this.device(deviceId) : null;
  }

  /** 那台机器的主目录:心跳报的(离线、从没连上过也知道),老宿主不报就用连着时问到的。 */
  homeDir(deviceId: string): string | null {
    return this.device(deviceId)?.homeDir ?? this.homeDirs[deviceId] ?? null;
  }

  /**
   * 那台机器上有哪些会话(侧栏的远程行就画这一份)。`live` = 此刻连着、对过账的读数;否则是上次的样子 ——
   * 本地底稿,机器离线且这台桌面没存过底稿时退到心跳摘要。不是 live 的读数 ❌ 冒充此刻(行上「在跑」不算数)。
   */
  sessionsOf(deviceId: string): { sessions: readonly SessionpageSessionSummary[]; live: boolean } {
    const entry = this.directory[deviceId];
    const linked = this.hosts.get(deviceId)?.link === 'open';
    if (entry && entry.sessions.length > 0) return { sessions: entry.sessions, live: linked && !entry.cached };
    const device = this.device(deviceId);
    if (device && !device.isOnline && device.sessionDigest?.length) {
      return { sessions: sessionListFromDigest(device.sessionDigest).sessions, live: false };
    }
    return { sessions: entry?.sessions ?? [], live: linked && entry !== undefined && !entry.cached };
  }

  /** #7199 所有别的机器上会话目录里的会话,带是哪台、是不是此刻的读数(助理 App 找它的子 agent 用)。 */
  allListedSessions(): { deviceId: string; summary: SessionpageSessionSummary; live: boolean }[] {
    return [...this.hosts.keys()].flatMap((deviceId) => {
      const { sessions, live } = this.sessionsOf(deviceId);
      return sessions.map((summary) => ({ deviceId, summary, live }));
    });
  }

  /** 会话目录里按 id 找一条会话(不知道它在哪台机器上时;@ 提及的名字用)。 */
  findListedSession(sessionId: string): SessionpageSessionSummary | null {
    for (const deviceId of this.hosts.keys()) {
      const found = this.sessionsOf(deviceId).sessions.find((session) => session.conversationId === sessionId);
      if (found) return found;
    }
    return null;
  }

  /**
   * #7158 侧栏给这条别的机器上的会话画的那一行(点它打开的就是这一行):它的项目;侧栏画不出 = null(比如那台机器
   * 隐藏主目录里的会话,侧栏放不到项目下)。`gugu.showSession` 按它答。
   */
  listedProject(sessionId: string): string | null {
    const found = this.findListedSession(sessionId);
    return found && sidebarStore.remoteSession(found.projectId, sessionId) ? found.projectId : null;
  }

  /**
   * 别的机器上有咕咕身份的会话(@ 弹层与侧栏身份读它),以及在线却还没读到会话列表的机器 —— 那几台
   * ❌ 当成「没有会话」,由读的一方说「没读到」。行按名册(session_peers)那一行的形状:agent id 在目录行上,
   * 名字与咕咕号从身份缓存按 id 取,缓存里还没有的这一轮不在列、交给它补取(补到了经它的订阅再来一轮)。
   */
  directoryPeers(): { peers: SessionShellPeer[]; notRead: RemoteHostDevice[] } {
    const identities = readIdentityDirectoryBridge();
    const snapshot = identities?.getSnapshot() ?? null;
    const missing = new Set<string>();
    const peers = [...this.hosts.keys()].flatMap((deviceId) => this.sessionsOf(deviceId).sessions.flatMap((session) => {
      const id = session.agent?.userId;
      if (!id) return [];
      const identity = snapshot?.[id];
      if (!identity) {
        missing.add(id);
        return [];
      }
      return [{
        sessionId: session.conversationId,
        identity: { users: { id, display_name: identity.display_name, gugu_number: identity.gugu_number } },
        engine: engineOf(session.harness),
      }];
    }));
    if (missing.size) identities?.ensure([...missing]);
    const notRead = [...this.hosts.values()].flatMap(({ device }) => {
      const { sessions, live } = this.sessionsOf(device.id);
      return device.isOnline && sessions.length === 0 && !live ? [device] : [];
    });
    return { peers, notRead };
  }

  /** 那台机器的主目录:记着就用记着的,没有就问那台机器一次。 */
  async ensureHomeDir(deviceId: string): Promise<string> {
    const known = this.homeDir(deviceId);
    if (known) return known;
    const home = await rpcOn(deviceId).app.getHomeDirectory();
    this.rememberHomeDir(deviceId, home);
    return home;
  }

  private rememberHomeDir(deviceId: string, home: string): void {
    if (!home || this.homeDirs[deviceId] === home) return;
    this.homeDirs = { ...this.homeDirs, [deviceId]: home };
  }

  recentFolders(deviceId: string): readonly string[] {
    return this.recentFoldersByDevice[deviceId] ?? [];
  }

  rememberRecentFolder(deviceId: string, path: string): void {
    this.recentFoldersByDevice = pushRecentFolder(this.recentFoldersByDevice, deviceId, path);
    saveRecentFolders(browserStorage(), this.recentFoldersByDevice);
  }

  /** 宿主给不给「添加一台机器」的入口(老宿主没有)。 */
  get canAddMachine(): boolean {
    return typeof this.bridge?.openAddMachine === 'function';
  }

  openAddMachine(): void {
    this.bridge?.openAddMachine?.();
  }

  requestNewSession(deviceId: string, projectPath: string | null): void {
    this.newSessionTarget = { deviceId, projectPath };
  }

  takeNewSessionTarget(): { deviceId: string; projectPath: string | null } | null {
    const target = this.newSessionTarget;
    this.newSessionTarget = null;
    return target;
  }

  pickFolder(deviceId: string, initialPath: string): Promise<string | null> {
    if (!this.bridge) return Promise.reject(new Error('remote hosts bridge is not available'));
    return this.bridge.pickFolder(deviceId, initialPath);
  }

  /**
   * #7403 那台的咕咕太旧、不认这一问:请它当场换成和这台桌面匹配的版本(见 RemoteHostsBridge.matchServerVersion)。
   * 它还是这个版本时已经请过就不再请;人点「重试」(`retry`)照请。老宿主没有这一格 = false。
   */
  matchServerVersion(deviceId: string, options?: { retry?: boolean }): Promise<boolean> {
    const match = this.bridge?.matchServerVersion;
    if (!match) return Promise.resolve(false);
    const version = this.device(deviceId)?.version ?? null;
    const asked = this.versionMatchAsked.get(deviceId);
    if (!options?.retry && asked && asked.version === version) return asked.requested;
    // 没请到(那台不认这一请、连不上):忘掉这一次,下回照请。
    const requested = match(deviceId, options)
      .catch((error: unknown) => {
        log.warn('[machines] 请那台换成匹配的版本没请到', { deviceId, error: error instanceof Error ? error.message : String(error) });
        return false;
      })
      .then((ok) => {
        if (!ok && this.versionMatchAsked.get(deviceId)?.requested === requested) this.versionMatchAsked.delete(deviceId);
        return ok;
      });
    this.versionMatchAsked.set(deviceId, { version, requested });
    return requested;
  }

  /** 远程 SSH 的机器要先登录:经窗口顶上那张卡片问一次。老宿主没有 = false。 */
  signIn(deviceId: string): Promise<boolean> {
    return this.bridge?.signInSsh?.(deviceId) ?? Promise.resolve(false);
  }

  /** 「重新连接」:不等退避立刻再连一次。 */
  reconnect(deviceId: string): void {
    reconnectMachine(deviceId);
  }

  /** 侧栏那颗点:连接中 / 已连接 / 重连中 / 离线 / 要先登录 / 版本太旧。 */
  connectionState(deviceId: string): HostConnectionState | null {
    const state = this.hosts.get(deviceId);
    if (!state) return null;
    return machineConnectionState(state, this.wakes.get(deviceId)?.status ?? null);
  }

  /**
   * 在这台机器上把这个文件夹加成项目(新建时选了那台机器上还不是项目的文件夹),挂上,返回项目 id。
   * 与本机「打开文件夹」同一步(projectManager.createProject),只是建在那台机器上。
   */
  async ensureProject(deviceId: string, path: string): Promise<string> {
    const name = path.replace(/\/+$/, '').split('/').pop() || path;
    const projectId = await appState.projects.createProject(
      { type: 'local', machine: deviceId },
      { mode: 'pick', path, name, initGitRepository: false, createDirectory: false, allowNonGit: true }
    );
    if (!projectId) throw new Error(`could not add ${path} as a project on ${deviceId}`);
    await appState.projects.ensureMounted(projectId);
    return projectId;
  }

  /**
   * 那台机器的主目录项目(没选项目时会话落在这里):那台机器上已有同路径项目就复用,没有就建一个。返回项目 id。
   * 同一台机器同时只建一次(新建页与对话页创建框可能同时要)。
   */
  ensureHomeProject(deviceId: string): Promise<string> {
    const inFlight = this.homeProjectPromises.get(deviceId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const home = await this.ensureHomeDir(deviceId);
      const onMachine = [...appState.projects.projects.values()]
        .filter((project) => machineRegistry.machineOf(project.id) === deviceId && !isImplicitSessionHomeProject(project))
        .map((project) => ({ id: project.id, path: project.data?.path }));
      const existing = findHomeProject(onMachine, home);
      if (!existing) return this.ensureProject(deviceId, home);
      await appState.projects.ensureMounted(existing.id);
      return existing.id;
    })().finally(() => this.homeProjectPromises.delete(deviceId));
    this.homeProjectPromises.set(deviceId, promise);
    return promise;
  }

  private attach(bridge: RemoteHostsBridge | null): void {
    if (bridge === this.bridge) return;
    this.stopDevices?.();
    this.stopDevices = null;
    runInAction(() => {
      this.bridge = bridge;
    });
    if (!bridge) {
      for (const deviceId of [...this.hosts.keys()]) this.forget(deviceId);
      return;
    }
    const offDevices = bridge.subscribeDevices(() => this.reconcile());
    // 那台机器上的项目清单变了(新建 / 删掉 / 显隐):在那台机器上订,重读它的清单(只登记,❌ 挂;用到时 ensureMounted)。
    const offProjects = onEachMachine((deviceId) => {
      const offs = [projectCreatedChannel, projectDeletedChannel, projectVisibilityChangedChannel].map((event) =>
        onMachineEvent(deviceId, event as EventDefinition<unknown>, () => void this.syncProjects(deviceId))
      );
      return () => offs.forEach((off) => off());
    });
    this.stopDevices = () => {
      offDevices();
      offProjects();
    };
    this.reconcile();
  }

  private reconcile(): void {
    const bridge = this.bridge;
    if (!bridge) return;
    const devices = bridge.listDevices();
    const seen = new Set<string>();
    for (const device of devices) {
      seen.add(device.id);
      const current = this.hosts.get(device.id);
      const cameBack = current !== undefined && !remoteHostReachable(current.device) && remoteHostReachable(device);
      runInAction(() => {
        if (current) current.device = device;
        else this.hosts.set(device.id, { device, link: machineLinkState(device.id), synced: false });
        // #7199 叫醒没成之后它在别处被叫醒了(正在醒 / 醒了):那条旧的「没叫醒」不再盖住它此刻的样子。
        if (device.cloudComputer && device.cloudComputer !== 'asleep' && this.wakes.get(device.id)?.status === 'failed') this.wakes.delete(device.id);
      });
      if (!current) this.watch(device.id);
      else this.applyAccountProjects(device.id);
      // 心跳说它在(远程 SSH:设备连接没报问题)就连;刚从离线回来的不等退避。
      if (remoteHostReachable(device)) {
        const client = machineClient(device.id);
        if (client && linkNeedsReopen(device, machineLinkState(device.id), client, cameBack)) reconnectMachine(device.id);
      }
    }
    for (const deviceId of [...this.hosts.keys()]) if (!seen.has(deviceId)) this.forget(deviceId);
  }

  private watch(deviceId: string): void {
    // 账号上记着的清单先列出来(离线也照样在侧栏里);连上之后以那台机器此刻的为准。
    this.applyAccountProjects(deviceId);
    // 上次的会话也先铺出来(本地底稿):打开就看得到上次的样子,连上之后原地换成此刻的。
    void readCachedSessionList<never, SessionpageSessionSummary>(deviceId).then((stored) => {
      if (!stored || this.directory[deviceId] || !this.hosts.has(deviceId)) return;
      updateDeviceSessions(deviceId, { projects: [], sessions: stored.sessions, cached: true, loading: false });
    });
    let wasOpen = false;
    const onLink = () => {
      const link = machineLinkState(deviceId);
      runInAction(() => {
        const state = this.hosts.get(deviceId);
        if (state) state.link = link;
      });
      if (link === 'open') {
        this.startListSync(deviceId);
        void this.syncProjects(deviceId).then(() => {
          if (wasOpen) appState.projects.refreshMachineProjects(deviceId);
          wasOpen = true;
        });
      } else {
        this.applyAccountProjects(deviceId);
      }
    };
    this.linkOffs.set(deviceId, subscribeMachineLink(deviceId, onLink));
    onLink();
  }

  /** 读那台机器的项目清单并入项目表(连上时 / 那台机器上新建了项目时)。 */
  async syncProjects(deviceId: string): Promise<void> {
    try {
      const [projects, home] = await Promise.all([
        rpcOn(deviceId).projects.getProjects(),
        rpcOn(deviceId).app.getHomeDirectory().catch(() => null),
      ]);
      if (home) this.rememberHomeDir(deviceId, home);
      appState.projects.syncMachineProjects(deviceId, projects);
      runInAction(() => {
        const state = this.hosts.get(deviceId);
        if (state) state.synced = true;
      });
      const records = this.hosts.get(deviceId)?.device.projects;
      if (records) this.accountSeenLive.set(deviceId, accountCopyKey(records));
    } catch (error) {
      log.warn('[machines] 读那台机器的项目清单失败', { deviceId, error: String(error) });
    }
  }

  /**
   * 那台机器头一回连上:起它的会话列表同步(底稿 → 订阅 → 合增量;断过再通自己重来)。只在连上时起 —— 起同步就会去连它,
   * ❌ 对着离线的机器一遍遍连。之后一直留着,直到这台机器从名下拿掉。
   */
  private startListSync(deviceId: string): void {
    if (this.listSyncs.has(deviceId)) return;
    this.listSyncs.set(
      deviceId,
      startSessionListSync(machineSessionListClient, deviceId, {
        onList: (result, { cached }) =>
          updateDeviceSessions(deviceId, { projects: result.projects, sessions: result.sessions, cached }),
        onLoading: (loading) => updateDeviceSessions(deviceId, { loading }),
        onError: (error) => {
          updateDeviceSessions(deviceId, { error });
          if (error) log.warn('[machines] 读那台机器的会话列表失败', { deviceId, error });
        },
      })
    );
  }

  /** 名下没有这台机器了(被移除 / 换了账号):它的项目、线、缓存一起收掉。 */
  private forget(deviceId: string): void {
    this.listSyncs.get(deviceId)?.stop();
    this.listSyncs.delete(deviceId);
    retainDeviceSessions([...this.hosts.keys()].filter((id) => id !== deviceId));
    this.linkOffs.get(deviceId)?.();
    this.linkOffs.delete(deviceId);
    this.accountSeenLive.delete(deviceId);
    closeMachineClient(deviceId);
    appState.projects.dropMachine(deviceId);
    machineRegistry.forgetMachine(deviceId);
    runInAction(() => this.hosts.delete(deviceId));
    if (this.homeDirs[deviceId]) {
      const { [deviceId]: _home, ...rest } = this.homeDirs;
      runInAction(() => (this.homeDirs = rest));
    }
  }

  /**
   * #113 没连着那台机器时,它的项目清单与群绑定照账号上记着的那份。这一端还没读到过账号上的那份就不动(❌ 拿空清单把侧栏里
   * 它的项目清掉);连着时以那台机器此刻的回答为准(syncProjects、projectGroupsStore.refresh),这时看到的账号上那份记下来:
   * 断开之后它没变,就照旧列着连着时读到的(见 accountCopyReplacesLive)。
   */
  private applyAccountProjects(deviceId: string): void {
    const state = this.hosts.get(deviceId);
    const records = state?.device.projects;
    if (!state || !records) return;
    if (machineLinkState(deviceId) === 'open') {
      if (state.synced) this.accountSeenLive.set(deviceId, accountCopyKey(records));
      return;
    }
    if (!this.accountIsNewer(deviceId)) return;
    appState.projects.syncMachineProjects(deviceId, accountProjectsOf(deviceId, records));
    projectGroupsStore.applyBindings(deviceId, accountBindingsOf(deviceId, records));
  }

  /** #113 账号上那份比这一端经连接读到的新(或这一端还没经连接读到过它):没连着时以账号上那份为准。 */
  accountIsNewer(deviceId: string): boolean {
    const state = this.hosts.get(deviceId);
    const records = state?.device.projects;
    if (!state || !records) return false;
    return accountCopyReplacesLive({
      answeredLive: state.synced,
      seenWhileLive: this.accountSeenLive.get(deviceId),
      current: accountCopyKey(records),
    });
  }

  /** #113 账号上记着的那台机器上这个项目的文件夹;没读到过账号上的那份 / 那里没有这个项目 = null。 */
  accountFolders(deviceId: string, projectId: string): ProjectFolder[] | null {
    const records = this.device(deviceId)?.projects;
    return records ? accountFoldersOf(deviceId, records, projectId) : null;
  }
}

/**
 * 心跳说那台机器在时,到它的线要不要现在重开(纯函数,单测钉):断着的要;开着、但 hello 说对面太旧,而设备行
 * 报的版本已经不是 hello 时那一版的,也要 —— 咕咕 server 换版时旧线什么也不说就死了,要等下一拍心跳(20 s)
 * 才知道;设备行在新版起来后第一拍心跳就换了版本。版本没变(一直不升级的旧机器)或有一边不报版本,照旧不动。
 * 刚从离线回来的(`cameBack`):正在开的那一次是离线时发出去的,对面没人接,要等满超时 —— 作废它,立刻重开。
 */
export function linkNeedsReopen(
  device: Pick<RemoteHostDevice, 'version'>,
  link: MachineLinkState,
  client: Pick<SessionHostClient, 'state' | 'hello'>,
  cameBack = false
): boolean {
  if (client.state() === 'closed') return true;
  if (client.state() === 'connecting') return cameBack;
  const helloVersion = client.hello()?.appVersion;
  return link === 'tooOld' && client.state() === 'open' && !!device.version && !!helloVersion && device.version !== helloVersion;
}

/** 侧栏那颗点的判据(纯函数,单测钉):设备状况 + 到它会话页宿主的线。 */
export function machineConnectionState(
  state: Pick<RemoteHostState, 'device' | 'link' | 'synced'>,
  /** #7199 这一端正在叫醒它 / 叫醒没成(只对云电脑有)。 */
  wake: CloudWake['status'] | null = null
): HostConnectionState {
  // 远程 SSH 的机器太旧:设备连接那一格说得更具体(正在替它升级 / 没升成),先看它。
  const ssh = state.device.sshLink;
  if (state.link === 'tooOld' && ssh !== 'updating' && ssh !== 'outdated') return 'outdated';
  return hostConnectionState({
    online: state.device.isOnline,
    loading: state.link === 'connecting' && !state.synced,
    unreachable: state.device.isOnline && state.link === 'closed' && state.synced,
    sshLink: state.device.sshLink ?? null,
    cloudComputer: state.device.cloudComputer ?? null,
    wake: state.device.cloudComputer ? wake : null,
  });
}

export const remoteHostsStore = new RemoteHostsStore();
