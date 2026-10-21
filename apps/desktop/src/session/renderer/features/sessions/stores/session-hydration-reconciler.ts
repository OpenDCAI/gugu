import type { IDisposable } from '@gugu/session-shared';

export type SessionHydrationAdapter = {
  hydrateSession(sessionId: string): Promise<void>;
  dehydrateSession(sessionId: string): Promise<void>;
};

type Logger = {
  warn(message: string, data?: unknown): void;
};

type SessionHydrationReconcilerOptions = {
  sessionId: string;
  getSessions: () => SessionHydrationAdapter | undefined;
  log: Logger;
  /** Surface hydrate failures to the user (fail loud) — hydrate() swallows the throw to keep sync() alive. */
  onHydrateError?: (sessionId: string, error: unknown) => void;
  /** hydrate 成功落地(含重试成功):上层据此收掉之前挂出去的失败态。 */
  onHydrated?: (sessionId: string) => void;
};

// 'failed' 是**终态**:hydrate 确定性失败之后停在这里,不让后续每一次 sync() 都把同一个必然失败的
// hydrate 再点一遍。重来的出口有两个:显式 retry(),或者关掉标签页重开(见 cleanupIfIdle)。
type SessionState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export const DEHYDRATE_RETRY_DELAY_MS = 500;

type Entry = {
  desired: boolean;
  state: SessionState;
  dehydrateRetryTimer: ReturnType<typeof setTimeout> | null;
  /** 只在 state === 'failed' 时有意义:停下来的原因,供上层渲染失败态。 */
  lastError: unknown;
};

export class SessionHydrationReconciler implements IDisposable {
  private readonly sessionId: string;
  private readonly getSessions: () => SessionHydrationAdapter | undefined;
  private readonly log: Logger;
  private readonly onHydrateError?: (sessionId: string, error: unknown) => void;
  private readonly onHydrated?: (sessionId: string) => void;
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor({ sessionId, getSessions, log, onHydrateError, onHydrated }: SessionHydrationReconcilerOptions) {
    this.sessionId = sessionId;
    this.getSessions = getSessions;
    this.log = log;
    this.onHydrateError = onHydrateError;
    this.onHydrated = onHydrated;
  }

  sync(openSessionIds: Iterable<string>): void {
    if (this.disposed) return;

    const desired = new Set(openSessionIds);
    const ids = new Set([...this.entries.keys(), ...desired]);

    for (const id of ids) {
      const entry = this.getOrCreateEntry(id);
      entry.desired = desired.has(id);
      if (entry.desired) this.clearDehydrateRetry(entry);
      this.reconcile(id, entry);
      this.cleanupIfIdle(id, entry);
    }
  }

  /**
   * hydrate 失败后停住的原因;没停在失败态就返回 null。
   * 给上层渲染失败态用 —— ❌ 别让界面只剩一个转不完的圈。
   */
  getFailure(sessionId: string): unknown {
    const entry = this.entries.get(sessionId);
    return entry?.state === 'failed' ? entry.lastError : null;
  }

  /** 显式重来一次。'failed' 是终态,但必须留这个出口,否则就成了死胡同。 */
  retry(sessionId: string): void {
    if (this.disposed) return;
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'failed') return;
    entry.state = 'stopped';
    entry.lastError = null;
    this.reconcile(sessionId, entry);
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, entry] of this.entries) {
      this.clearDehydrateRetry(entry);
      entry.desired = false;
      this.reconcile(id, entry);
      this.cleanupIfIdle(id, entry);
    }
  }

  private getOrCreateEntry(id: string): Entry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const entry: Entry = {
      desired: false,
      state: 'stopped',
      dehydrateRetryTimer: null,
      lastError: null,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private reconcile(id: string, entry: Entry): void {
    if (entry.desired && entry.state === 'stopped') {
      void this.hydrate(id, entry);
      return;
    }
    if (!entry.desired && entry.state === 'running') {
      void this.dehydrate(id, entry);
    }
  }

  private async hydrate(id: string, entry: Entry): Promise<void> {
    const sessions = this.getSessions();
    if (!sessions) {
      // SessionPtyManager observes registry availability and calls sync
      // when it changes. Elapsed time is not evidence of a failed initialization.
      return;
    }

    entry.state = 'starting';
    try {
      await sessions.hydrateSession(id);
    } catch (error) {
      // ❌ 不回 'stopped' —— 那样下一次 sync() 会把同一个 hydrate 原样再点一遍。像「换账号后
      // grant 的 owner 对不上」这类失败是确定性的,回 'stopped' 的结果就是每次 sync 都重试、
      // 每次都同样失败,而用户那边只剩一个转不完的圈(#4277)。
      entry.state = 'failed';
      entry.lastError = error;
      this.log.warn('SessionHydrationReconciler: failed to hydrate session', {
        sessionId: id,
        error,
      });
      this.onHydrateError?.(id, error);
      this.cleanupIfIdle(id, entry);
      return;
    }

    entry.state = 'running';
    entry.lastError = null;
    this.onHydrated?.(id);
    // intent may have flipped while we awaited — tear down if no longer wanted
    if (entry.desired) return;
    void this.dehydrate(id, entry, 'stale-hydrate');
  }

  private async dehydrate(
    id: string,
    entry: Entry,
    reason: 'sync' | 'stale-hydrate' = 'sync'
  ): Promise<void> {
    const sessions = this.getSessions();
    if (!sessions) {
      entry.state = 'stopped';
      this.cleanupIfIdle(id, entry);
      return;
    }

    entry.state = 'stopping';
    try {
      await sessions.dehydrateSession(id);
    } catch (error) {
      entry.state = 'running';
      this.log.warn(
        reason === 'stale-hydrate'
          ? 'SessionHydrationReconciler: failed to dehydrate stale session'
          : 'SessionHydrationReconciler: failed to dehydrate session',
        {
          sessionId: id,
          error,
        }
      );
      if (!entry.desired) this.scheduleDehydrateRetry(id, entry);
      return;
    }

    entry.state = 'stopped';
    this.clearDehydrateRetry(entry);
    // intent may have flipped while we awaited — restart if wanted again
    if (entry.desired) {
      this.reconcile(id, entry);
      return;
    }
    this.cleanupIfIdle(id, entry);
  }

  private cleanupIfIdle(id: string, entry: Entry): void {
    // 'failed' 和 'stopped' 一样算「已经停下」:标签页关掉时连失败条目一并清掉,
    // 于是重新打开就是一次干净的重试 —— 终态不等于死胡同。
    if (entry.desired || (entry.state !== 'stopped' && entry.state !== 'failed')) return;
    this.clearDehydrateRetry(entry);
    this.entries.delete(id);
  }

  private scheduleDehydrateRetry(id: string, entry: Entry): void {
    if (this.disposed || entry.dehydrateRetryTimer) return;
    entry.dehydrateRetryTimer = setTimeout(() => {
      entry.dehydrateRetryTimer = null;
      if (this.entries.get(id) !== entry || entry.desired) return;
      this.reconcile(id, entry);
      this.cleanupIfIdle(id, entry);
    }, DEHYDRATE_RETRY_DELAY_MS);
  }

  private clearDehydrateRetry(entry: Entry): void {
    if (!entry.dehydrateRetryTimer) return;
    clearTimeout(entry.dehydrateRetryTimer);
    entry.dehydrateRetryTimer = null;
  }

}
