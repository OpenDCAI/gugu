// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * 任务在咕咕 server 上、它的浏览器开始干活(没开 → 开了,或这个任务来了一问「请你登录 / 接手」):Browser Use 页签替人
 * 加到页签条上,❌ 抢焦点;每个任务一次,人关掉了不再开;没装 / 停用了 Browser Use 什么都不做。
 */
const fx = vi.hoisted(() => ({
  state: 'ready' as 'ready' | 'disabled' | 'missing',
  view: null as null | { paneLayout: { groups: { pane: { resolvedTabs: { kind: string }[] } }[]; windowPanes: Map<string, unknown>; open: ReturnType<typeof vi.fn> } },
  running: [] as boolean[],
  ask: null as unknown,
}))

vi.mock('../../../../apps/desktop/src/components/browserUse/browserUseApp', () => ({
  browserUseTab: () => ({ state: fx.state, tab: fx.state === 'missing' ? null : { kind: 'browser-use.browser', extensionId: 'browser-use', enabled: fx.state === 'ready' } }),
}))
vi.mock('../../../../apps/desktop/src/components/browserUse/browserUsePlace', () => ({
  taskView: () => fx.view ?? undefined,
  browserUseMachine: () => ({ kind: 'server', deviceId: 'cloud', label: '云电脑', online: true, direct: true }),
}))
vi.mock('../../../../apps/desktop/src/lib/browserUseLink', () => ({
  fetchCloudBrowserStatus: async () => ({ available: true, running: fx.running.length > 1 ? fx.running.shift() : fx.running[0] ?? false }),
}))
vi.mock('../../../../apps/desktop/src/lib/cloudHostSuspended', () => ({ cloudHostSuspended: () => false }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/use-session-host-ask', () => ({ useSessionHostAsk: () => fx.ask }))

import { autoOpenBrowserUseTab } from '../../../../apps/desktop/src/components/browserUse/browserUseAutoOpenRules'
import { BrowserUseAutoOpen } from '../../../../apps/desktop/src/components/browserUse/BrowserUseAutoOpen'
// The watch BrowserUseAutoOpen loads lazily: loaded up front here, so the lazy import settles at once.
import '../../../../apps/desktop/src/components/browserUse/BrowserUseServerWatch'

function view(kinds: string[] = []) {
  return { paneLayout: { groups: [{ pane: { resolvedTabs: kinds.map((kind) => ({ kind })) } }], windowPanes: new Map(), open: vi.fn() } }
}
function memory() {
  const seen = new Set<string>()
  return { has: (id: string) => seen.has(id), add: (id: string) => void seen.add(id) }
}
const BACKGROUND = { preview: false, activate: false }

beforeEach(() => {
  fx.state = 'ready'
  fx.view = view()
  fx.running = []
  fx.ask = null
  localStorage.clear()
})

describe('adding the task’s Browser Use tab', () => {
  it('as one more tab on the tab strip — no split, no switching to it — once per task', () => {
    const seen = memory()
    expect(autoOpenBrowserUseTab('task-1', seen)).toBe(true)
    expect(fx.view!.paneLayout.open).toHaveBeenCalledWith('browser-use.browser', {}, BACKGROUND)
    // The person closed it: it stays closed.
    expect(autoOpenBrowserUseTab('task-1', seen)).toBe(false)
    expect(fx.view!.paneLayout.open).toHaveBeenCalledTimes(1)
  })

  it('not when the App is off or missing, nor when the tab is already there', () => {
    fx.state = 'disabled'
    expect(autoOpenBrowserUseTab('task-1', memory())).toBe(false)
    fx.state = 'missing'
    expect(autoOpenBrowserUseTab('task-1', memory())).toBe(false)
    fx.state = 'ready'
    fx.view = view(['browser-use.browser'])
    expect(autoOpenBrowserUseTab('task-1', memory())).toBe(false)
    expect(fx.view.paneLayout.open).not.toHaveBeenCalled()
  })
})

describe('when the task’s browser starts', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })
  const poll = async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  }
  /** Render, then let the lazily loaded watch mount and run its first look. */
  const mount = async () => {
    await harness.render(createNode(BrowserUseAutoOpen, { sessionId: 'task-1' }))
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.dynamicImportSettled()
        await vi.advanceTimersByTimeAsync(0)
      })
    }
  }

  it('the browser going from closed to open adds the tab', async () => {
    fx.running = [false, false, true]
    await mount()
    await poll()
    expect(fx.view!.paneLayout.open).not.toHaveBeenCalled()
    await poll()
    expect(fx.view!.paneLayout.open).toHaveBeenCalledWith('browser-use.browser', {}, BACKGROUND)
  })

  it('a browser already open when the task is opened does not', async () => {
    fx.running = [true]
    await mount()
    await poll()
    await poll()
    expect(fx.view!.paneLayout.open).not.toHaveBeenCalled()
  })

  it('a login / takeover ask of this task adds it', async () => {
    fx.running = [true]
    fx.ask = { itemId: 'ask-1', state: 'pending', origin: { source: 'browser-assistance', payload: { kind: 'login' } } }
    await mount()
    expect(fx.view!.paneLayout.open).toHaveBeenCalledWith('browser-use.browser', {}, BACKGROUND)
  })

  it('nothing without the App', async () => {
    fx.state = 'missing'
    fx.running = [false, true]
    fx.ask = { itemId: 'ask-1' }
    await mount()
    await poll()
    await poll()
    expect(fx.view!.paneLayout.open).not.toHaveBeenCalled()
  })
})
