// #6597 Windows 的窗口按钮住进独立的标题栏行:内容区不再给它们让位,纵向整体让出一行。
import { describe, expect, it } from 'vitest'
import {
  hasCustomWindowControls,
  hasWindowTitlebarRow,
  TITLEBAR_ACTION_EDGE_GAP_PX,
  TITLEBAR_ACTIONS_LANE_PX,
  titlebarActionsLane,
  titlebarActionsRight,
  WINDOW_CONTROLS_WIDTH_PX,
  WINDOW_TITLEBAR_HEIGHT_PX,
  windowControlsWidth,
  windowTitlebarHeight,
} from '../../../../apps/desktop/src/lib/window-chrome'

describe('window-chrome 标题栏行(#6597)', () => {
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
    // 预留随之与 mac 同形:只剩边缘呼吸,不再多出 138px
    expect(titlebarActionsRight('win')).toBe(TITLEBAR_ACTION_EDGE_GAP_PX)
    expect(titlebarActionsRight('win')).toBe(titlebarActionsRight('mac'))
    expect(titlebarActionsRight('linux') - titlebarActionsRight('mac')).toBe(WINDOW_CONTROLS_WIDTH_PX)
  })

  it('转瞬层车道在有标题栏行的平台整体下移一行', () => {
    expect(titlebarActionsLane('win')).toBe(WINDOW_TITLEBAR_HEIGHT_PX + TITLEBAR_ACTIONS_LANE_PX)
    expect(titlebarActionsLane('linux')).toBe(TITLEBAR_ACTIONS_LANE_PX)
    expect(titlebarActionsLane('mac')).toBe(TITLEBAR_ACTIONS_LANE_PX)
  })
})
