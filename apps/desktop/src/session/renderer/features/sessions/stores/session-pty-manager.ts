import { comparer, reaction } from 'mobx';
import { log } from '@renderer/utils/logger';
import type { SessionStore } from '../page-sessions-store';
import { SessionHydrationReconciler } from './session-hydration-reconciler';
import { sessionRegistry } from './session-registry';
import { getSessionPageStore } from './session-selectors';
import { sessionStartupFailures } from './session-startup-failures';
import { events, rpc } from '@renderer/lib/ipc';
import { sessionDeliveryFailedChannel } from '@shared/core/sessions/sessionEvents';
import { askPlatformAgain } from '../platform-retry';

/**
 * Per-task manager that controls conversation PTY-session lifecycle via acquire/release.
 *
 * Thin adapter over SessionHydrationReconciler: converts the ref-counted
 * acquire/release interface (one call per tab open/close) into the set-diff sync()
 * the reconciler uses.
 *
 * Ref-counting supports the same conversation being open in multiple panes
 * (e.g. restored from a snapshot). The session stays hydrated until the last
 * tab closes.
 *
 * The reconciler handles grace timers and retry logic for dehydration.
 */
export class SessionPtyManager {
  private readonly _reconciler: SessionHydrationReconciler;
  private readonly _offDeliveryFailure: () => void;
  private readonly _offRegistryChange: () => void;
  /** Ref counts per conversationId — session stays alive while count > 0. */
  private readonly _refCounts = new Map<string, number>();
  /**
   * 已经挂出去的失败态(账本里的一行)。它的生命周期只有三个出口:
   * hydrate 成功(含重试成功)、该会话最后一个标签页关闭、本 manager 销毁。
   */
  private readonly _surfacedFailures = new Set<string>();

