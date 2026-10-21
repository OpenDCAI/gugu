// 页签多到放不下时(每枚已经缩到只剩图标、还是超出):照 VS Code 的「显示打开的编辑器」,贴条右端出一枚菜单,
// 列出这一条分栏里的全部页签,点一项就切过去(贴条同时滚到它)。贴条本身照旧横向滚动,滚轮竖着拨也横着走
// (VS Code 贴条的做法)。纯计算放这里,单测钉住。

/** 滚动区的内容宽度超出可视宽度(留 1px 容差:缩放下的亚像素)。 */
export function isStripOverflowing(box: { scrollWidth: number; clientWidth: number }): boolean {
  return box.scrollWidth - box.clientWidth > 1;
}

/** 竖着拨的滚轮换成横向滚动的量;本来就是横向拨(触控板)就不接管。 */
export function wheelToHorizontal(event: { deltaX: number; deltaY: number }): number | null {
  if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return null;
  return event.deltaY;
}

export type StripTabEntry = { tabId: string; label: string; isActive: boolean };

/** 从贴条里的页签读出菜单项(页签的名字由各类页签自己画,菜单只认它们挂在页签上的 data-tab-label)。 */
export function readStripTabs(root: ParentNode): StripTabEntry[] {
  return [...root.querySelectorAll<HTMLElement>('[data-tabid]')].map((el) => ({
    tabId: el.dataset.tabid ?? '',
    label: el.dataset.tabLabel ?? el.getAttribute('title') ?? '',
    isActive: el.hasAttribute('data-tab-active'),
  })).filter((entry) => entry.tabId);
}
