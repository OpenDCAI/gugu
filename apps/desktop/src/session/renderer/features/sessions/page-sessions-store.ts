import type { IDisposable } from '@gugu/session-shared';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
// TODO(conversations-extraction): Inject file-link handlers instead of importing task editor plumbing.
import { makeFileLinkHandlers } from '@renderer/features/sessions/stores/open-file-in-file-editor';
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { PtySession } from '@renderer/lib/pty/pty-session';
import { Resource } from '@renderer/lib/stores/resource';
import { aggregateStatusDetail } from '@renderer/lib/components/agent-status-display';
import type { AgentStatus, AgentStatusDetail, AgentStatusView } from '@gugu/core/shared/agentStatus';
import {
  sessionAgentStatusChangedChannel,
  sessionChangedChannel,
  sessionCreatedChannel,
  sessionDeletedChannel,
} from '@shared/core/sessions/sessionEvents';
import {
  type ArchiveOutcome,
  type Session,
  type SessionRuntime,
} from '@shared/core/sessions/sessions';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { sessionDescendantIds } from './session-descendants';

export class PageSessionsStore implements IDisposable {
  private offAgentStatusChanged: (() => void) | null = null;
  private offSessionCreated: (() => void) | null = null;
  private offSessionDeleted: (() => void) | null = null;
  private offSessionChanges: (() => void) | null = null;
  private readonly _disposeReaction: () => void;

  /** Data layer: plain Conversation records loaded from the main process. */
  readonly list: Resource<Session[]>;
  /** Runtime state stores keyed by conversation id — populated by reaction on list.data. */
  sessions = observable.map<string, SessionStore>();
  /** Session layer keyed by conversation id — created alongside data, connected lazily. */
  ptySessions = observable.map<string, PtySession>();

  constructor(
    readonly projectId: string,
    /** 这张表属于哪条会话(按会话 id 记,表里就是它自己那一行)。 */
    readonly id: string,
    preloaded?: Session[]
  ) {
    makeObservable(this, {
      sessions: observable,
      ptySessions: observable,
      sessionStatus: computed,
      sessionStatusDetail: computed,
    });

    const hasPreloaded = preloaded !== undefined;
    this.list = new Resource<Session[]>(
      hasPreloaded ? null : () => rpc.sessions.getUnarchivedSession(projectId, id),
      hasPreloaded ? [] : [{ kind: 'demand' }],
      hasPreloaded ? { init: preloaded } : undefined
    );

    // When preloaded data is available, populate the maps synchronously so
    // they are accessible immediately — even when this constructor is called
    // from within a MobX action, where reaction callbacks (including
    // fireImmediately) are deferred until the outermost action completes.
    if (preloaded) {
      runInAction(() => {
        for (const session of preloaded) {
          if (!this.sessions.has(session.id)) {
            this.sessions.set(session.id, new SessionStore(session));
          }
          if (!this.ptySessions.has(session.id)) {
            this.ptySessions.set(session.id, this.createSession(session));
          }
        }
      });
    }

    // Sync conversations and sessions maps whenever resource data changes.
    // fireImmediately handles the non-preloaded case; for preloaded data the
    // maps are already populated above so this is a no-op on first run.
    this._disposeReaction = reaction(
      () => this.list.data,
      (data) => {
        if (!data) return;
        runInAction(() => {
          for (const session of data) {
            if (!this.sessions.has(session.id)) {
              this.sessions.set(session.id, new SessionStore(session));
            }
            if (!this.ptySessions.has(session.id)) {
              this.ptySessions.set(session.id, this.createSession(session));
            }
          }
        });
      },
      { fireImmediately: true }
    );

    this.offAgentStatusChanged = this.listenToAgentStatusChanged();
    this.offSessionCreated = this.listenToSessionCreated();
    this.offSessionDeleted = this.listenToSessionDeleted();
    this.offSessionChanges = this.listenToSessionChanges();
  }

  /**
   * #6264 别的机器断开又连上:按那台机器此刻的清单补齐(断开那段时间的推送收不到)。
   * 新的加进来、已有的字段对齐、清单里没有了的拿掉。
   */
  reconcile(sessions: readonly Session[]): void {
    runInAction(() => {
      const keep = new Set(sessions.map((session) => session.id));
      for (const session of sessions) {
        const store = this.sessions.get(session.id);
        if (store) Object.assign(store.data, session);
        else this.addSession(session);
      }
      for (const id of [...this.sessions.keys()]) {
        if (keep.has(id)) continue;
        this.sessions.delete(id);
        this.ptySessions.get(id)?.destroy();
        this.ptySessions.delete(id);
      }
    });
  }

