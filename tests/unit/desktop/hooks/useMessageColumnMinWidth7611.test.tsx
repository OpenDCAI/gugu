// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useMessageColumnMinWidth } from '../../../../apps/desktop/src/components/chat/useMessageColumnMinWidth'

let harness: ReturnType<typeof createReactHarness>
let rowWidth = 968
const resizeCallbacks = new Set<() => void>()

function Probe({ open = true, mobile = false }: { open?: boolean; mobile?: boolean }) {
  const { messageColumnMinWidth, attachPanelsRow } = useMessageColumnMinWidth(open, mobile)
  return createElement('div', { ref: attachPanelsRow, 'data-min-width': messageColumnMinWidth })
}

beforeEach(() => {
  rowWidth = 968
  resizeCallbacks.clear()
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback; resizeCallbacks.add(callback) }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback) }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width: rowWidth }))
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

const minWidth = () => Number(harness.container.firstElementChild!.getAttribute('data-min-width'))

describe('窄窗消息列的可用宽度', () => {
  it('窗口缩窄时保住输入区,放大后恢复理想宽度', async () => {
    await harness.render(createElement(Probe))
    expect(minWidth()).toBe(380)
    await act(async () => { rowWidth = 528; resizeCallbacks.forEach((resize) => resize()) })
    expect(harness.container.firstElementChild!.getBoundingClientRect().width).toBe(528)
    expect(minWidth()).toBe(240)
    expect(rowWidth - minWidth()).toBeGreaterThanOrEqual(280)
    await act(async () => { rowWidth = 968; resizeCallbacks.forEach((resize) => resize()) })
    expect(minWidth()).toBe(380)
  })

  it('关掉右栏恢复正文宽度,极窄聊天面不撑破自身', async () => {
    rowWidth = 528
    await harness.render(createElement(Probe))
    expect(minWidth()).toBe(240)
    await harness.render(createElement(Probe, { open: false }))
    expect(minWidth()).toBe(380)
    await act(async () => { rowWidth = 220; resizeCallbacks.forEach((resize) => resize()) })
    expect(minWidth()).toBe(220)
    await harness.render(createElement(Probe, { open: true }))
    expect(minWidth()).toBe(220)
  })

  it('手机仍由整页面板布局,不设置消息列地板', async () => {
    await harness.render(createElement(Probe))
    expect(minWidth()).toBe(380)
    await harness.render(createElement(Probe, { mobile: true }))
    expect(minWidth()).toBe(0)
  })
})
