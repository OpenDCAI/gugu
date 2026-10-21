import { hasWindowTitlebarRow, readRendererPlatform } from '@/lib/window-chrome';

/**
 * 侧栏顶端那条 40px 的空带。
 *
 * 它做两件事:给无边框窗口留一条可拖动的把手,以及给浮在会话页左上角的那枚**唯一**侧栏开关
 * (<ShellSidebarToggle>,挂在 workspace-layout.tsx 的根部)让出位置。
 * Windows 上这两样都归标题栏行(#6753,拖拽区在 tokens.css 的 @@@win-titlebar-row 里退订),
 * 这条带里什么都不剩 ⇒ 只留与侧栏左右同宽的一道边距(sidebarGroupInsetX 的 px-3)。
 *
 * ⚠️ 这里原先还放着一枚右对齐的折叠钮 —— 侧栏展开时用它、收起时换成主区左上角那枚。同一个功能
 * 两个坐标,点完一下手就得去别处找。owner 2026-09-10 定:同一枚按钮在任何状态下都必须落在同一个
 * 屏幕坐标。❌ 别再往这条带里加第二枚开关。
 */
export function SidebarSpace() {
  if (hasWindowTitlebarRow(readRendererPlatform())) {
    return <div className="h-3 w-full shrink-0" data-sidebar-space="" />;
  }
  return <div className="h-10 w-full shrink-0 [-webkit-app-region:drag]" data-sidebar-space="" />;
}