  private addSession(session: Session): void {
    if (!this.sessions.has(session.id)) {
      this.sessions.set(session.id, new SessionStore(session));
    }
    if (!this.ptySessions.has(session.id)) {
      this.ptySessions.set(session.id, this.createSession(session));
    }
  }

  /** 这条会话的事件在它所在的那台机器上订(本机 = null)。 */
  private onEvent<T>(event: { name: string; _data?: T }, cb: (data: T) => void): () => void {
    return onMachineEvent(machineRegistry.machineOf(this.projectId), event, cb);
  }

  private listenToAgentStatusChanged(): () => void {
    return this.onEvent(sessionAgentStatusChangedChannel, (payload) => {
      if (payload.sessionId !== this.id) return;
      const sessionStore = this.sessions.get(payload.sessionId);
      if (!sessionStore) return;

      sessionStore.applyStatus(payload);

    });
  }


  private listenToSessionCreated(): () => void {
    return this.onEvent(sessionCreatedChannel, ({ session }) => {
      if (session.id !== this.id || session.projectId !== this.projectId) return;
      runInAction(() => {
        this.addSession(session);
      });
    });
  }

  private listenToSessionDeleted(): () => void {
    return this.onEvent(sessionDeletedChannel, ({ sessionId, projectId }) => {
      if (sessionId !== this.id || projectId !== this.projectId) return;
      runInAction(() => {
        this.sessions.delete(sessionId);
        this.ptySessions.get(sessionId)?.destroy();
        this.ptySessions.delete(sessionId);
      });
    });
  }

  private listenToSessionChanges(): () => void {
    return this.onEvent(sessionChangedChannel, (event) => {
      if (event.sessionId !== this.id) return;
      const store = this.sessions.get(event.sessionId);
      if (!store) return;
      runInAction(() => {
        // `sessionId: null` 是**清空**的线上形状(见 sessionEvents 那侧的抬头:`undefined`
        // 过不了 JSON 传输)。会话模型这一格用缺席表示「没有」,所以在这一处翻译回去 ——
        // ❌ 别把 `null` 直接抄进 store:下游到处在用 `=== undefined` 判首启。
        const { providerSessionId, model, effort, contextUsage, providerSessionState, ...rest } = event.changes;
        Object.assign(store.data, rest);
        if ('providerSessionId' in event.changes) store.data.providerSessionId = providerSessionId ?? undefined;
        // 模型与档位同一个形状:`null` = 删了键,会话模型里是缺席。
        if ('model' in event.changes) store.data.model = model ?? undefined;
        if ('effort' in event.changes) store.data.effort = effort ?? undefined;
        if ('contextUsage' in event.changes) store.data.contextUsage = contextUsage ?? undefined;
        // 引擎那边的状态同一个形状:`null` = 去掉了(#7223)。
        if ('providerSessionState' in event.changes) store.data.providerSessionState = providerSessionState ?? undefined;
        // spec session-graph:归档 = 这一行离开会话列表 ⇒ 事件到达就收起它,形状与删除那一条一致。
        // 本机那次归档已经乐观移过行了,所以这里接的是**别处**发生的归档:另一个窗口点的,或主进程
        // 递归到子树时连带的。❌ 只把字段抄进 data 然后等下一次 reload ——
        // 那期间这一行还在列表里点得到,而它的 runtime 已经停了。
        if (event.changes.archivedAt) {
          this.sessions.delete(event.sessionId);
          this.ptySessions.get(event.sessionId)?.destroy();
          this.ptySessions.delete(event.sessionId);
        }
      });
    });
  }

  get sessionStatus(): AgentStatus | null {
    let hasWorking = false;
    let hasApproval = false;
    let hasError = false;
    for (const session of this.sessions.values()) {
      if (!session.seen && session.status === 'needs_user') hasApproval = true;
      if (session.status === 'working') hasWorking = true;
      if (!session.seen && session.status === 'error') hasError = true;
    }
    if (hasApproval) return 'needs_user';
    if (hasWorking) return 'working';
    if (hasError) return 'error';
    return null;
  }

  /** `sessionStatus` 那一格的附属态:从汇进 `sessionStatus` 的那几条会话里取(全部只剩后台才静止;需要你写出在等什么)。 */
  get sessionStatusDetail(): AgentStatusDetail | null {
    const members = [...this.sessions.values()].filter(
      (session) =>
        session.status === 'working' || (!session.seen && session.status === 'needs_user')
    );
    return aggregateStatusDetail(this.sessionStatus, members);
  }

