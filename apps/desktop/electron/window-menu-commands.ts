import type { BrowserWindow, WebContents } from 'electron'
import type { WindowMenuCommand } from '../shared/window-menu-commands'

/**
 * @@@win-titlebar-row — 执行 Windows 标题栏「编辑 / 视图」菜单的命令(清单在 shared/window-menu-commands.ts)。
 *
 * 为什么走主进程:这些菜单是渲染层画的,点下去的那一刻焦点在菜单上。渲染层先把焦点还给原来的输入框,
 * 再由这里对**发起窗口**的 webContents 下命令 —— 与原生应用菜单的 role 同一条路(role:'paste' 就是
 * webContents.paste())。❌ 渲染层 document.execCommand('paste'):没有剪贴板读权限,静默什么也不做。
 */

/** 与 Electron 应用菜单 zoomIn / zoomOut role 同一步长;实际大小 = 0 级(主窗口 zoomFactor 1.0)。 */
export const WINDOW_ZOOM_STEP = 0.5

export type WindowMenuCommandTarget = {
  contents: Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'getZoomLevel' | 'setZoomLevel'>
  window: Pick<BrowserWindow, 'isFullScreen' | 'setFullScreen'>
}

export function runWindowMenuCommand(command: WindowMenuCommand, { contents, window }: WindowMenuCommandTarget): void {
  switch (command) {
    case 'undo': contents.undo(); return
    case 'redo': contents.redo(); return
    case 'cut': contents.cut(); return
    case 'copy': contents.copy(); return
    case 'paste': contents.paste(); return
    case 'selectAll': contents.selectAll(); return
    case 'zoomIn': contents.setZoomLevel(contents.getZoomLevel() + WINDOW_ZOOM_STEP); return
    case 'zoomOut': contents.setZoomLevel(contents.getZoomLevel() - WINDOW_ZOOM_STEP); return
    case 'resetZoom': contents.setZoomLevel(0); return
    case 'toggleFullScreen': window.setFullScreen(!window.isFullScreen()); return
  }
}
