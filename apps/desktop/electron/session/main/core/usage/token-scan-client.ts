import type { SourceSpans } from './model-source';
import type { TokenDayRow } from './token-fold';
import type { CachedLogFileRow, CachedLogFileSave, TokenScanStats } from './token-scan';
import type { FromWorker, ToWorker } from './token-scan-worker/protocol';

/** worker 线程的最小外形(node 的 Worker 满足它;单测用进程内实现)。 */
export type TokenScanWorkerLike = {
  postMessage(message: ToWorker): void;
  on(event: 'message', listener: (message: FromWorker) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
  unref?(): void;
};

/**
 * 库缓存(`usage_token_file_cache`)的主线程读写口。**分页**:整张表单机约 11 MB,
 * 一口气 SELECT 出来就是主线程上的一整块。
 */
export type TokenCachePager = {
  /** path 严格大于 `afterPath` 的前 `limit` 行,按 path 升序。 */
  loadPage(afterPath: string, limit: number): CachedLogFileRow[];
  save(row: CachedLogFileSave): void;
};

export type TokenScanRequest = {
  providerSessions: Array<{ provider: string; providerSessionId: string }>;
  rootsByProvider: Record<string, string[]>;
  /** sessionId → 来源时间段(咕咕模型 / 自己账号)。 */
  sourcesByProviderSession: Record<string, SourceSpans>;
};

export type TokenScanResult = { rows: TokenDayRow[]; stats: TokenScanStats };

const HYDRATE_PAGE_ROWS = 40;
/** 空闲这么久就收掉线程(连同它内存里已解析的条目);下次打开用量页从库缓存分页灌回去。 */
export const TOKEN_SCAN_IDLE_MS = 5 * 60_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 用量页 token 扫描的主进程这一半。一个 worker 线程,懒起、空闲收;同一时刻只跑一轮扫描
 * (并发的调用共用同一轮的结果)。worker 死了(崩溃 / 被收)就把在途的请求判失败,下次调用重起。
 */
export function createTokenScanClient(options: {
  spawn: () => TokenScanWorkerLike;
  cache: TokenCachePager;
  onFileError?: (path: string, error: string) => void;
  onSaveError?: (path: string, error: unknown) => void;
  idleMs?: number;
}) {
  type Live = {
    worker: TokenScanWorkerLike;
    hydrated: Promise<void>;
    pending: Map<number, { resolve: (r: TokenScanResult) => void; reject: (e: Error) => void }>;
    /** 线程已死(崩溃 / 退出)的原因。之后才登记的请求当场判失败 —— ❌ 挂在一个死线程上等一辈子。 */
    dead: Error | null;
  };
  let live: Live | null = null;
  let nextId = 1;
  let inflight: Promise<TokenScanResult> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const fail = (target: Live, error: Error) => {
    target.dead ??= error;
    if (live === target) live = null;
    for (const { reject } of target.pending.values()) reject(error);
    target.pending.clear();
  };

  const start = (): Live => {
    const worker = options.spawn();
    worker.unref?.();
    const target: Live = { worker, hydrated: Promise.resolve(), pending: new Map(), dead: null };
    worker.on('message', (message) => {
      switch (message.type) {
        case 'save':
          try {
            options.cache.save(message.row);
          } catch (error) {
            options.onSaveError?.(message.row.path, error);
          }
          return;
        case 'file-error':
          options.onFileError?.(message.path, message.error);
          return;
        case 'result':
          target.pending.get(message.id)?.resolve({ rows: message.rows, stats: message.stats });
          target.pending.delete(message.id);
          return;
        case 'failed':
          target.pending.get(message.id)?.reject(new Error(`usage token scan failed: ${message.error}`));
          target.pending.delete(message.id);
          return;
      }
    });
    worker.on('error', (error) => fail(target, error));
    worker.on('exit', (code) => fail(target, new Error(`usage token scan worker exited (code ${code})`)));
    target.hydrated = (async () => {
      let after = '';
      for (;;) {
        if (target.dead) return;
        const rows = options.cache.loadPage(after, HYDRATE_PAGE_ROWS);
        if (rows.length === 0) break;
        worker.postMessage({ type: 'hydrate', rows });
        after = rows[rows.length - 1].path;
        await yieldToEventLoop();
      }
    })();
    return target;
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inflight || !live) return;
      const target = live;
      live = null;
      void target.worker.terminate();
    }, options.idleMs ?? TOKEN_SCAN_IDLE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  };

  const run = async (request: TokenScanRequest): Promise<TokenScanResult> => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const target = live ?? (live = start());
    await target.hydrated;
    if (target.dead) throw target.dead;
    const id = nextId++;
    const result = new Promise<TokenScanResult>((resolve, reject) => {
      target.pending.set(id, { resolve, reject });
    });
    target.worker.postMessage({ type: 'scan', id, ...request });
    return result;
  };

  return {
    scan(request: TokenScanRequest): Promise<TokenScanResult> {
      if (inflight) return inflight;
      inflight = run(request).finally(() => {
        inflight = null;
        armIdle();
      });
      return inflight;
    },
    /** 退出/测试用:收掉线程。 */
    async dispose(): Promise<void> {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const target = live;
      live = null;
      if (target) await target.worker.terminate();
    },
  };
}
