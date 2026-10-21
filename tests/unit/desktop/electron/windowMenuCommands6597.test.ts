// #6597 Windows 标题栏「编辑 / 视图」菜单下给窗口的命令:清单封闭,缩放步长与应用菜单 role 同值。
import { describe, expect, it, vi } from 'vitest'
import {
  runWindowMenuCommand,
  WINDOW_ZOOM_STEP,
  type WindowMenuCommandTarget,
} from '../../../../apps/desktop/electron/window-menu-commands'
import {
  isWindowMenuCommand,
  WINDOW_MENU_COMMANDS,
} from '../../../../apps/desktop/shared/window-menu-commands'

function fakeTarget(zoomLevel = 0, fullScreen = false) {
  let level = zoomLevel
  let full = fullScreen
  const contents = {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    getZoomLevel: vi.fn(() => level),
    setZoomLevel: vi.fn((next: number) => { level = next }),
  }
  const window = {
    isFullScreen: vi.fn(() => full),
    setFullScreen: vi.fn((next: boolean) => { full = next }),
  }
  const target = { contents, window } as unknown as WindowMenuCommandTarget
  return { target, contents, window, zoom: () => level, fullScreen: () => full }
}

describe('window menu commands(#6597)', () => {
  it('清单外的字符串一律不是命令 —— 尤其不能是 webContents 上的任意方法名', () => {
    for (const command of WINDOW_MENU_COMMANDS) expect(isWindowMenuCommand(command)).toBe(true)
    for (const bogus of ['openDevTools', 'reload', 'executeJavaScript', 'close', '', 'Undo', null, 1, { command: 'undo' }]) {
      expect(isWindowMenuCommand(bogus)).toBe(false)
    }
  })

  it('编辑类命令各自落到 webContents 上的同名编辑命令,且只落这一个', () => {
    for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const) {
      const { target, contents } = fakeTarget()
      runWindowMenuCommand(command, target)
      for (const method of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const) {
        expect(contents[method]).toHaveBeenCalledTimes(method === command ? 1 : 0)
      }
      expect(contents.setZoomLevel).not.toHaveBeenCalled()
    }
  })

  it('缩放:与应用菜单 zoomIn / zoomOut role 同一步长 0.5,实际大小 = 0 级', () => {
    expect(WINDOW_ZOOM_STEP).toBe(0.5)
    const f = fakeTarget(1)
    runWindowMenuCommand('zoomIn', f.target)
    expect(f.zoom()).toBe(1.5)
    runWindowMenuCommand('zoomOut', f.target)
    runWindowMenuCommand('zoomOut', f.target)
    expect(f.zoom()).toBe(0.5)
    runWindowMenuCommand('resetZoom', f.target)
    expect(f.zoom()).toBe(0)
  })

  it('全屏是开关:当前全屏就退出,否则进入', () => {
    const f = fakeTarget(0, false)
    runWindowMenuCommand('toggleFullScreen', f.target)
    expect(f.fullScreen()).toBe(true)
    runWindowMenuCommand('toggleFullScreen', f.target)
    expect(f.fullScreen()).toBe(false)
  })
})
