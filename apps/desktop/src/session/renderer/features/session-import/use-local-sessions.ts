import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ListLocalSessionsResult,
  LocalSessionEngine,
} from '@shared/core/session-import/session-import';
import type { SessionImportSource } from './import-source';

// @@@sessionpage 导入本机会话 (spec session-page-import)：面板的数据源。
//
// 本机会话可能上万条，一次全扫要几十秒。索引因此是分轮的：
//   第 0 轮 从上次的索引缓存直接出（毫秒级，面板一开就有东西看）
//   第 1 轮 对账磁盘 + 解析一小批（400ms 预算，最近的会话优先）
//   第 n 轮 继续解析，直到 pending 归零
// 每轮结果都替换列表，所以「还没索引到」的会话会自己冒出来，用户不需要手动刷新。
// 索引没走完时面板显式显示进度 —— 搜不到的可能只是还没索引到，不能让用户以为不存在。
//
// #6264 问的是哪台机器由 source 定(本机 IPC / 那台机器的设备 RPC),分轮的节奏两边一样。

const PAGE_LIMIT = 200;
const FIRST_ROUND_BUDGET_MS = 400;
const BACKGROUND_ROUND_BUDGET_MS = 1200;
/** 轮之间歇一下，别把主进程的磁盘 IO 占满（面板开着不动时尤其明显）。 */
const ROUND_PAUSE_MS = 300;
/**
 * 索引轮次上限。正常几轮就到底；但一个**正在被写入**的会话文件每轮都会 miss 缓存，
 * pending 可以永远不归零 —— 没有上限就是个无限轮询。到顶后停下，界面照常显示进度数字。
 */
const MAX_ROUNDS = 40;

export type LocalSessionsState = {
  page: ListLocalSessionsResult | null;
  /** 一条都还没拿到（首帧骨架用）。 */
  isLoading: boolean;
  /** 后台还在补索引：结果还会变多。 */
  isIndexing: boolean;
  /** 失败的原始错误(怎么说给人听由面板按机器决定,见 describeImportFailure)。 */
  error: { cause: unknown } | null;
};

export function useLocalSessions(params: {
  source: SessionImportSource;
  /** false = 这台机器此刻问不到(离线 / 不在名下了):不去问,清单清空。 */
  enabled?: boolean;
  engine: LocalSessionEngine | null;
  query: string;
}): LocalSessionsState & { retry: () => void } {
  const { source, engine, query } = params;
  const enabled = params.enabled ?? true;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LocalSessionsState>({
    page: null,
    isLoading: true,
    isIndexing: false,
    error: null,
  });

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // 换了机器:上一台的清单 ❌ 留在屏上等这一台的回来(那一刻看着像是 d22 的会话,点下去导的却是本机的)。
  const deviceRef = useRef(source.deviceId);

  useEffect(() => {
    // 外部系统（主进程的磁盘索引）在分轮推进，这里跟着它跑到底；换筛选条件或关面板即取消。
    let cancelled = false;
    if (!enabled) {
      setState({ page: null, isLoading: false, isIndexing: false, error: null });
      return;
    }
    const base = {
      ...(engine ? { engine } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      limit: PAGE_LIMIT,
    };

    const switchedDevice = deviceRef.current !== source.deviceId;
    deviceRef.current = source.deviceId;

    const run = async () => {
      setState((prev) =>
        switchedDevice
          ? { page: null, isLoading: true, isIndexing: false, error: null }
          : { ...prev, isLoading: prev.page === null, error: null }
      );
      try {
        const cached = await source.list({ ...base, mode: 'cached' });
        if (cancelled) return;
        if (cached.stale) {
          setState({ page: cached, isLoading: false, isIndexing: false, error: null });
        }

        let budgetMs = FIRST_ROUND_BUDGET_MS;
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const fresh = await source.list({
            ...base,
            mode: 'fresh',
            hydrateBudgetMs: budgetMs,
          });
          if (cancelled) return;
          setState({
            page: fresh,
            isLoading: false,
            isIndexing: fresh.pending > 0,
            error: null,
          });
          if (fresh.pending === 0) return;
          budgetMs = BACKGROUND_ROUND_BUDGET_MS;
          await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
          if (cancelled) return;
        }
      } catch (error) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isIndexing: false,
          error: { cause: error },
        }));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // source 随所选机器换;同一台机器的 source 由面板 memo 住,❌ 每次渲染都重扫一遍。
  }, [source, enabled, engine, query, attempt]);

  return { ...state, retry };
}
