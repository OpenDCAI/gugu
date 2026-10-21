/**
 * @@@sidebar-row-metrics — 侧栏会话行的横向几何,唯一出处。
 *
 * 三个数各管一件事:
 *   BASE_INSET   行离 list body 左缘多远(见下)。
 *   DEPTH_STEP   每深一级再让 16。
 *   TWISTY_LANE  折叠箭头的车道 —— **每一行都让**,不管它有没有子会话。
 *
 * 车道恒宽是这个模块存在的理由。箭头原来是行内第一个 flex 子元素,只有「有子会话」的行才长出来,
 * 于是同一个列表里,长出子智能体的那一行比左右邻居往右缩 20px,读起来像凭空多了一级缩进
 * (owner 2026-09-07 实机指出)。让每一行都留出这条车道,标题列就与「这一行有没有子项」无关了。
 *
 * ⚠️ 状态分组标题(需要你 / 工作中 / 已完成)必须走同一份数:它与会话行的身份图标本来就落在同一条
 * 竖线上,车道只加在行上的话那条竖线就断了。这对数字原先有两种写法 —— 行是 inline px、组头是
 * Tailwind `pl-8` / `pl-2` —— 改一处另一处不会报错,只会悄悄错位。所以收成一个函数。
 */

/**
 * 三种行,一套列。**项目行也在这套里**(owner 2026-09-07 追加:「项目行的折叠要统一」)——
 * 它原来是另一套惯用法(图标位上 folder ⇄ chevron 淡入淡出),不位移、但与会话行不同形。
 *
 *   [list body 12] [车道 20] [图标 16] [gap 4] [标题]
 *   项目行   base 0  →  12..32     32..48         52…
 *   项目下会话 base 20 →  32..52     52..68         72…
 *   平铺分区会话 base 0 →  12..32     32..48         52…
 *
 * `tree` 的 20 = 一个车道宽的缩进,于是**项目下会话的图标恰好落在项目名那一列**(都是 52)。
 * 这条对齐关系本来就有(改前是 44),换算过来而已 —— ❌ 别把 tree 改回 12,那会让会话图标
 * 跑到项目名左边去。
 *
 * `section` 是 0:置顶 / 任务这两个平铺分区没有父行可对,车道贴着 list body 左缘起步,
 * 内容列因此比改前右移 12px —— 从此这些行读作分区标题(20px)**底下**的一级,而不是与标题齐平。
 */
export const SIDEBAR_ROW_BASE_INSET_PX = { project: 0, tree: 20, section: 0 } as const;

export const SIDEBAR_ROW_DEPTH_STEP_PX = 16;

/** 16px 的箭头按钮 + 行自己的 `gap-1`(4px)。 */
export const SIDEBAR_TWISTY_LANE_PX = 20;

export type SidebarRowVariant = keyof typeof SIDEBAR_ROW_BASE_INSET_PX;

/** 行自己的左内距 —— 折叠箭头的车道从这里开始。 */
export function sidebarRowInsetPx(variant: SidebarRowVariant, depth = 0): number {
  return SIDEBAR_ROW_BASE_INSET_PX[variant] + depth * SIDEBAR_ROW_DEPTH_STEP_PX;
}

/** 行内容(身份图标 / 标题)的左缘 —— 组头要对齐的是这一列,不是行的左内距。 */
export function sidebarRowContentInsetPx(variant: SidebarRowVariant, depth = 0): number {
  return sidebarRowInsetPx(variant, depth) + SIDEBAR_TWISTY_LANE_PX;
}
