// 本机任务列表与远程列表使用同一份宿主推送协议；只在助理或任务选择器使用时订阅。
import { makeAutoObservable, runInAction } from 'mobx';
import type { SessionpageSessionSummary, SessionpageSessionsListResult } from '@gugu/session-core/session-record/contract';
import { applySessionListEvent } from '@gugu/session-core/session-record/session-list-delta';
import { events, rpcOn } from '@renderer/lib/ipc';
import { sessionpageSessionListChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { log } from '@renderer/utils/logger';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

class LocalHomeSessions {
  sessions: readonly SessionpageSessionSummary[] = [];
  loaded = false;
  error: string | null = null;
  private users = 0;
  private stop: (() => void) | null = null;

  use(): () => void {
    if (this.users++ === 0) {
      const subscriptionId = crypto.randomUUID();
      let current: SessionpageSessionsListResult | null = null;
      let stopped = false;
      const fail = (error: unknown) => {
        if (stopped) return;
        log.warn('[assistant] 读本机任务列表失败', { error: String(error) });
        runInAction(() => { this.error = error instanceof Error ? error.message : String(error); });
      };
      const off = events.on(sessionpageSessionListChannel, (event) => {
        if (stopped) return;
        try {
          const result = current = applySessionListEvent(current, event);
          runInAction(() => {
            this.sessions = result.sessions;
            this.loaded = true;
            this.error = null;
          });
        } catch (error) { fail(error); }
      }, subscriptionId);
      const pending = Promise.resolve().then(() => rpcOn(null).sessionTimeline.sessionsSubscribe({ subscriptionId })).then((result) => {
        if (!result.ok) fail(new Error(result.error.message));
      }, fail);
      this.stop = () => {
        stopped = true;
        current = null;
        off();
        // 等订阅建好再退订：最后一个使用者可能在首份列表读完之前离开。
        void pending.then(() => rpcOn(null).sessionTimeline.sessionsUnsubscribe({ subscriptionId }))
          .catch((error) => log.warn('[assistant] 退订本机任务列表失败', { error: String(error) }));
      };
    }
    return () => { if (--this.users === 0) this.stop?.(); };
  }
}

export const localHomeSessions = makeAutoObservable<LocalHomeSessions, 'users' | 'stop'>(
  new LocalHomeSessions(), { users: false, stop: false },
);

/** 读它家那台走哪条线:就是眼前这台 = null(本机,❌ 绕远程连自己);别的机器 = 它的 id。 */
export function homeTarget(home: AssistantHomePlace): string | null {
  return home.kind === 'computer' && home.thisDevice ? null : home.deviceId;
}

/** 它家那台上此刻有哪些会话(`live` = 此刻的读数,不是底稿)。observer 里读。 */
export function homeSessions(home: AssistantHomePlace): { sessions: readonly SessionpageSessionSummary[]; live: boolean } {
  if (homeTarget(home) === null) return { sessions: localHomeSessions.sessions, live: localHomeSessions.loaded };
  return remoteHostsStore.sessionsOf(home.deviceId);
}
