import { describe, expect, it } from 'vitest'
import { SIDEBAR_TABS } from '@gugu/core/shared/enums/sidebarTabModels'
import { settledTab, tabPosition } from '../../../apps/desktop/src/mobile/settledTab'

// #6730 选中态只在某一页整页对齐时切;拖动中、惯性中不切。
describe('settledTab', () => {
  it('names the page that fills the pager', () => {
    expect(settledTab(0, 390)).toBe('tasks')
    expect(settledTab(390, 390)).toBe('chats')
    expect(settledTab(1170, 390)).toBe('settings')
  })

  it('is null while two pages share the pager', () => {
    expect(settledTab(195, 390)).toBeNull()
    expect(settledTab(391.5, 390)).toBeNull()
  })

  it('accepts the sub-pixel offset a snapped page lands on when the page width is fractional', () => {
    expect(settledTab(3 * 392.7273 + 0.3, 392.7273)).toBe('settings')
  })

  it('is null before layout and past the last page', () => {
    expect(settledTab(0, 0)).toBeNull()
    expect(settledTab(SIDEBAR_TABS.length * 390, 390)).toBeNull()
  })
})

// owner 10-07:横滑时底部 tab 栏的亮暗跟着手指走。这是分页器每一帧交给 tab 栏的连续位置。
describe('tabPosition', () => {
  it('is the page index when a page fills the pager, and fractional while two pages share it', () => {
    expect(tabPosition(0, 390)).toBe(0)
    expect(tabPosition(390, 390)).toBe(1)
    expect(tabPosition(97.5, 390)).toBe(0.25)
    expect(tabPosition(585, 390)).toBe(1.5)
  })

  it('stays between the first and the last page when the pager bounces past either end', () => {
    expect(tabPosition(-40, 390)).toBe(0)
    expect(tabPosition(SIDEBAR_TABS.length * 390, 390)).toBe(SIDEBAR_TABS.length - 1)
  })

  it('is null before layout', () => {
    expect(tabPosition(0, 0)).toBeNull()
  })
})
