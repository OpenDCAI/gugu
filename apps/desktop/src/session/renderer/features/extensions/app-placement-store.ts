import { action, makeObservable, observable } from 'mobx';

/** 一个 App 摆在哪条会话里:那条会话页(项目 + 会话)。 */
export interface AppPlacement {
  projectId: string;
  sessionId: string;
}

/**
 * 每个 App 此刻摆在哪里(behavior tab-extensions「一个 App 只有一份、放在哪就在哪」,#7052)。
 *
 * 一个 App 的页签只在一条会话里:放到别处 = 从原来那处拿过来,❌ 同时摆出两份。这张表是那「一处」的唯一记录 ——
 * 每条会话只留下摆在自己这里的 App 页签(app-placement-sync),所以写这张表就是挪,不必去找原来那条会话关页签;
 * 原来那条会话此刻没在内存里也一样,它下次打开时自己就不留了。
 *
 * 只记**常驻的那一页**(App 为自己开的)。为某个文件开的那种不在这里:一个文件一枚,关就是关。
 * 没摆在任何会话里(从没放过、关掉了、退出了)= 没有记录;点左栏它的图标就整页打开。
 *
 * 按 App 的页签类型记。存在本机(和面板开合同一处):这是这台电脑上怎么摆的,不是 App 的数据。
 */
const STORAGE_KEY = 'gugu.app-placement.v1';

class AppPlacementStore {
  readonly placements = observable.map<string, AppPlacement>({}, { deep: false });

  constructor() {
    makeObservable(this, { place: action, take: action });
    this.load();
  }

  /** 它摆在哪条会话里;没摆着 = undefined。 */
  of(kind: string): AppPlacement | undefined {
    return this.placements.get(kind);
  }

  /** 摆到这条会话里 —— 原来在哪就从哪拿走。 */
  place(kind: string, at: AppPlacement): void {
    const now = this.placements.get(kind);
    if (now?.projectId === at.projectId && now.sessionId === at.sessionId) return;
    this.placements.set(kind, { projectId: at.projectId, sessionId: at.sessionId });
    this.save();
  }

  /** 从它摆着的地方拿走。给了 `from` 就只在它真摆在那里时才拿(关掉一条会话里那一枚,不该拿走别处那一份)。 */
  take(kind: string, from?: { sessionId: string }): void {
    const now = this.placements.get(kind);
    if (!now || (from && now.sessionId !== from.sessionId)) return;
    this.placements.delete(kind);
    this.save();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [kind, at] of Object.entries(parsed)) {
        const { projectId, sessionId } = (at ?? {}) as Partial<AppPlacement>;
        if (typeof projectId === 'string' && typeof sessionId === 'string') this.placements.set(kind, { projectId, sessionId });
      }
    } catch {
      // 读不出来就当哪都没摆:每条会话都不留 App 页签,点左栏图标整页打开。❌ 不让一条坏掉的记录把会话页拖垮。
    }
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.placements)));
    } catch {
      // 存不进去只是重启后忘了摆在哪,本次照常。
    }
  }
}

export const appPlacementStore = new AppPlacementStore();
