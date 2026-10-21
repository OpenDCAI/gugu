import { makeAutoObservable, observable, runInAction } from 'mobx';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import type { GitRepositoryStore } from '@renderer/features/projects/stores/git-repository-store';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { Session } from '@shared/core/sessions/sessions';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { SessionViewSnapshot } from '@shared/view-state';
import { workspaceRegistry } from './workspace-registry';
import { WorkspaceViewModel } from './workspace-view-model';
import type { SessionFailure } from './session-failure';

export type { SessionFailure } from './session-failure';

export type UnregisteredSessionPhase = 'creating' | 'create-error';

export type UnprovisionedSessionPhase = 'provision' | 'provision-error' | 'idle';

/**
 * 一条会话在会话页里的那一份:它的挂载状态(还在建 / 没挂工作区 / 挂好了)和右侧工作台的视图模型。
 * 按会话 id 记。会话本身的字段(标题、置顶、归档……)只有一个真相源 —— 会话 store(sessionRegistry),
 * 这里的 `data` 读的就是它;那张表还没建起来的一小段(新建的乐观期、首次加载)读建它时给的那一份。
 */
export class SessionPageStore {
  readonly id: string;
  state: 'unregistered' | 'unprovisioned' | 'provisioned';
  private readonly _initial: Session;
  phase: UnregisteredSessionPhase | UnprovisionedSessionPhase | null;
  failure: SessionFailure | undefined = undefined;
  provisionProgressMessage: string | null = null;
  /** 这条会话所在工作区上的 PR(按分支查)。 */
  prs: PullRequest[] = [];
  /** 工作区的改动行数(库里缓存的那份,没挂载时侧栏也能显示)。 */
  workspaceGit: { linesAdded: number; linesDeleted: number } | undefined = undefined;

  /** The workspace ID while mounted — null when unprovisioned. */
  workspaceId: string | null = null;
  /**
   * Stable view model — created when the session first becomes registered, persists
   * across provision/unprovision cycles. Null only while unregistered.
   */
  viewModel: WorkspaceViewModel | null = null;

  get data(): Session {
    return sessionRegistry.get(this.id)?.sessions.get(this.id)?.data ?? this._initial;
  }

  get displayName(): string {
    return this.data.title;
  }

  /** True only while creation/provisioning is actively running — error phases are settled, not busy. */
  get isBootstrapping(): boolean {
    return (
      (this.state === 'unregistered' && this.phase === 'creating') ||
      (this.state === 'unprovisioned' && this.phase === 'provision')
    );
  }

  constructor(
    data: Session,
    state: SessionPageStore['state'],
    phase: UnregisteredSessionPhase | UnprovisionedSessionPhase | null = null
  ) {
    this.id = data.id;
    this.state = state;
    this._initial = data;
    this.phase = phase;
    makeAutoObservable<SessionPageStore, '_initial'>(this, {
      workspaceId: observable,
      viewModel: observable.ref,
      _initial: observable.ref,
      prs: observable.ref,
    });

    // Create stable session-lifetime stores immediately for registered sessions.
    if (state !== 'unregistered') {
      this.ensureRegisteredStores();
    }
  }

  ensureRegisteredStores(): void {
    if (this.state === 'unregistered') return;
    if (!this.viewModel) {
      this.viewModel = new WorkspaceViewModel(this);
    }
  }

  transitionToProvisioned(
    path: string,
    workspaceId: string,
    gitRepository: GitRepositoryStore,
    savedSnapshot?: SessionViewSnapshot
  ): void {
    this.ensureRegisteredStores();
    workspaceRegistry.acquire(this.data.projectId, workspaceId, path, gitRepository);
    this.workspaceId = workspaceId;
    this.state = 'provisioned';
    this.phase = null;
    this.failure = undefined;
    this.provisionProgressMessage = null;
    // #6799 页签布局住在自己的键 session:<id>:tabs 里;聚合键 session:<id> 在新会话上常常从没写过(它的字段一次都
    // 没变),❌ 拿聚合键的有无决定要不要恢复页签 —— 那样存好的页签 reload / 重开后没人读。
    if (savedSnapshot) this.viewModel?.restoreSnapshot(savedSnapshot);
    else this.viewModel?.restoreTabs();
    this.viewModel?.initialize();
  }

