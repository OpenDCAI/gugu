import type { IDisposable, IInitializable } from '@gugu/session-shared';
import { eq, inArray } from 'drizzle-orm';
import {
  parseAgentStatus,
  parseAgentStatusDetail,
  type AgentStatus,
  type AgentStatusReading,
} from '@gugu/core/shared/agentStatus';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { isAppFocused } from '@main/core/agent-hooks/app-focus';
import { maybeShowNotification } from '@main/core/agent-hooks/notification';
import { isSessionAutoApproved } from '@main/core/agent-hooks/turn-autonomy';
import { getPlugin } from '@main/core/agents/plugin-registry';
import {
  PROVIDER_BLOCKER_STATUS,
  PROVIDER_REVIEW_GATE_STATUS,
} from '@main/core/sessions/provider-review-gate';
import { sessionsAliveInTmux } from '@main/core/sessions/session-process';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { clearInterruptedTurn, recordInterruptedTurns } from './interrupted-turns';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { AgentEvent } from '@shared/core/agents/agentEvents';
import {
  sessionAgentStatusChangedChannel,
  sessionChangedChannel,
  sessionInScope,
  type AgentStatusChange,
  type SessionScope,
  type ProviderBlocker,
  type ProviderReviewGate,
} from '@shared/core/sessions/sessionEvents';
import type { InterruptedBy, Session } from '@shared/core/sessions/sessions';
import { hasStatusSource } from '@shared/core/sessions/initial-agent-status';
import {
  emptyStatusLogState,
  readStatusLog,
  restoreStatusLog,
  stepStatusLog,
  waitsOnHarness,
  type AgentStatusEvent,
  type AgentStatusLogState,
} from './status-event-log';
import { translateAgentEvent, type TranslationContext } from './status-event-translator';

/**
 * spec agent-status-writer —— 会话页 agent 状态的唯一写入者。
 *
 * 每条会话持有一份事件日志(spec status-event-log),读数变了才落库、才发布。`sessions.agent_status /
 * agent_status_detail / agent_status_seen` 只有这里写;发布出去的 `AgentStatusChange` 是进程内读者、会话页渲染层、
 * 宿主按 agent 的流唯一的来源。出生、开机收残、打断、退出、provider 门、已读都是这里的一次写入。
 */
export type AgentStatusWriterHooks = {
  'agent:status': (change: AgentStatusChange & { reading: AgentStatusReading; sourceId?: string; activityAt?: number }) =>
    | void
    | Promise<void>;
};

/** 写口的参数:写哪条会话。`projectId` 缺省时从会话行取。 */
export type StatusWriteParams = { sessionId: string; projectId?: string };

/** 一条会话的日志,以及最后一次写下的那句话。 */
interface SessionStatusLog {
  projectId: string;
  state: AgentStatusLogState;
  written: { status: AgentStatus; detail: AgentStatusReading['detail']; unseen: boolean } | null;
}

type PublishMeta = { event?: AgentEvent; appFocused: boolean; timestamp: number; announceWait: boolean };

/** 一条会话出生时写下的那一行(建行的列值来自出生规则 `birthStatusColumns`)。 */
export type SessionBirth = Pick<Session, 'id' | 'projectId' | 'agentStatus' | 'agentStatusDetail'>;

class AgentStatusWriter implements IInitializable, IDisposable, Hookable<AgentStatusWriterHooks> {
  private readonly logs = new Map<string, SessionStatusLog>();
  private readonly providerReviewGates = new Map<string, ProviderReviewGate>();
  private readonly providerBlockers = new Map<string, ProviderBlocker>();
  /** 声明了的状态来源读不出(会话在场文件没出现 / 格式变了):一句原因。 */
  private readonly statusSourceFaults = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly disposers: Array<() => void> = [];
  private readonly _hooks = new HookCore<AgentStatusWriterHooks>((name, e) =>
    log.error(`AgentStatusWriter: ${String(name)} hook error`, e)
  );

  on<K extends keyof AgentStatusWriterHooks>(name: K, handler: AgentStatusWriterHooks[K]) {
    return this._hooks.on(name, handler);
  }

