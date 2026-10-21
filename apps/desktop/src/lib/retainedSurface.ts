import type { CSSProperties } from 'react'

// #6158 「常驻但隐藏」的面(聊天面切到别的 tab 时用):布局原样保留,只是不可见、不可点、不可聚焦。
// 与会话页 browser-tab-provider 的「visibility:hidden + inert so browser sessions survive tab switches」
// 同一套,要配 `inert` 一起用。
// ❌ display:none —— 它会销毁布局盒:消息列表的滚动位置清零、ResizablePane 的可用宽量成 0、
//   每个 ResizeObserver 都抖一遍,切回时等于半次重挂。
// absolute + inset:0:不占同级 flex 位置,尺寸仍与可见时一致(父容器要 position:relative 当 containing block)。
// visibility:hidden 对 IntersectionObserver 的几何判定无效(还是「相交」)⇒ 「看见即已读」这类副作用
//   必须由面板自己按可见性门控(ChatAreaPanel.handleMessageVisible)。挡鼠标的是 visibility:hidden(不可见的元素不接点击),
//   挡焦点的是 inert;pointer-events:none 挡不住后代(后代写 pointer-events:auto 照样接点击)。
// ❌ 面里的任何后代显式写 visibility:visible(含「显示态」写 'visible'、Tailwind `visible`):visibility 可被后代改回,
//   那一块会在藏起来的面里照画,盖在同一位置正在显示的面上(61.1 切回任务只换标题、终端是别的任务的)。显示态不写,继承。
export const RETAINED_SURFACE_HIDDEN_STYLE: CSSProperties = { position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' }
