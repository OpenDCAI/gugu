import type { CSSProperties } from 'react'
import { SIDEBAR_TABS, type SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

// 放在组件文件外:MobileTabPager.tsx / MainLayout.tsx 只导出组件(react-refresh),这些纯函数单测直接测。
// 分页器的位置读成两种量:停在哪一页(settledTab,切 activeTab 用)和此刻的连续位置(tabPosition,tab 栏亮暗用)。

/** 横滑分页器停在哪一页:只认某一页整页对齐的那一刻;拖动中、惯性中都是 null(#6730)。 */
export function settledTab(scrollLeft: number, pageWidth: number, tabs: readonly SidebarTab[] = SIDEBAR_TABS): SidebarTab | null {
  if (pageWidth <= 0) return null
  const index = Math.round(scrollLeft / pageWidth)
  return Math.abs(scrollLeft - index * pageWidth) < 1 ? (tabs[index] ?? null) : null
}

/**
 * 横滑分页器此刻停在哪儿,连续量:0 = 第一页整屏,1.5 = 第二、三页各露一半。分页器每一帧把它写到底部 tab 栏上
 * (CSS 变量),各格按它算亮度 —— 亮暗跟着手指走,❌ 等吸附到位才换(owner 10-07:「像微信那样……你一边滑,它就
 * 根据滑动的坐标实时变化底部的亮暗状态」)。
 * 写变量而不是 setState:拖动时每帧一次,❌ 每帧重渲染整个壳;变量只挂在 tab 栏上,每帧重算样式的也只有那几格。
 */
export const TAB_POSITION_VAR = '--gg-tab-position'

/** 连续位置,夹在首尾页之间(回弹时 scrollLeft 会出界);还没布局时 null。 */
export function tabPosition(scrollLeft: number, pageWidth: number, pageCount: number = SIDEBAR_TABS.length): number | null {
  if (pageWidth <= 0) return null
  return Math.min(Math.max(scrollLeft / pageWidth, 0), pageCount - 1)
}

/** 一格此刻亮几成(0 暗 … 1 亮);格里的文字、图标、头像环都读它。 */
const LIT_VAR = '--gg-tab-lit'

/**
 * 第 `index` 格的前景:亮度 = max(0, 1 - |位置 - index|),拖到两页正中两格各半亮;颜色在 idleColor(缺省 --text-tertiary)与
 * selectedColor 之间按亮度插值,图标是 currentColor,跟着文字走。
 * 位置变量还没写过(tab 栏刚挂上、分页器还没滚过)就按当前 tab 的整数位置算。|x| 写成 max(x, -x):WebView 113 没有 CSS abs()。
 * ❌ 这里不挂 transition:值本来就跟着手指走,再加过渡就拖在手指后面。点按切换的过渡由 tab 栏只在点按那一下挂上
 * (PhoneTabBar 的 data-tab-switching)。
 */
export function tabItemStyle(index: number, activeIndex: number, selectedColor = 'var(--text-primary)', idleColor = 'var(--text-tertiary)'): CSSProperties {
  const position = `var(${TAB_POSITION_VAR}, ${activeIndex})`
  return {
    [LIT_VAR]: `max(0, 1 - max(${position} - ${index}, ${index} - ${position}))`,
    color: `color-mix(in srgb, ${selectedColor} calc(var(${LIT_VAR}) * 100%), ${idleColor})`,
  } as CSSProperties
}

/**
 * 「我的」那格的头像:选中时圈一道前景色细环、不透明;环的粗细与透明度按所在格的亮度插值。
 * 环插值的是粗细(0 → 1.5px),❌ 用 color-mix 插颜色:安卓 WebView 113 上 box-shadow 里的 color-mix 百分比一带 var(),
 * 整个颜色就退成 currentColor(实测;color / outline-color 里同一写法正常),没选中的头像也会圈一道灰环。
 */
export const TAB_AVATAR_STYLE: CSSProperties = {
  boxShadow: `0 0 0 calc(1.5px * var(${LIT_VAR})) var(--text-primary)`,
  opacity: `calc(0.72 + 0.28 * var(${LIT_VAR}))`,
}
