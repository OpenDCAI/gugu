// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBottomDock } from '../../../../apps/desktop/src/components/chat/ChatBottomDock'
import { RunningBarSlot } from '../../../../apps/desktop/src/components/RunningTokenBar'
import { createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let observers: { report: () => void; targets: Element[]; disconnect: () => void }[]
beforeEach(() => {
  harness = createReactHarness()
  observers = []
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(report: () => void) { this.record = { report, targets: [], disconnect: vi.fn() }; observers.push(this.record) }
    observe(target: Element) { this.record.targets.push(target) }
    disconnect() { this.record.disconnect() }
  })
})
afterEach(async () => { await harness.cleanup(); vi.unstubAllGlobals() })

describe('avatar boundary follows visible dock cards, independently of the reserved running row', () => {
  it('uses one observer for all four bar states, including preview changes that leave dock height unchanged', async () => {
    const render = (reply: boolean, preview: boolean) => harness.render(createElement('div', { 'data-column': '' },
      createElement(ChatBottomDock, { floating: true, reserve: false,
        above: createElement(RunningBarSlot, { children: preview ? createElement('span', { 'data-chat-dock-obstacle': '' }, 'running') : null }),
        children: createElement('div', null, reply ? 'reply and input' : 'input'),
      })))
    await render(false, false)
    const column = harness.container.querySelector<HTMLElement>('[data-column]')!
    const dock = column.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
    const input = dock.lastElementChild as HTMLElement
    let height = 160
    Object.defineProperty(dock, 'offsetHeight', { get: () => height })
    Object.defineProperty(input, 'offsetTop', { get: () => 42 })
    for (const [reply, preview, expected] of [[false, false, 118], [true, false, 180], [false, true, 152], [true, true, 214], [false, false, 118]] as const) {
      await render(reply, preview)
      height = reply ? 222 : 160
      const pill = dock.querySelector<HTMLElement>('[data-chat-dock-obstacle]')
      if (pill) {
        Object.defineProperty(pill, 'offsetTop', { configurable: true, get: () => 8 })
        Object.defineProperty(pill, 'offsetParent', { configurable: true, get: () => dock })
      }
      await act(async () => observers[0].report())
      expect(column.style.getPropertyValue('--chat-dock-h')).toBe(`${height}px`)
      expect(column.style.getPropertyValue('--chat-dock-avatar-h')).toBe(`${expected}px`)
    }
    expect(observers).toHaveLength(1)
    expect(observers[0].targets).toEqual([dock, dock.querySelector('[data-running-bar-content]')])
    await harness.render(null)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(column.style.getPropertyValue('--chat-dock-avatar-h')).toBe('')
  })

  it('leaves the non-floating phone stack in normal flow without measuring or publishing a dock offset', async () => {
    await harness.render(createElement(ChatBottomDock, { floating: false, reserve: false, above: createElement('div', null, 'preview'), children: createElement('div', null, 'input') }))
    expect(observers).toHaveLength(0)
    expect(harness.container.querySelector('[data-chat-bottom-dock]')).toBeNull()
    expect(harness.container.textContent).toBe('previewinput')
  })

  it('observes the running content when switching from a human DM to a group without remounting the dock', async () => {
    const render = (group: boolean) => harness.render(createElement(ChatBottomDock, { floating: true, reserve: false,
      above: group && createElement(RunningBarSlot, { children: null }), children: createElement('div', null, 'input') }))
    await render(false)
    expect(observers[0].targets).toHaveLength(1)
    await render(true)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    expect(observers[1].targets[1]).toBe(harness.container.querySelector('[data-running-bar-content]'))
  })
})
