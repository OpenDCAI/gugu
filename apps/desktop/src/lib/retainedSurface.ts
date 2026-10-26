import type { CSSProperties } from 'react'

// #6158 「常驻但隐藏」的面(切到别的 tab、别的会话、别的预览时用):布局原样保留,只是不画、不可点、不可聚焦、find 找不到。
// content-visibility:hidden 一项全给:被跳过的子树不绘制、不进 tab 序与无障碍树、不接点击、不被 find 命中,
//   IntersectionObserver 判它不相交(「看见即已读」、动效的视口暂停自动跟着停),checkVisibility() 为 false;
//   后代也改不回来。它不继承 ⇒ 切换时不重算子树样式。
// ❌ visibility:hidden / inert 这类可继承的开关:每切一次整面每个元素重算样式(联系人页 7482 个元素一次 12.7–16.3 ms,
//   会话页 1000 行会话 158–168 ms);visibility 还能被后代写 visible 改回,在藏起来的面里照画。
// ❌ display:none —— 它会销毁布局盒:消息列表的滚动位置清零、ResizablePane 的可用宽量成 0、
//   每个 ResizeObserver 都抖一遍,切回时等于半次重挂。
// absolute + inset:0:不占同级 flex 位置,尺寸仍与可见时一致(父容器要 position:relative 当 containing block)。
//   已经自己定位的层(分栏格子、预览层)把自己的位置铺在它后面:`{ ...RETAINED_SURFACE_HIDDEN_STYLE, ...placement }`。
// pointer-events:none:被跳过的只是内容,面自己的盒子还在原位,不能挡住同一位置正在显示的那一面。
// transform:scale(0):窗口拖拽区(-webkit-app-region)不认 content-visibility —— Blink 收集拖拽区时走整棵 layout 树、
//   只看元素自己的 visibility,被跳过的子树又不重算样式,于是藏着的面按上次的布局照样交出它顶栏的 drag / no-drag 矩形,
//   DOM 序靠后就盖掉正在显示那一面的 no-drag:页签、群头按钮点不动(OS 吃掉点击,elementFromPoint 看不出)。
//   矩形按祖先的 transform 换算,scale(0) 把它们压成 0 面积;transform 不继承,不重算子树,也不动布局盒与 ResizeObserver。
export const RETAINED_SURFACE_HIDDEN_STYLE: CSSProperties = { position: 'absolute', inset: 0, contentVisibility: 'hidden', pointerEvents: 'none', transform: 'scale(0)' }
