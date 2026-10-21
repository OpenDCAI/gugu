// #6264 每台机器「最近用过的文件夹」:在那台机器上开过会话的目录,新建时一键再选(VS Code 的 Remote Explorer、
// Zed 的 remote projects 都是「机器 → 最近文件夹」)。记在这台桌面上,重启后还在;❌ 不跨机器带(路径只在那台机器上有意义)。
//
// 纯函数 + 一层 localStorage。存储读不到/写不进(隐私模式、配额满)时退回空列表,❌ 不让新建框因此打不开。

export const RECENT_FOLDERS_STORAGE_KEY = 'gugu:remote-recent-folders:v1';
/** 每台机器留几条。菜单里一眼扫得完,再多就该用搜索或浏览了。 */
export const RECENT_FOLDERS_PER_DEVICE = 8;

export type RecentFolders = Record<string, string[]>;

/** 把这次用过的路径放到最前;同一路径只留一条(末尾斜杠不算差别)。 */
export function pushRecentFolder(
  current: RecentFolders,
  deviceId: string,
  path: string,
  limit = RECENT_FOLDERS_PER_DEVICE
): RecentFolders {
  const normalized = normalizeFolder(path);
  if (!deviceId || !normalized) return current;
  const previous = current[deviceId] ?? [];
  const next = [normalized, ...previous.filter((item) => normalizeFolder(item) !== normalized)].slice(0, limit);
  return { ...current, [deviceId]: next };
}

export function normalizeFolder(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/' || trimmed === '~') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

/** 存储里的东西不可信(老版本、手改、别的写者):形状不对的一律丢掉。 */
export function parseRecentFolders(raw: string | null): RecentFolders {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: RecentFolders = {};
    for (const [deviceId, paths] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(paths)) continue;
      const clean = paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      if (clean.length > 0) result[deviceId] = clean.slice(0, RECENT_FOLDERS_PER_DEVICE);
    }
    return result;
  } catch {
    return {};
  }
}

export function loadRecentFolders(storage: Pick<Storage, 'getItem'> | null): RecentFolders {
  try {
    return parseRecentFolders(storage?.getItem(RECENT_FOLDERS_STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

export function saveRecentFolders(storage: Pick<Storage, 'setItem'> | null, value: RecentFolders): void {
  try {
    storage?.setItem(RECENT_FOLDERS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 写不进去只是下次没有「最近」,不影响这次新建。
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
