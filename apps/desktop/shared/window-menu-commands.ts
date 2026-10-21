/**
 * @@@win-titlebar-row — Windows 标题栏里「编辑 / 视图」菜单能下给窗口的命令(WindowTitleBar.tsx → preload
 * `desktopWindow.runMenuCommand` → main 的 `window:menu-command`)。渲染层与主进程共读这一份清单;
 * 主进程收到清单外的字符串一律拒收并记错,❌ 当方法名去调。执行在 electron/window-menu-commands.ts。
 */
export const WINDOW_MENU_COMMANDS = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'toggleFullScreen',
] as const

export type WindowMenuCommand = (typeof WINDOW_MENU_COMMANDS)[number]

export function isWindowMenuCommand(value: unknown): value is WindowMenuCommand {
  return typeof value === 'string' && (WINDOW_MENU_COMMANDS as readonly string[]).includes(value)
}
