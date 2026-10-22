import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { makeObservable, observable, reaction, runInAction, toJS } from 'mobx';
import { toast } from 'sonner';
import { match } from 'ts-pattern';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import {
  getProjectManagerStore,
} from '@renderer/features/projects/stores/project-selectors';
import type { ProjectSettingsStore } from '@renderer/features/projects/stores/project-settings-store';
import { getSessionGitWorktreeStore } from '@renderer/features/sessions/stores/session-selectors';
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { workspaceEvents } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import {
  sessionChangedChannel,
  sessionCreatedChannel,
  sessionDeletedChannel,
} from '@shared/core/sessions/sessionEvents';
import type { Session } from '@shared/core/sessions/sessions';
import { firstUtteranceOf, initialAgentStatus } from '@shared/core/sessions/initial-agent-status';
import { gitWorktreeUpdateChannel } from '@shared/core/git/events';
import { prSyncProgressChannel, prUpdatedChannel } from '@shared/core/pull-requests/prEvents';
import {
  lifecycleScriptStatusChannel,
  sessionProvisionProgressChannel,
  sessionProvisionedChannel,
  sessionReclaimedChannel,
} from '@shared/core/sessions/provisionEvents';
import type {
  CreateSessionError,
  CreateSessionParams,
  ProvisionWorkspaceError,
} from '@shared/core/sessions/create-session';
import type { SessionViewSnapshot } from '@shared/view-state';
import { SessionCreationFailedError, type SessionFailure } from './session-failure';
import { describeSessionFailure } from './session-failure-message';

export { SessionCreationFailedError };
import {
  createUnprovisionedSession,
  createUnregisteredSession,
  isProvisioned,
  isRegistered,
  isUnprovisioned,
  isUnregistered,
  type SessionPageStore,
} from './session-store';
import { terminalRegistry } from './terminal-registry';
import { workspaceRegistry } from './workspace-registry';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { rendererLogger } from '../../../../../lib/log';
import { queryClient } from '@renderer/lib/query-client';
import { AGENTS_METADATA_QUERY_KEY } from '@renderer/lib/stores/use-agents';
import type { AgentPayload } from '@shared/core/agents/agent-payload';

/**
 * 这一家 hooks descriptor 的 kind(#6206 状态源判据的输入),读 `useAgents` 同一份清单:composer 选 harness 时
 * 已经拉过,缓存命中即时返回;没拉过(别的新建面)就拉一次。清单里没有这一家 ⇒ 抛:乐观对象与落库行必须
 * 同一组输入,❌ 猜一个 hooks kind。
 */
async function agentHooksKind(provider: string): Promise<string> {
  const agents = await queryClient.ensureQueryData<AgentPayload[]>({
    queryKey: AGENTS_METADATA_QUERY_KEY,
    queryFn: () => rpc.agents.list() as Promise<AgentPayload[]>,
  });
  const agent = agents.find((candidate) => candidate.id === provider);
  if (!agent) throw new Error(`session-manager: agent catalog has no '${provider}' at session creation`);
  return agent.capabilities.hooks.kind;
}

// 失败在 store 里只以**领域语义**存放（见 session-failure.ts）：不成句、不认识 catalog、不读 locale。
// 成句在渲染边界（sessionErrorMessage）发生 —— 切换语言时那条已经显示出来的错误才会跟着变，
// 而且不需要重跑任何创建/准备流程。setup step 名与底层 message 都作为具名字段原样保存。
export function createSessionFailure(error: CreateSessionError): SessionFailure {
  return match<CreateSessionError, SessionFailure>(error)
    .with({ type: 'project-not-found' }, () => ({ kind: 'project-not-found' }))
    .with({ type: 'harness-unavailable' }, (e) => ({
      kind: 'harness-unavailable' as const,
      reason: e.reason,
      providerId: e.providerId,
      harnessName: e.harnessName,
      detail: e.detail,
    }))
    .with({ type: 'provision-failed' }, (e) => ({ kind: 'raw' as const, detail: e.message }))
    .with({ type: 'provision-timeout' }, (e) => ({
      kind: 'provision-timeout' as const,
      timeoutMs: e.timeoutMs,
    }))
    .exhaustive();
}