  constructor(private readonly sessionId: string) {
    this._reconciler = new SessionHydrationReconciler({
      sessionId,
      getSessions: () => sessionRegistry.get(sessionId),
      log,
      onHydrateError: (sessionId, error) => {
        // 标签页在 hydrate 飞行途中就关掉了:这次失败没有主人 —— 没有人要它,也没有人能让它收敛
        // (reconciler 已把自己的条目清掉,重试无处可去)。只留 reconciler 的日志,❌ 不挂到界面上。
        if (!this._refCounts.has(sessionId)) return;
        const message = error instanceof Error ? error.message : String(error);
        this._surfacedFailures.add(sessionId);
        // 失败事实进账本(#4602),读者两个:任务页内容区那一格(SessionStartFailedView)与私聊横幅
        // (gugu 那棵树经 window 桥读)。#7103 同一次失败只说一次:❌ 再在角落弹一条 toast —— 任务页上
        // 它与内容区那一格说的是同一件事,对话页上它落在没人看的树里。
        sessionStartupFailures.report({
          sessionId,
          message,
          retry: () => this.retryHydrate(sessionId),
        });
        // #6341 原文只是一句话;「是不是 harness 版本太低」主进程在同一条失败链上判定过,按会话 id 取回来,
        // 读者据此给出升级出口。取不到 = 这层诊断坏了 —— 失败本身照常显示,取的错误进日志(fail loud)。
        // 放进 then:桥不在时 invoke 是同步抛的,❌ 不能让它冒出这个回调。
        void Promise.resolve().then(() => rpc.sessions.getRuntimeUpgradeRequirement(sessionId)).then(
          (requirement) => sessionStartupFailures.setRuntimeUpgrade(sessionId, requirement),
          (lookupError: unknown) => log.error('runtime upgrade lookup failed', { sessionId, error: String(lookupError) }),
        );
      },
      onHydrated: (sessionId) => {
        // 起来了(首次或重试成功):账本收掉。❌ 不能只靠重试前清掉 —— 那会让「重试中」
        // 这一段在界面上读成「没事了」。
        this.withdrawFailure(sessionId);
      },
    });
    this._offRegistryChange = reaction(
      () => [sessionRegistry.get(sessionId), this.isSuspended()],
      () => this._reconciler.sync(this.wanted()),
      { equals: comparer.shallow }
    );
    this._offDeliveryFailure = events.on(sessionDeliveryFailedChannel, (payload) => {
      if (payload.sessionId !== this.sessionId) return;
      this._surfacedFailures.add(payload.sessionId);
      sessionStartupFailures.report({
        sessionId: payload.sessionId,
        message: payload.message,
        retry: () => {
          sessionStartupFailures.markRetrying(payload.sessionId);
          void askPlatformAgain(payload.sessionId)
            .then(() => rpc.sessions.hydrateSession(payload.projectId, payload.sessionId))
            .then(() => this.withdrawFailure(payload.sessionId))
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              sessionStartupFailures.report({
                sessionId: payload.sessionId,
                message,
                retry: () => this.retryHydrate(payload.sessionId),
              });
            });
        },
      });
    });
  }

  /**
   * 重试一条起失败的会话 —— 失败提示上那个按钮、对话页失败条上那个按钮,走的都是这里。
   * 账本条目留着并标成「重试中」(读者据此禁用重试出口),结果由 onHydrated / onHydrateError 决定。
   */
  retryHydrate(sessionId: string): void {
    if (!this._surfacedFailures.has(sessionId)) return;
    if (this._reconciler.getFailure(sessionId) === null) {
      // 账本里有、reconciler 里却没有停在失败态的条目:这行已经没有可重试的对象(会话在别处
      // 起来了 / 条目被清了)。留着只会让人对着一个假失败按重试,收掉。
      this.withdrawFailure(sessionId);
      return;
    }
    sessionStartupFailures.markRetrying(sessionId);
    // 人点的:先让宿主清掉这条会话签咕咕额度的退避,真去问一次(#7103)。
    void askPlatformAgain(sessionId).then(() => this._reconciler.retry(sessionId));
  }

  /**
   * Start the PTY session for this conversation (if not already running).
   * Returns the SessionStore, or undefined if the conversation is not found.
   */
  acquire(sessionId: string): SessionStore | undefined {
    this._refCounts.set(sessionId, (this._refCounts.get(sessionId) ?? 0) + 1);
    this._reconciler.sync(this.wanted());
    return sessionRegistry.get(this.sessionId)?.sessions.get(sessionId);
  }

  /**
   * Signal that this conversation's tab has been closed.
   * The reconciler will dehydrate the PTY session after a grace period
   * once the last reference is released.
   */
  release(sessionId: string): void {
    const count = this._refCounts.get(sessionId) ?? 0;
    if (count <= 1) {
      this._refCounts.delete(sessionId);
      // 最后一个标签页关掉:reconciler 会把失败条目一并清掉(重开即重试),
      // 账本与提示必须跟着走,否则会留下一条指向已经不在眼前的会话的孤儿失败态。
      this.withdrawFailure(sessionId);
    } else {
      this._refCounts.set(sessionId, count - 1);
    }
    this._reconciler.sync(this.wanted());
  }

  /**
   * 终端腿该跑 = 有页签开着它,**除非**这条会话页挂起成了「没准备」。
   *
   * spec idle-reclaim:回收把会话挂起成「没准备」,页签原样留着(#6950),进程却已被宿主停掉。所以挂起时这里放手,
   * reconciler 走自己那一步落回 stopped(dehydrate 打到一条已停的会话上什么也不做)。再显示、provision 完,
   * 同一张页签按原会话 hydrate。❌ 只认页签:那一格会一直停在 running,点回来终端连着一个已经没了的 pty。
   */
  private wanted(): Iterable<string> {
    return this.isSuspended() ? [] : this._refCounts.keys();
  }

  private isSuspended(): boolean {
    const projectId = sessionRegistry.get(this.sessionId)?.projectId;
    if (!projectId) return false;
    return getSessionPageStore(projectId, this.sessionId)?.state === 'unprovisioned';
  }

  dispose(): void {
    this._offRegistryChange();
    this._offDeliveryFailure();
    for (const sessionId of [...this._surfacedFailures]) {
      this.withdrawFailure(sessionId);
    }
    this._reconciler.dispose();
    this._refCounts.clear();
  }

  private withdrawFailure(sessionId: string): void {
    if (!this._surfacedFailures.delete(sessionId)) return;
    sessionStartupFailures.clear(sessionId);
  }
}

const _registry = new Map<string, SessionPtyManager>();

export function getSessionPtyManager(sessionId: string): SessionPtyManager {
  const existing = _registry.get(sessionId);
  if (existing) return existing;
  const manager = new SessionPtyManager(sessionId);
  _registry.set(sessionId, manager);
  return manager;
}

export function releaseSessionPtyManager(sessionId: string): void {
  const manager = _registry.get(sessionId);
  if (!manager) return;
  manager.dispose();
  _registry.delete(sessionId);
}