  /**
   * spec session-fork-share:分叉 = 同一个 provider 的一条新 pty 会话,以自己的会话 id
   * resume 源会话的上下文。零输入 —— 标题、模型、权限档都由主进程照抄源会话行,
   * 渲染端只交出「分叉哪条」。
   *
   * #6269 分叉是一条独立会话,❌ 不往这张表里塞:它由 session:created 自己接上,调用方按返回的
   * 会话 id 去打开。
   */
  async forkSession(sourceSessionId: string): Promise<Session> {
    return rpc.sessions.forkSession({ projectId: this.projectId, sourceSessionId });
  }

  /**
   * spec session-resume:引擎侧什么都没有的会话,照咕咕记着的那句首轮重来。
   * ❌ 不是新建一条顶上 —— 会话 id、标题、在任务里的位置原样保留。
   */
  async restartSession(sessionId: string): Promise<void> {
    await rpc.sessions.restartSession(this.projectId, sessionId);
  }

  /**
   * spec session-runtime-switch:把这条会话换成另一种展示重开(编程 ⇄ 通用)。
   *
   * 主进程停掉当前那条腿并改记录;**起新那条腿的是页签**(调用方切完页签种类,那条腿平常的
   * 打开路径自己就跑起来了)。这里只负责一件渲染端才知道的事:pty 那条腿的本地会话 store 要
   * 当场扔掉 —— 它盯着一个已经被摘掉的伪终端,留着就是一个永远不再有输出的终端面。
   */
  async switchSessionRuntime(sessionId: string, runtime: SessionRuntime): Promise<void> {
    const store = this.sessions.get(sessionId);
    if (!store) return;
    if ((store.data.runtime ?? 'pty') !== 'acp') {
      this.ptySessions.get(sessionId)?.dispose();
    }
    await rpc.sessions.switchSessionRuntime(this.projectId, sessionId, runtime);
    // 主进程那条 `session:changed` 也会写这一格;这里先写是为了让调用方拿到控制权时
    // 页签种类已经算得出新的那一种(❌ 不赌事件先于下一行代码到达)。
    runInAction(() => {
      store.data.runtime = runtime;
    });
  }

  async hydrateSession(sessionId: string): Promise<void> {
    await rpc.sessions.hydrateSession(this.projectId, sessionId);
    // 与 dehydrate 里的 dispose 成对:宿主那边的终端起来了,这边就接上。❌ 只靠 PtySession 的「第一次被读到才连」——
    // 别的视图一直读着 status 时,dispose 之后再也没有「第一次」,重开的页签永远停在「正在启动会话」(10-18 实撞)。
    void this.ptySessions.get(sessionId)?.connect();
  }

  async dehydrateSession(sessionId: string): Promise<void> {
    const session = this.ptySessions.get(sessionId);
    session?.dispose();
    await rpc.sessions.dehydrateSession(this.projectId, sessionId);
  }

  /**
   * spec session-graph:归档**这一条**会话(勾了范围就连它 spawn 出的子树)。乐观地把行从列表里收起,
   * 失败就放回去 —— ❌ 让一次失败的归档看起来像成功(行没了、库里还在)。
   *
   * 入口上写的是「归档任务」(用户心智里一个 tab 就是一项任务),动的是这条会话。
   */
  async archiveSession(
    sessionId: string,
    scope: { withChildren?: boolean } = {}
  ): Promise<ArchiveOutcome> {
    const store = this.sessions.get(sessionId);
    if (!store) return { archived: [], unreached: [] };

    const removed = new Map<string, NonNullable<typeof store>>();
    const removedSessions = new Map<string, NonNullable<ReturnType<typeof this.ptySessions.get>>>();
    const ids = scope.withChildren
      ? [sessionId, ...sessionDescendantIds(this.sessions, sessionId)]
      : [sessionId];

    runInAction(() => {
      for (const id of ids) {
        const row = this.sessions.get(id);
        if (!row) continue;
        removed.set(id, row);
        const session = this.ptySessions.get(id);
        if (session) removedSessions.set(id, session);
        this.sessions.delete(id);
        this.ptySessions.delete(id);
      }
    });

    try {
      // 主进程报回这一次真正收走的行(含别的机器上的子会话):归档提示的「撤销」按它放回。
      const outcome = await rpc.sessions.archiveSession(this.projectId, sessionId, scope);
      for (const session of removedSessions.values()) session.destroy();
      return outcome;
    } catch (err) {
      runInAction(() => {
        for (const [id, row] of removed) this.sessions.set(id, row);
        for (const [id, session] of removedSessions) this.ptySessions.set(id, session);
      });
      throw err;
    }
  }

