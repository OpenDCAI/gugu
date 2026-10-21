import { marketIndexSchema, type MarketIndex } from './market';

/**
 * 手上那份市场目录(owner 10-16「打开 app 页每次都要刷新比较长的时间……本地有缓存啊」):打开 App 页、查有没有新版,
 * 都从这一份立刻答;同时去下载站取一次,取回来变了就整份换掉、告诉在看的人重读。只有从没取到过(新 profile 第一次)
 * 才等那一趟。桌面主进程(market-catalog.ts,落在 userData)和手机(phoneMarket.ts,落在页面自己的存储)用的是这一份,
 * 存在哪由各端注入。
 *
 * 为什么不怕「市场页和有新版 / 被撤回读到不同时刻」(10-08 0cbd41df8c 因此禁了落盘缓存、按时效复用:那次 A/B 里撤回已经
 * 显示在行上,卡片却还是被撤回的那一版):列表和更新检查都只读这一份;后台取回来是整份替换、只报一次,两边跟着同一次
 * 一起重读 —— 不会一边新一边旧。也照旧 ❌ 按时效复用:每次打开都去取,不看它多旧。
 * 安装仍然现取(`fresh`):装下去的必须是下载站此刻那一版的字节和指纹;现取到的同样替换手上这份、照样报。
 */

/** 手上那份目录和它取到的时刻。 */
export interface MarketSnapshot {
  fetchedAt: number;
  index: MarketIndex;
}

/** 落在哪儿:一段文本。没有 = null。写不进去由实现自己记日志,❌ 抛 —— 存不住只是下次启动没缓存,不是这次没取到。 */
export interface MarketSnapshotStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/**
 * 一次去下载站取的结果。`fetchedAt` 是取完以后手上那份的时刻(失败时是旧那份的;从没取到过是 null)。
 * `changed` = 和手上那份不一样(第一次取到也算),看的人据此重读;`unchanged` 什么都不用重画;
 * `failed` = 没取到,手上那份照旧,界面安静说一句「上次更新于 …」(原话走 `onFailure` 进日志,❌ 跟着它进界面)。
 */
export type MarketRefreshed =
  | { outcome: 'changed' | 'unchanged'; fetchedAt: string }
  | { outcome: 'failed'; fetchedAt: string | null };

export interface MarketSnapshotSource {
  /** 手上那份(内存里的,没有就读落下的那份);都没有才去取并等它 —— 只有从没取到过的那一次挡。 */
  current(): Promise<MarketSnapshot>;
  /**
   * 现在去下载站取一次(同一时刻只有一趟在路上,别人来要就等同一趟)。取回来替换手上那份、落下、报给 `onRefreshed`;
   * 没取到抛,手上那份不动。
   */
  fresh(): Promise<MarketSnapshot>;
  /** 同一趟,只要结果、不抛:打开 App 页时那一趟。 */
  refresh(): Promise<MarketRefreshed>;
  /** 每一趟的结果(不论谁叫的:打开页面、安装、首启)。返回退订。 */
  onRefreshed(listener: (refreshed: MarketRefreshed) => void): () => void;
}

export interface MarketSnapshotOptions {
  /** 下载站上那份 `index.json` 的原文。连不上、不是 2xx 都抛。 */
  readIndex: () => Promise<string>;
  store: MarketSnapshotStore;
  /** 目录从哪个根取的:落下的那份根不一样(开发形态指到本地测试市场)就不认。 */
  scope?: string;
  /** 一趟没取到的原话:给日志。 */
  onFailure?: (error: unknown) => void;
  now?: () => number;
}

/** 落下的样子。`text` 是下载站给的原文:「变没变」比的就是它,读回来再按同一个 schema 解。 */
interface StoredSnapshot {
  v: 1;
  scope: string;
  fetchedAt: number;
  text: string;
}

interface Held {
  text: string;
  snapshot: MarketSnapshot;
}

type Trip = { snapshot: MarketSnapshot; refreshed: MarketRefreshed } | { error: unknown; refreshed: MarketRefreshed };

export function parseMarketIndex(text: string): MarketIndex {
  const parsed = marketIndexSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    // 目录是索引仓的 CI 生成的;形状不对是发布那一侧的事故,照实抛,❌ 当成空市场。
    throw new Error(
      `market index.json is malformed: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    );
  }
  return parsed.data;
}

/** 落下的那份读回来;读不懂(别的格式、存坏了、别的根)就当没有 —— 那正是「从没取到过」,去取一次就是。 */
function fromStored(text: string | null, scope: string): Held | null {
  if (!text) return null;
  try {
    const stored = JSON.parse(text) as Partial<StoredSnapshot>;
    if (stored.v !== 1 || stored.scope !== scope || typeof stored.text !== 'string' || typeof stored.fetchedAt !== 'number') {
      return null;
    }
    return { text: stored.text, snapshot: { fetchedAt: stored.fetchedAt, index: parseMarketIndex(stored.text) } };
  } catch {
    return null;
  }
}

export function marketSnapshotSource(options: MarketSnapshotOptions): MarketSnapshotSource {
  const scope = options.scope ?? '';
  const now = options.now ?? Date.now;
  const listeners = new Set<(refreshed: MarketRefreshed) => void>();
  let held: Held | null = null;
  let stored: Promise<Held | null> | null = null;
  let inFlight: Promise<Trip> | null = null;

  const iso = (at: number) => new Date(at).toISOString();
  // 落下的那份只读一次:之后手上那份就是它,或者比它新的。
  const readStored = () => (stored ??= options.store.read().then((text) => fromStored(text, scope), () => null));
  const inHand = async () => held ?? (await readStored());

  const go = async (): Promise<Trip> => {
    let text: string;
    let index: MarketIndex;
    try {
      text = await options.readIndex();
      index = parseMarketIndex(text);
    } catch (error) {
      options.onFailure?.(error);
      const kept = await inHand();
      return { error, refreshed: { outcome: 'failed', fetchedAt: kept ? iso(kept.snapshot.fetchedAt) : null } };
    }
    // 「变没变」和手上那份比 —— 第一次取回来时手上可能还没读落下的那份,先读。
    const before = await inHand();
    held = { text, snapshot: { fetchedAt: now(), index } };
    const record: StoredSnapshot = { v: 1, scope, fetchedAt: held.snapshot.fetchedAt, text };
    await options.store.write(JSON.stringify(record));
    return {
      snapshot: held.snapshot,
      refreshed: { outcome: before?.text === text ? 'unchanged' : 'changed', fetchedAt: iso(held.snapshot.fetchedAt) },
    };
  };

  const trip = (): Promise<Trip> =>
    (inFlight ??= go()
      .finally(() => {
        inFlight = null;
      })
      .then((result) => {
        for (const listener of [...listeners]) listener(result.refreshed);
        return result;
      }));

  const fresh = async (): Promise<MarketSnapshot> => {
    const result = await trip();
    if ('error' in result) throw result.error;
    return result.snapshot;
  };

  return {
    current: async () => {
      if (held) return held.snapshot;
      const kept = await readStored();
      // 读盘的工夫里,一趟现取可能已经回来了:手上那份更新,用它。
      held ??= kept;
      return held ? held.snapshot : fresh();
    },
    fresh,
    refresh: async () => (await trip()).refreshed,
    onRefreshed: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
