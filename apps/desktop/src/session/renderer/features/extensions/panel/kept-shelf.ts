import type { MarketHome } from '@shared/extensions/market-home';

/**
 * Apps 页上次画出来的那份,留到下次启动的第一帧(owner 10-30「既然曾经缓存过,为什么又要失效又要重新读取」)。
 * 存 localStorage,理由同 devicesCache.ts:第一帧要的是**同步**读到 —— 异步读(问主进程、IndexedDB)会把第一帧推到下一个
 * 宏任务,白白闪一下骨架。它不是事实源:画出来之后照常重读,读回来整份换上。
 * 每个 App 只存一份,推荐页那几排(精选 / 其余 / 最新 / 热门)只存 id —— 同一个 App 不在里面重复几遍。
 * 形状不对、读不出来就当没有:❌ 迁移,❌ 让它把页面带崩。
 */
const SHELF_KEY = 'gugu.appsShelf.v1:';
const SHOT_KEY = 'gugu.appsShot.v1';

type Item = { manifest: { id: string } };
type Ids = { featured: string[]; remaining: string[]; newest: string[]; popular: string[] | null };
/** `placeholder`:从这张图缩出来的几 KB 小图(data URL),重启后大图解码好之前先画它。 */
export type Shot = { src: string; alt: string; placeholder?: string } | null;

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下只是下次启动先等一趟,不是这一次的事。
  }
}

const idsOf = (rows: readonly Item[]) => rows.map((row) => row.manifest.id);

/** 这一页画完一份(不带搜索词那一份)就存下:App 各一份,几排只记 id;`extra` 是这一页自己要的那几个小字段。 */
export function keepShelf<T extends Item, X>(hostKey: string, items: readonly T[], home: MarketHome<Item>, extra: X): void {
  const ids: Ids = {
    featured: idsOf(home.featured),
    remaining: idsOf(home.remaining),
    newest: idsOf(home.newest),
    popular: home.popular === null ? null : idsOf(home.popular),
  };
  write(SHELF_KEY + hostKey, { items, ids, extra });
}

/** 上次存下的那份,几排按 id 接回同一个对象;没有、或者对不上就是 null。 */
export function keptShelf<T extends Item, X>(hostKey: string): { items: T[]; home: MarketHome<T>; extra: X } | null {
  const kept = read(SHELF_KEY + hostKey) as { items?: unknown; ids?: Partial<Ids>; extra?: X } | null;
  if (!kept || !Array.isArray(kept.items) || !kept.ids) return null;
  const items = kept.items as T[];
  const byId = new Map(items.map((item) => [item.manifest?.id, item]));
  const rows = (ids: unknown): T[] | null => {
    if (!Array.isArray(ids)) return null;
    const found = ids.map((id) => byId.get(id as string));
    return found.every(Boolean) ? (found as T[]) : null;
  };
  const featured = rows(kept.ids.featured);
  const remaining = rows(kept.ids.remaining);
  const newest = rows(kept.ids.newest);
  const popular = kept.ids.popular === null ? null : rows(kept.ids.popular);
  if (!featured || !remaining || !newest || (kept.ids.popular !== null && !popular)) return null;
  return { items, home: { featured, remaining, newest, popular }, extra: kept.extra as X };
}

/** 一个 App 在这台机器上精选底图的那一版:每个 App 只记最后取到的那一版(新一版取到就顶掉旧的)。 */
export function keptShot(hostKey: string, id: string, version: string): Shot | undefined {
  const kept = (read(SHOT_KEY) as Record<string, { version?: string; shot?: Shot }> | null)?.[`${hostKey}|${id}`];
  return kept && kept.version === version && kept.shot !== undefined ? kept.shot : undefined;
}

export function keepShot(hostKey: string, id: string, version: string, shot: Shot): void {
  const all = (read(SHOT_KEY) as Record<string, unknown> | null) ?? {};
  write(SHOT_KEY, { ...all, [`${hostKey}|${id}`]: { version, shot } });
}

/** 存下的每一张精选底图(启动时预解码)。 */
export function keptShotSrcs(): string[] {
  const all = (read(SHOT_KEY) as Record<string, { shot?: Shot }> | null) ?? {};
  return Object.values(all).flatMap((kept) => (kept?.shot?.src ? [kept.shot.src] : []));
}

/**
 * 这次运行里解码好的底图,留着那个 Image:卡片再挂上时,同一张图直接画(❌ 每挂一次就重新解码、空几帧)。
 * 没解码好的那张不上屏 —— 一张图只有解码好了才出现。
 */
const decoded = new Map<string, HTMLImageElement>();

export const isDecoded = (src: string) => decoded.has(src);

export async function decodeShot(src: string): Promise<void> {
  if (decoded.has(src)) return;
  const image = new window.Image();
  image.src = src;
  await image.decode();
  decoded.set(src, image);
}

/** 启动时把上次存下的精选底图先解码好:重启后点进 Apps,第一帧就是图。只是预热,解不出来的等卡片自己取。 */
export function warmKeptShots(): void {
  for (const src of keptShotSrcs()) void decodeShot(src).catch(() => undefined);
}