  /**
   * 同一会话的写入按到达顺序一条一条做完:每条都先 await 库再发布;两条挨得很近的写入(回合起 → 马上被取消)
   * 并发跑时,后到的可能先发布完,读者最终停在前一条上。
   */
  private inOrder(sessionId: string, write: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(sessionId) ?? Promise.resolve()).then(write);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(sessionId, settled);
    void settled.then(() => {
      if (this.writes.get(sessionId) === settled) this.writes.delete(sessionId);
    });
    return next;
  }

  getProviderReviewGate(sessionId: string): ProviderReviewGate | null {
    return this.providerReviewGates.get(sessionId) ?? null;
  }

  getProviderBlocker(sessionId: string): ProviderBlocker | null {
    return this.providerBlockers.get(sessionId) ?? null;
  }

  getStatusSourceFault(sessionId: string): string | null {
    return this.statusSourceFaults.get(sessionId) ?? null;
  }

  /**
   * 这条会话此刻在跑或在等(在这个进程里有日志的才算):harness 的打断边只可能这时出现,会话在场文件的读者据此决定读不读。
   */
  isWorkingOrWaiting(sessionId: string): boolean {
    const entry = this.logs.get(sessionId);
    if (!entry) return false;
    const { status } = readStatusLog(entry.state);
    return status === 'working' || status === 'needs_user';
  }

  /**
   * 进程里还没有这条会话的日志(上一个进程留下的会话):由会话行恢复。开机收残之后行里只剩静止的读数,
   * 所以恢复出来的日志就是这条会话此刻的真实状态。`null` = 会话行已经不在。
   */
  private async logFor(sessionId: string): Promise<SessionStatusLog | null> {
    const existing = this.logs.get(sessionId);
    if (existing) return existing;
    const [row] = await db
      .select({
        projectId: sessions.projectId,
        agentStatus: sessions.agentStatus,
        agentStatusDetail: sessions.agentStatusDetail,
        agentStatusSeen: sessions.agentStatusSeen,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    // 两个并发的首次触及都会 await 到这里:以先落下的那份为准。
    const raced = this.logs.get(sessionId);
    if (raced) return raced;
    const status = parseAgentStatus(row.agentStatus);
    const detail = parseAgentStatusDetail(row.agentStatusDetail, status);
    const entry: SessionStatusLog = {
      projectId: row.projectId,
      state: restoreStatusLog(status, detail),
      written: status ? { status, detail, unseen: row.agentStatusSeen !== 1 } : null,
    };
    this.logs.set(sessionId, entry);
    return entry;
  }

  /** 把这次的规范事件折进日志,读数变了才发布。`translate` 返回空 = 这条信号不携带状态。 */
  private async apply(
    sessionId: string,
    translate: (ctx: TranslationContext) => AgentStatusEvent[],
    meta: PublishMeta,
  ): Promise<void> {
    const entry = await this.logFor(sessionId);
    if (!entry) return;
    const { state } = entry;
    const before = readStatusLog(state);
    const canonical = translate({
      running: state.running,
      waiting: waitsOnHarness(state),
      failed: state.error !== null,
      autoApproved: isSessionAutoApproved(sessionId),
    });
    const anomalies: string[] = [];
    for (const e of canonical) stepStatusLog(state, e, (what) => anomalies.push(what));
    if (anomalies.length > 0) {
      log.warn('AgentStatusWriter: status event does not belong to this session; ignored', {
        sessionId,
        eventType: meta.event?.type,
        anomalies,
      });
    }
    if (canonical.length === 0) return;
    const reading = readStatusLog(state);
    const previous = entry.written;
    // 不是新事实的不发布:从没有状态的行(没有状态源)被「停下」;这一批事件没让读数动(同一句话再说一遍、
    // 对静止的会话打断)。比的是这批事件前后的读数,❌ 比库里那一句:#6448 之前写下的行没有附属态,
    // 拿它比会把一条什么都没改的事件当成新话写下去(还顺手把「做完未读」清成已读)。做完那条边总是新事实。
    const unchanged = previous === null
      ? reading.status === 'idle'
      : before.status === reading.status && before.detail === reading.detail;
    if (unchanged && !reading.finished) return;
    // 做完、等人、出错写成未读;在跑、没做完的空闲(被打断)不是一句需要你看的话。
    const unseen = !(reading.status === 'working' || (reading.status === 'idle' && !reading.finished));
    const finished = reading.finished && reading.status === 'idle';
    const waitAsked = meta.announceWait && reading.status === 'needs_user' && previous?.status !== 'needs_user';
    await this.publish(sessionId, entry, reading, unseen, meta, {
      persist: true,
      active: true,
      soundEvent: finished ? 'task_complete' : waitAsked ? 'needs_attention' : undefined,
    });
    // 系统横幅只给 CLI hook 送来的事件(sourceId 只在那条路上有)。
    const answering = reading.detail === 'question' || reading.detail === 'plan';
    const notice = finished ? 'finished' : waitAsked ? (answering ? 'needsAnswer' : 'needsApproval') : null;
    if (notice && meta.event?.sourceId) void maybeShowNotification(meta.event, notice);
  }

  /**
   * 发布一次读数:落库 → 会话页渲染层(带提示音)→ 'agent:status',按这个顺序。`active`:这一笔是会话的一次活动(开工 / 停下、
   * 等人、出错、被打断、重开),`lastInteractedAt` 落在同一笔里 —— 每次开工停下都经过这里;「已读」不是活动。
   */
  private async publish(
    sessionId: string,
    entry: SessionStatusLog,
    reading: AgentStatusReading,
    unseen: boolean,
    meta: PublishMeta,
    options: { persist: boolean; active?: true; soundEvent?: 'needs_attention' | 'task_complete' },
  ): Promise<void> {
    entry.written = { status: reading.status, detail: reading.detail, unseen };
    const lastInteractedAt = options.active ? new Date(meta.timestamp).toISOString() : undefined;
    if (options.persist) {
      await db
        .update(sessions)
        .set({
          agentStatus: reading.status,
          agentStatusDetail: reading.detail,
          agentStatusSeen: unseen ? 0 : 1,
          ...(lastInteractedAt ? { lastInteractedAt } : {}),
        })
        .where(eq(sessions.id, sessionId));
      // 开工了:开机收残记下的「上一轮被打断」不再是现在的事。
      if (reading.status === 'working') clearInterruptedTurn(sessionId);
      if (lastInteractedAt) {
        events.emit(sessionChangedChannel, { sessionId, projectId: entry.projectId, changes: { lastInteractedAt } });
      }
    }
    const change: AgentStatusChange & { reading: AgentStatusReading } = {
      sessionId,
      projectId: entry.projectId,
      reading: { status: reading.status, detail: reading.detail, running: reading.running, background: reading.background },
      unseen,
      reviewGate: this.getProviderReviewGate(sessionId),
      providerBlocker: this.getProviderBlocker(sessionId),
      statusSourceFault: this.getStatusSourceFault(sessionId),
    };
    events.emit(sessionAgentStatusChangedChannel, {
      ...change,
      appFocused: meta.appFocused,
      ...(options.soundEvent ? { soundEvent: options.soundEvent } : {}),
    });
    this._hooks.callHookBackground('agent:status', { ...change, sourceId: meta.event?.sourceId,
      ...(options.active ? { activityAt: meta.timestamp } : {}) });
  }

  private now(): PublishMeta {
    return { appFocused: isAppFocused(), timestamp: Date.now(), announceWait: false };
  }

  /**
   * 会话出生是一次写入:建行的列值来自出生规则、与会话行同一笔事务落库;这里从同一份读数开日志并发布,
   * 所以进程内的读者从出生那一刻就知道它在不在跑。在会话能开口(spawn)之前调用,之后的 hook 都排在它后面。
   * 没有状态源(`agentStatus` 为 null)的会话不陈述任何一态,不发布。
   */
  birth(session: SessionBirth): Promise<void> {
    const status = session.agentStatus ?? null;
    if (status === null) return Promise.resolve();
    return this.inOrder(session.id, async () => {
      const detail = session.agentStatusDetail ?? null;
      const entry: SessionStatusLog = {
        projectId: session.projectId,
        state: restoreStatusLog(status, detail),
        written: null,
      };
      this.logs.set(session.id, entry);
      await this.publish(session.id, entry, readStatusLog(entry.state), false, this.now(), { persist: false });
    });
  }

  /**
   * 重开 = 这一句重新跑:日志重新开始,写库、发布。会话行的其它列由调用方改,状态列只有这里写。
   */
  restart(params: StatusWriteParams): Promise<void> {
    return this.inOrder(params.sessionId, async () => {
      const previous = await this.logFor(params.sessionId);
      if (!previous) return;
      const entry: SessionStatusLog = {
        projectId: previous.projectId,
        state: emptyStatusLogState(),
        written: previous.written,
      };
      entry.state.running = true;
      this.logs.set(params.sessionId, entry);
      await this.publish(params.sessionId, entry, readStatusLog(entry.state), false, this.now(), { persist: true, active: true });
    });
  }

  /**
   * 开机收残:上一个进程的会话,引擎随它一起没了的(ACP、不在 tmux 里的终端腿),留下的「在跑 / 等人」是历史不是现在时。
   * 那一轮没做完、也没人知道 ⇒ 记成 `error`、未读(要人处理;下一轮开工自己清掉),原因(`lastExit`:宿主更新 / 重启 /
   * 上一次没正常退出)记在 interrupted-turns,会话页末尾据此说一句(10-28 Linux 2:换版打断 7 条车道,侧栏却是一片安静的空闲)。
   * **引擎在 tmux 里活下来的不收**:它那一轮还在跑,读数照旧(它的钩子会接着打回来)。❌ 一律收成空闲:
   * 那样账号进程一重启,所有在 tmux 里跑着的会话都读成空闲(10-08:守护进程据此判「没有 agent 在跑」连升两级)。
   * `tmuxSessionNames` 是开机时问一次 tmux 的结果,活没活与接回同一个判据(`sessionsAliveInTmux`)。
   * 在任何会话能说话之前跑完;这之后由行恢复的日志只会遇到静止的读数。
   */
  async settleAfterRestart(tmuxSessionNames: ReadonlySet<string>, lastExit: InterruptedBy = 'unclean'): Promise<void> {
    const inFlight = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.agentStatus, ['working', 'needs_user']));
    const alive = sessionsAliveInTmux(tmuxSessionNames);
    const gone = inFlight.filter((row) => !alive.has(row.id)).map((row) => row.id);
    if (gone.length === 0) return;
    await db
      .update(sessions)
      .set({ agentStatus: 'error', agentStatusDetail: null, agentStatusSeen: 0 })
      .where(inArray(sessions.id, gone));
    recordInterruptedTurns(gone, lastExit);
  }

  /** 宿主停下了在飞的一切(停止键、ACP 取消 / 关闭):被打断,不是做完也不是失败。 */
  interrupt(params: StatusWriteParams): Promise<void> {
    return this.inOrder(params.sessionId, () =>
      this.apply(params.sessionId, () => [{ kind: 'Interrupted', sessionId: params.sessionId }], this.now())
    );
  }

  /**
   * 这条会话的**传输没了**(进程意外退出、产品自己发起的 stop):它不会再打回任何一条 hook 边沿。
   * 返回 Promise:`session_stop` 紧接着就要把这一行读回去当回执,中间不能有「已经停了但还没落库」的窗口。
   */
  async settleSessionExited(params: StatusWriteParams): Promise<void> {
    this.providerReviewGates.delete(params.sessionId);
    this.providerBlockers.delete(params.sessionId);
    await this.interrupt(params);
  }

  /** 打开会话 = 这一句已读。照常发布:手机列表、宿主按 agent 的流跟着更新。 */
  markSeen(sessionId: string): Promise<void> {
    return this.inOrder(sessionId, async () => {
      const entry = await this.logFor(sessionId);
      if (!entry) return;
      if (!entry.written) {
        // 没有状态源的会话也有「已读」这一格(侧栏加粗读它),但没有读数可发布。
        await db.update(sessions).set({ agentStatusSeen: 1 }).where(eq(sessions.id, sessionId));
        return;
      }
      if (!entry.written.unseen) return;
      await this.publish(sessionId, entry, readStatusLog(entry.state), false, this.now(), { persist: true });
    });
  }

  /**
   * provider 门 / 阻塞也是一次写入:「人点一下就继续」的门 = 会话级等待(对话框);要人去修的阻塞 = 失败。
   */
  private writeProviderStatus(
    params: StatusWriteParams,
    status: 'needs_user' | 'error',
    id: string,
    reason: string,
  ): Promise<void> {
    const event: AgentStatusEvent = status === 'needs_user'
      ? { kind: 'WaitStarted', sessionId: params.sessionId, id, waitKind: 'dialog', scope: 'session' }
      : { kind: 'Error', sessionId: params.sessionId, reason };
    return this.inOrder(params.sessionId, () => this.apply(params.sessionId, () => [event], this.now())).catch(
      (error) =>
        log.error('AgentStatusWriter: failed to write provider status', {
          sessionId: params.sessionId,
          status,
          error: String(error),
        }),
    );
  }

  /**
   * D-31 The host waits on the person in this session — an approval it asked for the agent (an App install) or the agent's
   * own question (`session_ask_user`), both on the session's timeline: a host wait while it is asked, ended only when
   * answered or withdrawn (the agent starting work again does not answer it). The same edge for a chat-UI session and a
   * terminal one: its yellow dot, the phone's 「等你批准」 / 「等你回答」.
   */
  reportHostWait(params: StatusWriteParams & { id: string; open: boolean; waitKind?: 'approval' | 'question' | 'dialog' }): void {
    const event: AgentStatusEvent = params.open
      ? { kind: 'WaitStarted', sessionId: params.sessionId, id: params.id, waitKind: params.waitKind ?? 'approval', scope: 'host' }
      : { kind: 'WaitEnded', sessionId: params.sessionId, id: params.id };
    void this.inOrder(params.sessionId, () => this.apply(params.sessionId, () => [event], this.now())).catch((error) =>
      log.error('AgentStatusWriter: failed to write the host wait', { sessionId: params.sessionId, error: String(error) }),
    );
  }

  reportProviderReviewGate(params: StatusWriteParams & { gate: ProviderReviewGate }): void {
    if (this.providerReviewGates.get(params.sessionId) === params.gate) return;
    this.providerReviewGates.set(params.sessionId, params.gate);
    void this.writeProviderStatus(params, PROVIDER_REVIEW_GATE_STATUS[params.gate], `provider-review-${params.gate}`, params.gate);
  }

  reportProviderBlocker(params: StatusWriteParams & { blocker: ProviderBlocker }): void {
    if (this.providerBlockers.get(params.sessionId)?.message === params.blocker.message) return;
    this.providerBlockers.set(params.sessionId, params.blocker);
    void this.writeProviderStatus(
      params,
      PROVIDER_BLOCKER_STATUS[params.blocker.reason],
      `provider-blocker-${params.blocker.reason}`,
      params.blocker.message,
    );
  }

  /**
   * spec hook-status-derivation「打断边:会话在场文件」—— 声明了的状态来源读不出(`null` = 又读得出了)。
   * 不是一态,❌ 改读数:它随这条会话的状态输出一起发布,界面据此标出「状态来源失效」;改了就把此刻的读数重发一次。
   */
  reportStatusSourceFault(params: StatusWriteParams & { message: string | null }): void {
    if ((this.statusSourceFaults.get(params.sessionId) ?? null) === params.message) return;
    if (params.message === null) this.statusSourceFaults.delete(params.sessionId);
    else this.statusSourceFaults.set(params.sessionId, params.message);
    void this.inOrder(params.sessionId, async () => {
      const entry = await this.logFor(params.sessionId);
      if (!entry?.written) return;
      await this.publish(params.sessionId, entry, readStatusLog(entry.state), entry.written.unseen, this.now(), { persist: false });
    }).catch((error) =>
      log.error('AgentStatusWriter: failed to publish the status source fault', { sessionId: params.sessionId, error: String(error) }),
    );
  }

  /**
   * 每一条会话此刻的状态(宿主按 agent 的流、手机线上开机对账用)。进程里有日志的读日志,否则按会话行恢复 ——
   * 与写入者第一次触及它时会得到的读数是同一个。归档的会话不在里面。
   */
  async snapshot(): Promise<AgentStatusChange[]> {
    const rows = await db
      .select({
        id: sessions.id,
        projectId: sessions.projectId,
        agentStatus: sessions.agentStatus,
        agentStatusDetail: sessions.agentStatusDetail,
        agentStatusSeen: sessions.agentStatusSeen,
        archivedAt: sessions.archivedAt,
      })
      .from(sessions);
    return rows
      .filter((row) => row.archivedAt === null)
      .map((row) => {
        const live = this.logs.get(row.id);
        const status = parseAgentStatus(row.agentStatus);
        const reading = live
          ? live.written
            ? readStatusLog(live.state)
            : null
          : status === null
            ? null
            : readStatusLog(restoreStatusLog(status, parseAgentStatusDetail(row.agentStatusDetail, status)));
        return {
          sessionId: row.id,
          projectId: row.projectId,
          reading: reading
            ? { status: reading.status, detail: reading.detail, running: reading.running, background: reading.background }
            : null,
          unseen: live?.written ? live.written.unseen : row.agentStatusSeen !== 1,
          reviewGate: this.getProviderReviewGate(row.id),
          providerBlocker: this.getProviderBlocker(row.id),
          statusSourceFault: this.getStatusSourceFault(row.id),
        };
      });
  }

  /** 这些会话不在了(删掉、归档、随任务 / 项目一起走):日志与门一并回收。 */
  forget(scope: SessionScope): void {
    for (const [sessionId, entry] of [...this.logs]) {
      if (!sessionInScope({ sessionId, projectId: entry.projectId }, scope)) continue;
      this.logs.delete(sessionId);
      this.providerReviewGates.delete(sessionId);
      this.providerBlockers.delete(sessionId);
      this.statusSourceFaults.delete(sessionId);
    }
  }

  /** 每次现读会话行的 runtime:一条会话可以在编程 / 通用两种展示之间切换,❌ 缓存。 */
  private async statusSource(sessionId: string): Promise<'present' | 'none' | 'deleted'> {
    const [row] = await db
      .select({ runtime: sessions.runtime, provider: sessions.provider })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return 'deleted';
    if (row.runtime === 'acp') return 'present';
    if (!row.provider) throw new Error(`AgentStatusWriter: session ${sessionId} has no provider`);
    return hasStatusSource({ runtime: 'pty', hooksKind: getPlugin(row.provider).capabilities.hooks.kind }) ? 'present' : 'none';
  }

  private async applyEvent(event: AgentEvent, appFocused: boolean): Promise<void> {
    const source = await this.statusSource(event.sessionId);
    // 会话行已经不在是合法的时序(删会话先删行、后停 harness,退出边带着仍然有效的令牌到达):不写、不播,
    // 否则会把 `forget` 刚清掉的日志重新种回去,并对一条已宣告删除的会话陈述状态。
    if (source === 'deleted') return;
    // 没有状态源的会话一条 hook 边沿都不会来,落到这里的只有宿主自己合成的边 —— 不是这一轮在不在跑的证据。
    // 但给它一轮时(终端里按回车)合成的那条 start 是它唯一的活动证据:只记下活动时刻,不写状态。
    if (source === 'none') {
      if (event.type !== 'start') return;
      const lastInteractedAt = new Date(event.timestamp).toISOString();
      await db.update(sessions).set({ lastInteractedAt }).where(eq(sessions.id, event.sessionId));
      const { sessionId, projectId } = event;
      events.emit(sessionChangedChannel, { sessionId, projectId, changes: { lastInteractedAt } });
      return;
    }
    await this.apply(event.sessionId, (ctx) => translateAgentEvent(event, ctx), {
      event,
      appFocused,
      timestamp: event.timestamp,
      announceWait: true,
    });
  }

  initialize(): void {
    this.disposers.push(
      agentHookService.on('agent:event', (event, appFocused) => {
        if (event.type === 'start' && event.payload.origin !== 'subagent') {
          this.providerReviewGates.delete(event.sessionId);
          this.providerBlockers.delete(event.sessionId);
        }
        return this.inOrder(event.sessionId, () => this.applyEvent(event, appFocused));
      }),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.logs.clear();
    this.providerReviewGates.clear();
    this.providerBlockers.clear();
    this.statusSourceFaults.clear();
  }
}

export const agentStatusWriter = new AgentStatusWriter();
