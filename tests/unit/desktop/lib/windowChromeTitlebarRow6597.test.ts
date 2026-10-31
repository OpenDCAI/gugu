// #6597 Windows 的窗口按钮住进独立的标题栏行:内容区不再给它们让位,纵向整体让出一行。
import { describe, expect, it } from 'vitest'
import {
  hasCustomWindowControls,
  hasWindowTitlebarRow,
  rendererPlatformFor,
  TITLEBAR_ACTIONS_LANE_PX,
  titlebarActionsLane,
  WINDOW_CONTROLS_WIDTH_PX,
  WINDOW_TITLEBAR_HEIGHT_PX,
  windowControlsWidth,
  windowTitlebarHeight,
} from '../../../../apps/desktop/src/lib/window-chrome'

describe('window-chrome 标题栏行(#6597)', () => {
  it('desktop app is told apart by its preload bridge, not by an Electron token in the UA (#146 strips it)', () => {
    const bridge = { minimize() {} }
    for (const os of ['win', 'mac', 'linux'] as const) expect(rendererPlatformFor(os, bridge)).toBe(os)
    // web build: same OS, no bridge
    for (const os of ['win', 'mac', 'linux', 'other'] as const) expect(rendererPlatformFor(os, undefined)).toBe('other')
    expect(rendererPlatformFor('other', bridge)).toBe('other')
    expect(hasWindowTitlebarRow(rendererPlatformFor('win', bridge))).toBe(true)
  })

  it('只有 Windows 有标题栏行;Windows 仍然自绘窗口按钮', () => {
    expect(hasWindowTitlebarRow('win')).toBe(true)
    expect(hasCustomWindowControls('win')).toBe(true)
    for (const platform of ['linux', 'mac', 'other', undefined]) {
      expect(hasWindowTitlebarRow(platform)).toBe(false)
      expect(windowTitlebarHeight(platform)).toBe(0)
    }
    expect(windowTitlebarHeight('win')).toBe(WINDOW_TITLEBAR_HEIGHT_PX)
  })

  it('窗口按钮不压内容 ⇒ Windows 的让位宽度为 0;Linux 仍浮在内容上、照旧让位', () => {
    expect(windowControlsWidth('win')).toBe(0)
    expect(windowControlsWidth('linux')).toBe(WINDOW_CONTROLS_WIDTH_PX)
    expect(windowControlsWidth('mac')).toBe(0)
  })

  it('转瞬层车道在有标题栏行的平台整体下移一行', () => {
    expect(titlebarActionsLane('win')).toBe(WINDOW_TITLEBAR_HEIGHT_PX + TITLEBAR_ACTIONS_LANE_PX)
    expect(titlebarActionsLane('linux')).toBe(TITLEBAR_ACTIONS_LANE_PX)
    expect(titlebarActionsLane('mac')).toBe(TITLEBAR_ACTIONS_LANE_PX)
  })
})
