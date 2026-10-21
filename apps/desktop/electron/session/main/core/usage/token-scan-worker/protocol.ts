import type { SourceSpans } from '../model-source';
import type { TokenDayRow } from '../token-fold';
import type { CachedLogFileRow, CachedLogFileSave, TokenScanStats } from '../token-scan';

/**
 * 主进程 ↔ token 扫描 worker 线程的消息。
 *
 * 为什么在 worker 里:读几 GB 的日志、单行几十 MB 的 JSON.parse、十万级条目去重,任何一块都是
 * 不可切分的同步 CPU 活 —— 放在 electron 主线程上,用户界面会整段冻住(2026-09-23 本机实测冷扫单块 438 ms)。
 * 主线程只做:分页读写 SQLite 缓存、收发消息、汇总几百条会话与区间。
 *
 * 顺序约定:同一个 worker 按收到的顺序处理;主进程把全部 `hydrate` 页发完才发第一条 `scan`。
 */
export type ToWorker =
  /** 库缓存的一页,灌进 worker 的内存层。 */
  | { type: 'hydrate'; rows: CachedLogFileRow[] }
  | {
      type: 'scan';
      id: number;
      providerSessions: Array<{ provider: string; providerSessionId: string }>;
      rootsByProvider: Record<string, string[]>;
      /** sessionId → 来源时间段,用来把 token 分成咕咕模型 / 自己账号(见 model-source.ts)。 */
      sourcesByProviderSession: Record<string, SourceSpans>;
    };

export type FromWorker =
  /** 一份文件新解析完,要写回库缓存。每份单独一条消息 —— ❌ 攒成一大条,主线程反序列化会是一整块。 */
  | { type: 'save'; row: CachedLogFileSave }
  | { type: 'file-error'; path: string; error: string }
  | { type: 'result'; id: number; rows: TokenDayRow[]; stats: TokenScanStats }
  | { type: 'failed'; id: number; error: string };