  // spec session-page: any conversation can be pinned/unpinned; optimistic like rename.
  async setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
    const store = this.sessions.get(sessionId);
    if (!store) return;

    const previous = store.data.isPinned ?? false;

    runInAction(() => {
      store.data.isPinned = pinned;
    });

    try {
      await rpc.sessions.setSessionPinned(sessionId, pinned);
    } catch (err) {
      runInAction(() => {
        store.data.isPinned = previous;
      });
      throw err;
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const store = this.sessions.get(sessionId);
    if (!store) return;

    const previousTitle = store.data.title;

    runInAction(() => {
      store.data.title = name;
    });

    try {
      await rpc.sessions.renameSession(sessionId, name);
    } catch (err) {
      runInAction(() => {
        store.data.title = previousTitle;
      });
      throw err;
    }
  }

  dispose(): void {
    this._disposeReaction();
    this.offAgentStatusChanged?.();
    this.offAgentStatusChanged = null;
    this.offSessionCreated?.();
    this.offSessionCreated = null;
    this.offSessionDeleted?.();
    this.offSessionDeleted = null;
    this.offSessionChanges?.();
    this.offSessionChanges = null;
    for (const session of this.ptySessions.values()) {
      session.destroy();
    }
  }

  private createSession(session: Session): PtySession {
    // 这是会话自己的对话终端(编程模式):里面点开的文件开在对话右边(spec session-page「并排」)。
    const handlers = makeFileLinkHandlers(session.projectId, session.id, { beside: true });
    return new PtySession(
      makePtySessionId(session.projectId, session.id, session.id),
      undefined,
      handlers.onOpenFile,
      handlers.onOpenExternal,
      { clearOnBackendStart: true }
    );
  }
}

export class SessionStore {
  data: Session;
  /**
   * `null` = 宿主没有陈述任何一态。没有状态源的终端会话(#6206)恒为 `null`,由行上显示「状态不可用」;
   * ❌ 在这里把 `null` 归一成 `idle` —— 那正是「没证据却说空闲」。
   */
  status: AgentStatus | null;
  /** 附属态(spec agent-status-vocabulary,只给显示);`null` = 这一刻没有,画基础态。 */
  detail: AgentStatusDetail | null;
  seen: boolean;
  /** 声明了的状态来源读不出时写入者给的那句原因(随状态输出到达);`null` = 正常。 */
  statusSourceFault: string | null = null;

  constructor(session: Session) {
    this.data = session;
    this.status = session.agentStatus ?? null;
    this.detail = session.agentStatusDetail ?? null;
    this.seen = session.agentStatusSeen ?? true;
    makeObservable(this, {
      data: observable,
      status: observable,
      detail: observable,
      seen: observable,
      statusSourceFault: observable,
      applyStatus: action,
      markSeen: action,
      indicatorStatus: computed,
      groupStatus: computed,
    });
  }

  // @@@sessionpage otty-state — RAW (not seen-gated) projection used to bucket THIS conversation into a
  // sidebar status group (owner: grouping moved from task-aggregate to conversation level — each session
  // sits in its own true group). Grouping must NOT use the seen-gated indicatorStatus: opening a "Needs
  // you" conversation marks it seen and would make it jump to Idle mid-click, reflowing the list. A
  // conversation stays in its group until the agent's ACTUAL state changes.
  get groupStatus(): AgentStatus | null {
    if (this.status === 'needs_user') return 'needs_user';
    if (this.status === 'working') return 'working';
    if (this.status === 'error') return 'error';
    return null;
  }

  get indicatorStatus(): AgentStatus | null {
    if (this.status === 'working') return 'working';
    if (this.seen) return null;
    if (this.status === 'needs_user') return 'needs_user';
    if (this.status === 'error') return 'error';
    return null;
  }

  /**
   * 宿主写下的一句状态(spec agent-status-writer)。会话页渲染层只照它画,❌ 自己改状态:本地改的那一句
   * 宿主、聊天页、手机都不知道,同一个 agent 就有了两个答案。
   */
  applyStatus(change: { reading: AgentStatusView | null; unseen: boolean; statusSourceFault: string | null }) {
    this.status = change.reading?.status ?? null;
    this.detail = change.reading?.detail ?? null;
    this.seen = !change.unseen;
    this.statusSourceFault = change.statusSourceFault;
  }

  markSeen() {
    this.seen = true;
    void rpc.sessions.markSessionSeen(this.data.id);
  }

  dispose() {
    // Session is managed by PageSessionsStore.sessions — nothing to do here.
  }
}