export function provisionWorkspaceFailure(error: ProvisionWorkspaceError): SessionFailure {
  return match<ProvisionWorkspaceError, SessionFailure>(error)
    .with({ type: 'no-intent' }, () => ({ kind: 'workspace-no-intent' }))
    .with({ type: 'missing-workspace' }, () => ({ kind: 'workspace-missing' }))
    .with({ type: 'setup-failed' }, (e) => ({
      kind: 'setup-step-failed',
      stepKind: e.stepKind,
      stepErrorType: e.stepErrorType,
      ...(e.message ? { detail: e.message } : {}),
    }))
    .exhaustive();
}

const sessionLog = rendererLogger('session-manager');

/**
 * provision 时要恢复的视图状态:聚合快照 `session:<id>` 与页签布局 `session:<id>:tabs` 都经主进程取(#6799)。
 * 挂起时两个键都从渲染侧缓存里清掉了,而 paneLayout.hydrate 只同步读缓存 —— 只取聚合键,同一场里
 * 再打开的会话(闲置回收后)页签就没人读。
 */
async function loadSavedSessionView(sessionId: string): Promise<SessionViewSnapshot | undefined> {
  const [snapshot] = await Promise.all([
    viewStateCache.get(`session:${sessionId}`),
    viewStateCache.get(`session:${sessionId}:tabs`),
  ]);
  return snapshot as SessionViewSnapshot | undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一个项目里的会话在会话页的那一份(按会话 id 记)。会话出现、消失跟着会话自己的事件走:
 * session:created(新建、派生、分叉、从历史恢复)放进来,session:deleted 与归档拿出去。
 */
export class ProjectSessionsStore {
  private readonly projectId: string;
  private readonly _repository: GitRepositoryStore;
  private readonly _settingsStore: ProjectSettingsStore;
  private _loadPromise: Promise<void> | null = null;
  private _provisionPromises = new Map<string, Promise<void>>();
  private readonly _offs: Array<() => void> = [];
  private _disposeRepositoryReaction: (() => void) | null = null;

  sessions = observable.map<string, SessionPageStore>();
  /** 会话列表头一回读的结果。reading 时「列表里没有这条」不等于「不存在」;failed = 没读成(人的动作据此说「准备失败」)。 */
  listState: 'reading' | 'read' | 'failed' = 'reading';

  constructor(
    projectId: string,
    repository: GitRepositoryStore,
    settingsStore: ProjectSettingsStore
  ) {
    this.projectId = projectId;
    this._repository = repository;
    this._settingsStore = settingsStore;
    makeObservable(this, { sessions: observable, listState: observable });

    // 这个项目在哪台机器上,它的会话事件就在那台机器上订(本机 = null)。
    const machine = machineRegistry.machineOf(projectId);
    this._offs.push(
      onMachineEvent(machine, sessionCreatedChannel, ({ session }) => {
        this.acceptCreatedSession(session);
      }),
      onMachineEvent(machine, sessionDeletedChannel, ({ sessionId, projectId: evtProjectId }) => {
        if (evtProjectId !== this.projectId) return;
        this._removeSessionLocally(sessionId);
      }),
      // 归档 = 这条会话离开列表:与删除同形,收起它在会话页的那一份(恢复时 session:created 再放回来)。
      onMachineEvent(machine, sessionChangedChannel, ({ sessionId, projectId: evtProjectId, changes }) => {
        if (evtProjectId !== this.projectId || !changes.archivedAt) return;
        this._removeSessionLocally(sessionId);
      }),
      onMachineEvent(machine, sessionProvisionProgressChannel, ({ sessionId, projectId: evtProjectId, message }) => {
        if (evtProjectId !== this.projectId) return;
        const store = this.sessions.get(sessionId);
        if (store?.isBootstrapping) {
          runInAction(() => {
            store.provisionProgressMessage = message;
          });
        }
      }),
      onMachineEvent(machine, lifecycleScriptStatusChannel, (statusEvent) => {
        if (
          statusEvent.projectId !== this.projectId ||
          statusEvent.status !== 'failed' ||
          !statusEvent.surfaceFailure
        ) {
          return;
        }
        const { workspaceId, type, message } = statusEvent;
        // 脚本是工作区的;报给人看时带上在这个工作区里的一条会话的名字。
        const sessionName = [...this.sessions.values()].find((session) => session.workspaceId === workspaceId)?.displayName;
        const label = type[0].toUpperCase() + type.slice(1);
        toast.error(
          sessionName
            ? translateSessionMessage('taskError.scriptFailedForTask', { label, sessionName })
            : translateSessionMessage('taskError.scriptFailed', { label }),
          // description 是用户自己那段脚本的输出,不是内部报错 —— 留着。
          { description: message }
        );
      }),
      // Handles sessions provisioned by the automation path (or any main-process caller)
      // without renderer-initiated RPCs. The `isUnprovisioned` guard prevents a
      // double-transition if the renderer-driven RPC already completed first.
      onMachineEvent(machine, sessionProvisionedChannel, ({ sessionId, projectId: evtProjectId, path, workspaceId }) => {
        if (evtProjectId !== this.projectId) return;
        void this._doHandleProvisioned(sessionId, path, workspaceId);
      }),
      // spec idle-reclaim:回收停的是会话**进程**,界面原样留着 —— 会话挂起成「没准备」,视图模型(页签、聊天那份
      // store 和它的滚动位置)不动;下次显示时 view.tsx 照常 provision,终端腿按原会话续上,聊天腿下一句话再起(#6497)。
      // #6950:这里曾把视图模型 dispose 掉换一个新的,于是切回去贴到了底部、右栏还多出一个页签。
      // ❌ 释放会话表 / 终端表(归档那样):没准备的会话也靠它们给侧栏出行,表不计引用,一放就整张没了。
      onMachineEvent(machine, sessionReclaimedChannel, ({ sessionId, projectId: evtProjectId }) => {
        if (evtProjectId !== this.projectId) return;
        const session = this.sessions.get(sessionId);
        if (!session || !isProvisioned(session)) return;
        runInAction(() => session.transitionToUnprovisioned('idle'));
      }),
      onMachineEvent(machine, prUpdatedChannel, ({ prs }) => {
        const repoUrl = this._repository.pullRequestRepositoryUrl;
        if (!repoUrl) return;
        for (const pr of prs) {
          if (pr.repositoryUrl !== repoUrl) continue;
          for (const [, store] of this.sessions) {
            if (!isRegistered(store)) continue;
            const branchName = getSessionGitWorktreeStore(this.projectId, store.id)?.branchName;
            if (branchName !== pr.headRefName) continue;
            runInAction(() => {
              const idx = store.prs.findIndex((p) => p.url === pr.url);
              store.prs = idx >= 0 ? store.prs.map((p, i) => (i === idx ? pr : p)) : [...store.prs, pr];
            });
          }
        }
      }),
      onMachineEvent(machine, prSyncProgressChannel, (progress) => {
        if (progress.status !== 'done') return;
        const repoUrl = this._repository.pullRequestRepositoryUrl;
        if (!repoUrl || progress.remoteUrl !== repoUrl) return;
        for (const [, store] of this.sessions) {
          if (isProvisioned(store)) void this._reloadPrsForSession(store);
        }
      }),
      workspaceEvents.on(gitWorktreeUpdateChannel, (payload) => {
        if (payload.projectId !== this.projectId || payload.update.kind !== 'head') return;
        for (const [, store] of this.sessions) {
          if (isProvisioned(store) && store.workspaceId === payload.workspaceId) {
            void this._reloadPrsForSession(store);
          }
        }
      })
    );

    this._disposeRepositoryReaction = reaction(
      () => this._repository.pullRequestRepositoryUrl,
      () => {
        for (const [, store] of this.sessions) {
          if (isProvisioned(store)) void this._reloadPrsForSession(store);
        }
      }
    );
  }

  acceptCreatedSession(session: Session): void {
    if (session.projectId !== this.projectId || this.sessions.has(session.id)) return;
    runInAction(() => {
      this.sessions.set(session.id, createUnprovisionedSession(session));
      // Acquire conversation/terminal managers inside the same action so the
      // WorkspaceViewModel's reaction on `sessions.size` registers the
      // manager's observable map as a dependency on its first evaluation.
      sessionRegistry.acquire(session.id, this.projectId, [session]);
      terminalRegistry.acquire(session.id, this.projectId);
    });
  }

  private async _reloadPrsForSession(store: SessionPageStore): Promise<void> {
    if (!isRegistered(store)) return;
    const result = await rpc.pullRequests.getPullRequestsForSession(this.projectId, store.id);
    if (!result.success) return;
    runInAction(() => {
      store.prs = result.data.prs;
    });
  }

  private _releaseSessionRegistries(sessionId: string): void {
    sessionRegistry.release(sessionId);
    terminalRegistry.release(sessionId);
  }

  private _removeSessionLocally(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._releaseSessionRegistries(sessionId);
    session.dispose();
    runInAction(() => {
      this.sessions.delete(sessionId);
    });
  }

  /** 读这个项目的会话(没归档的),各建一份;工作区的改动行数一起带上(侧栏没挂载时也显示)。 */
  private async _readProject(): Promise<{
    sessions: Session[];
    gitByWorkspace: Map<string, { linesAdded: number; linesDeleted: number }>;
  }> {
    const [sessions, workspaces] = await Promise.all([
      rpc.sessions.getSessionsForProject(this.projectId),
      rpc.sessionCreate.getProjectWorkspaces(this.projectId),
    ]);
    const gitByWorkspace = new Map<string, { linesAdded: number; linesDeleted: number }>();
    for (const ws of workspaces) {
      if (ws.linesAdded != null) gitByWorkspace.set(ws.id, { linesAdded: ws.linesAdded, linesDeleted: ws.linesDeleted ?? 0 });
    }
    return { sessions, gitByWorkspace };
  }

  private _adopt(session: Session, git: { linesAdded: number; linesDeleted: number } | undefined): void {
    const store = createUnprovisionedSession(session);
    store.workspaceGit = git;
    this.sessions.set(session.id, store);
    sessionRegistry.acquire(session.id, this.projectId, [session]);
    terminalRegistry.acquire(session.id, this.projectId);
  }

  /**
   * #6264 别的机器断开又连上:重读会话并补齐(loadSessions 只读一次;断开那段时间的推送收不到)。
   * 只补不删 —— 删除 / 归档有自己的推送,断线期间错过的由下一次打开这台机器的项目纠正。
   */
  async resync(): Promise<void> {
    const { sessions, gitByWorkspace } = await this._readProject();
    runInAction(() => {
      for (const session of sessions) {
        if (!this.sessions.has(session.id)) {
          this._adopt(session, session.workspaceId ? gitByWorkspace.get(session.workspaceId) : undefined);
          continue;
        }
        sessionRegistry.get(session.id)?.reconcile([session]);
      }
    });
  }

  loadSessions(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._readProject()
        .then(({ sessions, gitByWorkspace }) => {
          runInAction(() => {
            for (const session of sessions) {
              this._adopt(session, session.workspaceId ? gitByWorkspace.get(session.workspaceId) : undefined);
            }
            this.listState = 'read';
          });
        })
        .catch((e) => {
          console.error('Error loading sessions', e);
          runInAction(() => {
            this.listState = 'failed';
          });
        });
    }
    return this._loadPromise;
  }

  async createSession(params: CreateSessionParams) {
    const ic = params.sessionConfig.initialSession;
    if (!ic) throw new Error('createSession: a session is created together with its initial agent config');
    const id = ic.id;
    const initialHooksKind = await agentHooksKind(ic.provider);
    const workspace = params.workspaceConfig.workspace;
    const firstUtterance = firstUtteranceOf(ic);
    const optimistic: Session = {
      id,
      projectId: this.projectId,
      // For repository-instance sessions the workspace is known at creation time —
      // set it immediately so consumers can reference it before provisioning completes.
      ...(workspace.kind === 'repository-instance' && { workspaceId: workspace.workspaceId }),
      ...(params.sessionConfig.linkedIssue && { linkedIssue: params.sessionConfig.linkedIssue }),
      ...(params.automationRunId && { automationRunId: params.automationRunId }),
      providerId: ic.provider as AgentProviderId,
      title: ic.title ?? '',
      lastInteractedAt: new Date().toISOString(),
      ...(ic.permissionMode !== undefined && { permissionMode: ic.permissionMode }),
      model: ic.model,
      effort: ic.effort,
      initialQueue: ic.initialQueue,
      startupOrigin: ic.startupOrigin,
      initialMessageId: ic.initialMessageId,
      taskChatId: ic.taskChatId,
      // spec session-resume：创建 = 带着第一句话开一件活，那句话此刻就在手上。漏掉它，面板会在
      // 首轮落进 transcript 之前把这条会话读成「空白会话」，于是「今天我们做点什么？」这块占位页
      // 闪一下再消失，输入框也跟着从「随心输入」切成「要求后续变更」—— 一次纯粹的假状态。
      // 用共享的那把尺子(服务端 build-session-row 用的是同一把)：首轮可能只写在
      // initialPrompt / initialQueue 里，自己在这儿判一遍必然漏。
      ...(firstUtterance ? { firstUtterance } : {}),
      runtime: ic.type ?? 'pty',
      // @@@2504 — mirror the status the create transaction is about to persist. Left unset this
      // object read as `idle`, so a creation that explicitly carried work flashed Idle→Working.
      // 同一把尺子也要同一组输入:没有状态源的终端会话(#6206)这里同样是 `null`,否则先闪一下转圈。
      agentStatus: initialAgentStatus(ic, { runtime: ic.type ?? 'pty', hooksKind: initialHooksKind }),
      agentStatusSeen: true,
    };
    runInAction(() => {
      this.sessions.set(id, createUnregisteredSession(optimistic));
      sessionRegistry.acquire(id, this.projectId, [optimistic]);
      terminalRegistry.acquire(id, this.projectId);
    });

    const result = await rpc.sessionCreate
      .createSession(JSON.parse(JSON.stringify(toJS(params))) as typeof params)
      .catch((e: unknown) => {
        // 抛出来的是未知错误：原文逐字存进 store，渲染时原样呈现、永不翻译。
        const message = e instanceof Error ? e.message : String(e);
        runInAction(() => {
          const current = this.sessions.get(id);
          if (current && isUnregistered(current)) {
            current.phase = 'create-error';
            current.failure = { kind: 'raw', detail: message };
          }
          // @@@2504 — creation failed, so the session the optimistic phase minted never existed.
          // Drop it instead of leaving a conversation whose birth status reads Working forever.
          this._releaseSessionRegistries(id);
        });
        throw e;
      });

    if (!result.success) {
      const failure = createSessionFailure(result.error);
      // @@@5173 引擎不可用 ⇒ 库里根本没建出这条会话(createSession 的前置检查在事务之前就返回了)。
      // 其余失败留一条 create-error 行,是为了让用户在侧栏看见原因;这一种**没有行可留** ——
      // 留下来的那条转不完的空行,恰恰就是本 issue 要消灭的「还得用户自己去删的东西」。
      // 所以它改从右下角的瞬时通知说(owner 定),走的是「脚本失败」同一条 toast 通道:
      // 这一轮什么都没落库,用户看完这句话就该接着用 composer 里那段还在的正文重试。
      if (result.error.type === 'harness-unavailable') {
        toast.error(describeSessionFailure(failure, translateSessionMessage));
        this._removeSessionLocally(id);
        throw new SessionCreationFailedError(result.error.type, failure);
      }
      runInAction(() => {
        const current = this.sessions.get(id);
        if (current && isUnregistered(current)) {
          current.phase = 'create-error';
          current.failure = failure;
        }
        this._releaseSessionRegistries(id);
      });
      // 面向开发者的抛出：稳定的协议 error type，不是产品文案（后者由 store 里的 failure 渲染）。
      throw new SessionCreationFailedError(result.error.type, failure);
    }

    runInAction(() => {
      const current = this.sessions.get(id);
      if (current && isUnregistered(current)) {
        current.transitionToUnprovisioned('provision');
        if (optimistic.workspaceId) current.workspaceId = optimistic.workspaceId;
        // Conversation and terminal registries already acquired in the optimistic phase.
      }
    });

    this._settingsStore.pageData.invalidate();

    await this.provisionSession(id);
  }

  async provisionSession(sessionId: string): Promise<void> {
    try {
      await getProjectManagerStore().mountProject(this.projectId);
      await this.loadSessions();
    } catch (error) {
      // 调用方(会话视图的自动准备)吞掉异常:这里不落成失败态,人就对着「正在准备文件…」一直转下去。
      this.markProvisionFailed(sessionId, error);
      throw error;
    }

    const inFlight = this._provisionPromises.get(sessionId);
    if (inFlight) return inFlight;

    const session = this.sessions.get(sessionId);
    if (!session || !isUnprovisioned(session)) return;

    runInAction(() => {
      session.phase = 'provision';
    });

    const promise = this._doProvision(sessionId).finally(() => {
      this._provisionPromises.delete(sessionId);
    });

    this._provisionPromises.set(sessionId, promise);
    return promise;
  }

  private async _doProvision(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !isUnprovisioned(session)) return;

    const wsId = session.data.workspaceId;

    // Single-phase provision: workspace bootstrap + provider construction + registration.
    if (wsId) workspaceRegistry.setBootstrapState(this.projectId, wsId, { kind: 'resolving' });
    let result: Awaited<ReturnType<typeof rpc.sessionCreate.provisionWorkspace>>;
    try {
      result = await rpc.sessionCreate.provisionWorkspace(sessionId);
    } catch (error) {
      // #6264 这一问没答回来(别的机器上的会话:连接此刻断了 / 连不上)。❌ 停在「正在准备文件…」一直转:
      // 落成失败态,界面给「重试」,话是连接那一层给的人话(「此刻连不上 Linux 2」)。
      this.markProvisionFailed(sessionId, error);
      return;
    }
    if (!result.success) {
      const failure = provisionWorkspaceFailure(result.error);
      if (wsId) workspaceRegistry.setBootstrapState(this.projectId, wsId, { kind: 'error', failure });
      runInAction(() => {
        const current = this.sessions.get(sessionId);
        if (current && isUnprovisioned(current)) {
          current.phase = 'provision-error';
          current.failure = failure;
        }
      });
      return;
    }

    if (wsId) workspaceRegistry.setBootstrapState(this.projectId, wsId, { kind: 'ready' });

    await this._doHandleProvisioned(sessionId, result.data.path, result.data.workspaceId);
  }

  /** 准备没成(没答回来,不是主进程答了「失败」):落成可重试的失败态。 */
  private markProvisionFailed(sessionId: string, error: unknown): void {
    sessionLog.warn({ projectId: this.projectId, sessionId, err: formatErrorMessage(error) }, 'provisionSession did not get an answer');
    runInAction(() => {
      const current = this.sessions.get(sessionId);
      if (!current || !isUnprovisioned(current)) return;
      const wsId = current.data.workspaceId;
      const failure: SessionFailure = { kind: 'raw', detail: formatErrorMessage(error) };
      if (wsId) workspaceRegistry.setBootstrapState(this.projectId, wsId, { kind: 'error', failure });
      current.phase = 'provision-error';
      current.failure = failure;
    });
  }

  private async _doHandleProvisioned(
    sessionId: string,
    path: string,
    workspaceId: string
  ): Promise<void> {
    const savedSnapshot = await loadSavedSessionView(sessionId);
    runInAction(() => {
      const current = this.sessions.get(sessionId);
      if (current && isUnprovisioned(current)) {
        sessionRegistry.acquire(sessionId, this.projectId);
        terminalRegistry.acquire(sessionId, this.projectId);
        current.transitionToProvisioned(path, workspaceId, this._repository, savedSnapshot);
        current.activate();
      }
    });
    // 会话的 PR 在它打开时取(会话页里的 PR 视图用);❌ 列出时给每条会话各问一次 —— 381 条就是 381 问。
    const opened = this.sessions.get(sessionId);
    if (opened && isProvisioned(opened)) void this._reloadPrsForSession(opened);
  }

  async setSessionPinned(sessionId: string, isPinned: boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.setPinned(isPinned);
  }

  dispose(): void {
    for (const off of this._offs.splice(0)) off();
    this._disposeRepositoryReaction?.();
    this._disposeRepositoryReaction = null;
  }
}
