/**
 * @@@panel-header-bar-single-source — 会话页右侧面板顶栏那一条横带的唯一出处。
 *
 * 「面板顶栏」= 页签条底下、面板内容之上的那一条(diff 工具条、文件内容工具条、
 * 文件浏览器头、草稿工作区头、浏览器工具条)。它们注册在**同一个页签槽**里
 * (`features/sessions/session-tab-registry.tsx`),切页签时互相替换 —— 所以高度只要差 1px,
 * 下面整块内容就跟着跳一格。
 *
 * **41 = 40 内容 + 1px 分隔线**。40 是窗口顶栏那条拖拽带的高度
 * (`@/lib/window-chrome` 的 `WINDOW_CONTROL_BAR_HEIGHT_PX`,页签条本身就取它),
 * 面板顶栏接在它下面、自带一条 `border-b`,所以总高多出那条发丝线的 1px,
 * 内容仍然是 40。⚠️ Tailwind 是 border-box,`h-10 + border-b` 得到的是
 * **39 内容 + 1 线**,不是 40 —— 这正是 `browser-toolbar` 以前比同侪矮 1px 的原因。
 *
 * ❌ 别再在各自的组件里写 `h-[41px] … border-b border-border bg-background-secondary-1 px-2`:
 * 2026-09-05 普查时这一串在五个文件里各写了一遍,其中一个还写错了高度。
 * 差异项(`justify-between`、`gap-*`)由调用点通过 `cn()` 追加。
 *
 * 不归本常量管的一条:`create-session-modal/modal-context-bar` 是 `border-t`(它贴在弹窗底部,
 * 线在上边)。高度仍然是同一个 41,但边框方向不同,套这个常量会说谎。
 *
 * ⚠️ **页签条不是面板顶栏。**`draft-tab-strip` 曾经长得像这一条(41px + border-b +
 * bg-background-secondary),那正是它读起来「像工具条,不像页签条」的原因(#6107 C-04);
 * 它现在走 <TabStripShell> —— 40px、无 border-b、bg-tab-strip。❌ 别把页签条套回这个常量。
 */
export const PANEL_HEADER_BAR_HEIGHT_PX = 41

export const panelHeaderBarClass =
  'gg-panel-header flex h-[41px] shrink-0 items-center border-b border-border bg-background-secondary-1 px-2'
