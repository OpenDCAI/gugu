// #7199 个人助理住在这台电脑上时(非会员,owner 10-16),它自己那条会话、它派的子 agent 都是本机会话。
// 别的机器的会话目录由 remoteHostsStore 同步;本机这一份不在那里(那里只放别的机器),这里按同一张路由表现问本机
// (`sessionTimeline.sessionsList`,手机、别的电脑读的就是这一份,行上带 agent id)—— 只在助理 App / 录音机用着时问,❌ 一直问。
import { makeAutoObservable, runInAction } from 'mobx';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { rpcOn } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

const POLL_MS = 5_000;

class LocalHomeSessions {
  sessions: readonly SessionpageSessionSummary[] = [];
  /** 读到过一次了(没读到 ≠ 本机没有会话)。 */
  loaded = false;
  error: string | null = null;
  private users = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    makeAutoObservable<LocalHomeSessions, 'users' | 'timer'>(this, { users: false, timer: false });
  }

  /** 用着就问(引用计数):返回停用的那一下。 */
  use(): () => void {
    this.users += 1;
    if (this.users === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), POLL_MS);
    }
    return () => {
      this.users -= 1;
      if (this.users === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async refresh(): Promise<void> {
    try {
      const result = await rpcOn(null).sessionTimeline.sessionsList();
      runInAction(() => {
        this.sessions = result.sessions;
        this.loaded = true;
        this.error = null;
      });
    } catch (error) {
      log.warn('[assistant] 读本机会话列表失败', { error: String(error) });
      runInAction(() => {
        this.error = error instanceof Error ? error.message : String(error);
      });
    }
  }
}

export const localHomeSessions = new LocalHomeSessions();

/** 读它家那台走哪条线:就是眼前这台 = null(本机,❌ 绕远程连自己);别的机器 = 它的 id。 */
export function homeTarget(home: AssistantHomePlace): string | null {
  return home.kind === 'computer' && home.thisDevice ? null : home.deviceId;
}

/** 它家那台上此刻有哪些会话(`live` = 此刻的读数,不是底稿)。observer 里读。 */
export function homeSessions(home: AssistantHomePlace): { sessions: readonly SessionpageSessionSummary[]; live: boolean } {
  if (homeTarget(home) === null) return { sessions: localHomeSessions.sessions, live: localHomeSessions.loaded };
  return remoteHostsStore.sessionsOf(home.deviceId);
}
