/**
 * spec idle-reclaim —— 闲置回收:进程在跑、读数空闲满 10 分钟的会话,把它的进程停掉,会话放回「重启之后还没打开过」
 * 的样子。回收不改变 agent 的任何语义事实:状态、未读、身份、可投递性照旧;下一条消息按原会话唤醒它,用户点开
 * 会话按原会话续上 —— 两条都是重启之后本来就走的路。
 *
 * 本文件只有决策;读进程、读库、停进程、通知渲染层都由安装处注入(install-idle-reclaim.ts)。
 */

export const IDLE_RECLAIM_AFTER_MS = 10 * 60_000;
export const IDLE_RECLAIM_TICK_MS = 60_000;

export type ReclaimTarget = { projectId: string; sessionId: string };

/** 此刻仍持有引擎进程或浏览器页的一条会话。 */
export type LiveSession = ReclaimTarget & {
  runtime: 'acp' | 'pty' | 'browser';
  /** ACP:运行时摘要说它静止(没有在飞的轮、待批准、排队的句、后台任务),且适配器能按原 session 接回来。 */
  acpAtRest?: boolean;
};

/** 会话行上决定「能不能停」的事实(安装处从库里读)。 */
export type SessionFacts = {
  /** 状态写入者写下的基础态;null = 没有状态源。 */
  status: string | null;
  /** 停了再起会接回原来那条对话(ACP 另看 `acpAtRest`);只释放浏览器页时没有引擎要续跑。 */
  resumable: boolean;
};

export type IdleReclaimDeps = {
  now(): number;
  listLive(): LiveSession[] | Promise<LiveSession[]>;
  /** 会话行的事实;行已不在返回 null。 */
  facts(sessionId: string): SessionFacts | null;
  /** 这条会话在屏上(或是最后显示的那条)—— 人在看,不回收。 */
  onScreen(sessionId: string): boolean;
  /** 远端桌面此刻看着这条会话(咕咕 server)—— 同样是人在看。 */
  watchedRemotely(sessionId: string): boolean;
  /** 开着终端 shell 的会话(用户自己的进程,卸下挂载会连带停掉)。 */
  sessionsWithLiveTerminals(): ReadonlySet<string>;
  stop(target: ReclaimTarget, runtime: LiveSession['runtime']): Promise<void>;
  /** 进程已停:让渲染层把这条会话放回未打开的样子。 */
  reclaimed(target: ReclaimTarget): void;
  log(event: 'reclaimed' | 'failed', fields: Record<string, unknown>): void;
};

export class IdleReclaimer {
  /** 进程在跑、读数空闲的会话从什么时候起空闲。只在这台进程里记:❌ 往前补(开机、首次看见都从「现在」起算)。 */
  private readonly idleSince = new Map<string, number>();
  private ticking = false;

  constructor(private readonly deps: IdleReclaimDeps) {}

  /** 状态写入者的每一次发布都是一条新事实:转入空闲从此刻起算,转出空闲就清掉。 */
  observeStatus(sessionId: string, status: string | null): void {
    if (status === 'idle') this.idleSince.set(sessionId, this.deps.now());
    else this.idleSince.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.idleSince.delete(sessionId);
  }

  /** Only a native/FC attestation can remove suspended time. A wake starts a fresh idle window. */
  resumedFromConfirmedSleep(sleep: { since: number; until: number }): void {
    if (!Number.isFinite(sleep.since) || !Number.isFinite(sleep.until) || sleep.until <= sleep.since) return;
    for (const [id, since] of this.idleSince) {
      if (since < sleep.until) this.idleSince.set(id, sleep.until);
    }
  }

  /** 扫一遍;同一时刻只跑一遍。返回这一遍停掉的会话。 */
  async tick(): Promise<ReclaimTarget[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.sweep();
    } finally {
      this.ticking = false;
    }
  }

  private async sweep(): Promise<ReclaimTarget[]> {
    const live = await this.deps.listLive();
    const now = this.deps.now();
    const liveIds = new Set(live.map((entry) => entry.sessionId));
    // 进程不在了(被停、退出)的会话不再计时;下次起来重新算。
    for (const id of [...this.idleSince.keys()]) if (!liveIds.has(id)) this.idleSince.delete(id);

    const withTerminals = this.deps.sessionsWithLiveTerminals();
    const reclaimed: ReclaimTarget[] = [];
    for (const entry of live) {
      const facts = this.deps.facts(entry.sessionId);
      if (!facts || facts.status !== 'idle') {
        this.idleSince.delete(entry.sessionId);
        continue;
      }
      const since = this.idleSince.get(entry.sessionId);
      if (since === undefined) {
        this.idleSince.set(entry.sessionId, now);
        continue;
      }
      const idleMs = now - since;
      if (idleMs < IDLE_RECLAIM_AFTER_MS) continue;
      if (this.deps.onScreen(entry.sessionId) || withTerminals.has(entry.sessionId)) continue;
      if (this.deps.watchedRemotely(entry.sessionId)) continue;
      if (entry.runtime !== 'browser' && (!facts.resumable || (entry.runtime === 'acp' && !entry.acpAtRest))) continue;
      const target = { projectId: entry.projectId, sessionId: entry.sessionId };
      try {
        await this.deps.stop(target, entry.runtime);
      } catch (error) {
        this.deps.log('failed', { ...target, runtime: entry.runtime, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      this.idleSince.delete(entry.sessionId);
      this.deps.log('reclaimed', { ...target, runtime: entry.runtime, idleMs });
      this.deps.reclaimed(target);
      reclaimed.push(target);
    }
    return reclaimed;
  }
}
