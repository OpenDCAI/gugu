import type { TabEntry, TabResource } from './core/tab-provider';
import type { PaneStore } from './pane-store';

/**
 * 同一种页签并排时(两个文件、两个网页,spec session-page「并排」)屏上要有两份这种页签的内容:另一页单独挂一份。
 * 这份内容看到的这一格只有那一枚(`side`);其余内容看到的这一格没有它(`rest`)—— 每枚页签仍只挂一次
 * (❌ 两份各挂一遍:同一个网页 / 终端挂两次会互相抢)。
 */
export type PaneSlot = 'rest' | 'side';

/** 此刻屏上那一对是同一种页签时的另一页;不是 = null。 */
export function sameKindSide(pane: PaneStore): string | null {
  const pair = pane.pairShown ? pane.livePair : null;
  if (!pair) return null;
  const anchorKind = pane.entries.get(pair.anchor)?.kind;
  return anchorKind !== undefined && anchorKind === pane.entries.get(pair.side)?.kind ? pair.side : null;
}

/**
 * 给内容看的这一格。每次读都按此刻的那一对现算(❌ 记住某一枚:内容挂上时就把格子记下了,
 * 另一页换成别的文件之后还盯着旧的那枚)。没有同一种的一对时 `rest` 就是这一格本身的样子。
 *
 * 只改「有哪些页签、屏上是哪枚」这几样读法;拿着焦点的是哪枚(resolvedActiveTabId)、动作(关、亮起)照原样转给这一格。
 */
export function paneSlotView(pane: PaneStore, slot: PaneSlot): PaneStore {
  const keep = (id: string) => {
    const side = sameKindSide(pane);
    return slot === 'side' ? id === side : id !== side;
  };
  const shownEntryOfKind = (kind: string): TabEntry | undefined => {
    for (const id of pane.shownTabIds) {
      if (!keep(id)) continue;
      const entry = pane.entries.get(id);
      if (entry?.kind === kind) return entry;
    }
    return undefined;
  };
  const overrides: Partial<Record<PropertyKey, () => unknown>> = {
    resolvedTabs: () => pane.resolvedTabs.filter((tab) => keep(tab.tabId)),
    shownTabIds: () => pane.shownTabIds.filter(keep),
    tabOrder: () => pane.tabOrder.filter(keep),
    activeEntryOfKind: () => shownEntryOfKind,
    activeResourceOfKind: () => (kind: string) => {
      const entry = shownEntryOfKind(kind);
      return entry ? pane._resources.get(entry.tabId) : undefined;
    },
    entriesOfKind: () => (kind: string) => pane.entriesOfKind(kind).filter((entry) => keep(entry.tabId)),
    resourcesOfKind: () => (kind: string) =>
      pane.tabOrder
        .filter((id) => keep(id) && pane.entries.get(id)?.kind === kind)
        .map((id) => pane._resources.get(id))
        .filter((resource): resource is TabResource => resource !== undefined),
    activeMatches: () => (kind: string, key: string) => {
      const entry = shownEntryOfKind(kind);
      return !!entry && pane.registry.has(kind) && pane.registry.get(kind).resourceKey(entry.state as never) === key;
    },
  };
  return new Proxy(pane, {
    get(target, prop) {
      // 只认上面列的几样(❌ `overrides[prop]`:'constructor'、'toString' 这类会从原型上读到)。
      const override = Object.hasOwn(overrides, prop) ? overrides[prop] : undefined;
      if (override) return override();
      // 取值时 this 仍是这一格本身:它的 getter / 方法读的是真实状态。
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
