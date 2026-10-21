import { createContext, useContext } from 'react';

/**
 * @@@sidebar-single-scroller — 侧栏正文(置顶 / 项目 / 任务三区)共用**一个**滚动容器。
 *
 * 为什么必须共用:三区各自 auto 高度、谁也不该被挤扁。以前项目区自带滚动容器、其余两区
 * `shrink-0`,于是 flex 只能拿项目区当唯一的收缩对象 —— 任务区一展开就把项目区压到零高,
 * 两个分区标题叠在一起(「项目」压着「任务」),而任务区自己没有滚动容器,超出的部分被
 * `SidebarContent` 的 overflow-hidden 直接切掉,永远翻不下去。
 *
 * 项目区是虚拟列表,虚拟化要求一个**边界确定的** scrollElement;共用滚动容器后它拿到的就是
 * 这个 `scroller`,再用 `scrollMargin` 抵消自己在容器里的起始偏移(见 sidebar-virtual-list)。
 * `content` 是容器里唯一的内容包裹层,虚拟列表靠观察它的尺寸变化重新测量那个偏移 ——
 * 上方的「置顶」分区展开/收起不会让虚拟列表自己重渲染(各自是独立的 observer)。
 */
export interface SidebarScrollTargets {
  /** 真正滚动的那一层 */
  scroller: HTMLElement | null;
  /** 容器里唯一的内容包裹层,高度 = 三区之和 */
  content: HTMLElement | null;
}

export const SidebarScrollContext = createContext<SidebarScrollTargets>({
  scroller: null,
  content: null,
});

export const useSidebarScrollTargets = () => useContext(SidebarScrollContext);
