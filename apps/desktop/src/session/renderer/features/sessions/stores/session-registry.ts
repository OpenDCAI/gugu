import {
  PageSessionsStore,
  type SessionStore,
} from '@renderer/features/sessions/page-sessions-store';
import type { Session } from '@shared/core/sessions/sessions';
import { observable, runInAction } from 'mobx';

export class SessionRegistry {
  private readonly entries = observable.map<string, PageSessionsStore>(undefined, { deep: false });

  acquire(sessionId: string, projectId: string, preloaded?: Session[]): PageSessionsStore {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const store = new PageSessionsStore(projectId, sessionId, preloaded);
    runInAction(() => this.entries.set(sessionId, store));
    return store;
  }

  get(sessionId: string): PageSessionsStore | undefined {
    return this.entries.get(sessionId);
  }

  /**
   * 挂着的全部会话,跨 task、跨项目、跨机器合成一张表。
   *
   * #5665 一个任务 = 一个会话:spawn 出来的子会话各住一项 task;派到别的机器上的还在那台机器的项目里
   * (owner 2026-10-01 归档 / 删除「一起收」)。所以「这条会话名下有哪些子会话」只看一项 task、一个项目的表都数不全。
   * 按边找后代的地方喂这张表。
   */
  allSessions(): Map<string, SessionStore> {
    const merged = new Map<string, SessionStore>();
    for (const manager of this.entries.values()) {
      for (const [id, session] of manager.sessions) merged.set(id, session);
    }
    return merged;
  }

  release(sessionId: string): void {
    const store = this.entries.get(sessionId);
    if (!store) return;
    runInAction(() => this.entries.delete(sessionId));
    store.dispose();
  }
}

export const sessionRegistry = new SessionRegistry();