  transitionToUnprovisioned(phase: UnprovisionedSessionPhase = 'idle'): void {
    this.viewModel?.suspend();
    if (this.workspaceId) {
      workspaceRegistry.release(this.data.projectId, this.workspaceId);
      this.workspaceId = null;
    }
    this.state = 'unprovisioned';
    this.phase = phase;
    this.failure = undefined;
    this.provisionProgressMessage = null;

    // Create stable stores on first registration (when transitioning from unregistered).
    if (!this.viewModel) this.ensureRegisteredStores();
  }

  activate(): void {
    if (this.workspaceId) workspaceRegistry.activate(this.data.projectId, this.workspaceId);
  }

  dispose(): void {
    this.viewModel?.dispose();
    this.viewModel = null;
    if (this.workspaceId) {
      workspaceRegistry.release(this.data.projectId, this.workspaceId);
      this.workspaceId = null;
    }
  }

  /** 侧栏的引擎图标:这条会话跑的那一家。 */
  get sessionStats(): Record<string, number> {
    return { [this.data.providerId]: 1 };
  }

  async rename(name: string): Promise<void> {
    await rpc.sessions.renameSession(this.id, name);
  }

  async setPinned(isPinned: boolean): Promise<void> {
    if (this.state === 'unregistered') return;
    const data = this.data;
    const previous = data.isPinned;
    runInAction(() => {
      data.isPinned = isPinned;
    });
    try {
      await rpc.sessions.setSessionPinned(this.id, isPinned);
    } catch (e) {
      runInAction(() => {
        data.isPinned = previous;
      });
      log.error(e);
      throw e;
    }
  }

  /** 自动化运行建出来的会话收成普通会话。 */
  async convertAutomationSession(): Promise<void> {
    if (this.state === 'unregistered') return;
    const data = this.data;
    const previous = data.automationRunId;
    if (!previous) return;
    runInAction(() => {
      data.automationRunId = undefined;
    });
    try {
      await rpc.sessions.convertAutomationSession(this.id);
    } catch (e) {
      runInAction(() => {
        data.automationRunId = previous;
      });
      console.error(e);
      throw e;
    }
  }
}

export type UnregisteredSession = SessionPageStore & {
  state: 'unregistered';
  phase: UnregisteredSessionPhase;
  failure: SessionFailure | undefined;
};

export type UnprovisionedSession = SessionPageStore & {
  state: 'unprovisioned';
  phase: UnprovisionedSessionPhase;
  failure: SessionFailure | undefined;
};

export function isUnregistered(t: SessionPageStore): t is UnregisteredSession {
  return t.state === 'unregistered';
}

export function isRegistered(
  t: SessionPageStore
): t is SessionPageStore & { state: 'unprovisioned' | 'provisioned' } {
  return t.state !== 'unregistered';
}

export function isUnprovisioned(t: SessionPageStore): t is UnprovisionedSession {
  return t.state === 'unprovisioned';
}

export function isProvisioned(
  t: SessionPageStore
): t is SessionPageStore & { state: 'provisioned'; workspaceId: string } {
  return t.state === 'provisioned';
}

/** The session record when registered (unprovisioned or provisioned); `undefined` when unregistered. */
export function registeredSessionData(store: SessionPageStore): Session | undefined {
  return isRegistered(store) ? store.data : undefined;
}

export function createUnregisteredSession(data: Session): SessionPageStore {
  return new SessionPageStore(data, 'unregistered', 'creating');
}

export function createUnprovisionedSession(data: Session): SessionPageStore {
  return new SessionPageStore(data, 'unprovisioned', 'idle');
}
