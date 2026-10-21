import { useCallback, useEffect, useRef, useState } from 'react';
import { rpcOn } from '@renderer/lib/ipc';
import type {
  SessionHistoryDirectoryPage,
  SessionHistoryDirectoryParams,
  SessionHistoryPage,
  SessionHistoryParams,
} from '@shared/core/session-history/session-history';

// spec session-page「会话历史」(#6083):面板的数据源。节奏照搬 `use-local-sessions`:
//   第 0 轮 本机索引缓存直接出(毫秒级,面板一开就有东西看;咕咕自己的会话每轮都是库里的真值)
//   第 1 轮 对账磁盘 + 解析一小批(400ms 预算)
//   第 n 轮 继续解析,直到本机索引 pending 归零
// 每轮结果整页替换 —— 筛 / 排 / 聚合都在主进程做完了,这里**不排序、不分组**,只按给定顺序画。
// 目录视图与会话视图是同一套节奏、不同的主进程读法;展开一个目录 = 再开一路会话读法(带 directory)。
// #6264 会话历史按机器:所选那台机器上同一个 `sessionHistory` 控制器(读的是那台机器的库与各家原件)。

const PAGE_LIMIT = 200;
const FIRST_ROUND_BUDGET_MS = 400;
const BACKGROUND_ROUND_BUDGET_MS = 1200;
const ROUND_PAUSE_MS = 300;
/** 与 use-local-sessions 同一条上限:正在被写入的 transcript 每轮都 miss 缓存,pending 可以永远不归零。 */
const MAX_ROUNDS = 40;

type LocalProgress = SessionHistoryPage['local'];
type RoundParams = Pick<SessionHistoryParams, 'mode' | 'hydrateBudgetMs'>;

export type SessionHistoryState<TPage> = {
  page: TPage | null;
  /** 一条都还没拿到(首帧骨架用)。 */
  isLoading: boolean;
  /** 本机索引还在补:未导入那一档的结果还会变多。 */
  isIndexing: boolean;
  error: string | null;
  /** 原始错误:别的机器问不通 / 太旧时,调用方按它说人话(describeImportFailure)。 */
  cause: unknown;
};

export type SessionHistoryQuery = Omit<SessionHistoryParams, 'mode' | 'hydrateBudgetMs'>;
export type SessionHistoryDirectoryQuery = Omit<SessionHistoryDirectoryParams, 'mode' | 'hydrateBudgetMs'>;

const IDLE = { page: null, isLoading: false, isIndexing: false, error: null, cause: null };

/** 去掉 undefined、补默认 limit,再按值序列化:调用方每次渲染都新建 query 对象,按引用比会让面板每一帧都重拉。 */
function serialize(query: object): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query) as Array<[string, unknown]>) {
    if (value === undefined) continue;
    if (key === 'query') {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) normalized.query = trimmed;
      continue;
    }
    // 第一页不传 offset(与「没有分页」同一个请求形状,主进程测试钉的就是这个形状)。
    if (key === 'offset' && !value) continue;
    normalized[key] = value;
  }
  normalized.limit ??= PAGE_LIMIT;
  return JSON.stringify(normalized);
}

function useRounds<TParams extends object, TPage extends { local: LocalProgress }>(
  fetchPage: (params: TParams & RoundParams) => Promise<TPage>,
  query: TParams | null,
  /** 换了机器:上一台的那页 ❌ 留着冒充这一台的,从骨架重来。 */
  machine: string | null
): SessionHistoryState<TPage> & { refresh: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SessionHistoryState<TPage>>({ ...IDLE, isLoading: query !== null });
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const key = query ? serialize(query) : null;
  const lastMachine = useRef(machine);

  useEffect(() => {
    const machineChanged = lastMachine.current !== machine;
    lastMachine.current = machine;
    if (key === null) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    const base = JSON.parse(key) as TParams;

    const run = async () => {
      setState((prev) =>
        machineChanged ? { ...IDLE, isLoading: true } : { ...prev, isLoading: prev.page === null, error: null, cause: null }
      );
      try {
        const cached = await fetchPage({ ...base, mode: 'cached' });
        if (cancelled) return;
        // 缓存页只在本机索引真有缓存时才值得画;没有时下一轮 fresh 马上到。
        if (cached.local?.stale) {
          setState({ page: cached, isLoading: false, isIndexing: false, error: null, cause: null });
        }

        let budgetMs = FIRST_ROUND_BUDGET_MS;
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const fresh = await fetchPage({ ...base, mode: 'fresh', hydrateBudgetMs: budgetMs });
          if (cancelled) return;
          const pending = fresh.local?.pending ?? 0;
          setState({ page: fresh, isLoading: false, isIndexing: pending > 0, error: null, cause: null });
          if (pending === 0) return;
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
          error: error instanceof Error ? error.message : String(error),
          cause: error,
        }));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, key, attempt, machine]);

  return { ...state, refresh };
}

/** 会话视图(也是展开一个目录时的那一路)。`query` 为 null = 这一路不用拉,状态停在空闲。machine:null = 本机。 */
export function useSessionHistory(query: SessionHistoryQuery | null, machine: string | null = null) {
  const fetchSessions = useCallback(
    (params: SessionHistoryParams) => rpcOn(machine).sessionHistory.list(params),
    [machine]
  );
  return useRounds<SessionHistoryQuery, SessionHistoryPage>(fetchSessions, query, machine);
}

/** 目录视图(默认)。 */
export function useSessionHistoryDirectories(query: SessionHistoryDirectoryQuery | null, machine: string | null = null) {
  const fetchDirectories = useCallback(
    (params: SessionHistoryDirectoryParams) => rpcOn(machine).sessionHistory.listDirectories(params),
    [machine]
  );
  return useRounds<SessionHistoryDirectoryQuery, SessionHistoryDirectoryPage>(fetchDirectories, query, machine);
}
