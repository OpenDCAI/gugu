// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * owner 10-28:看 / 接管 agent 浏览器的地方 = Browser Use App 的每任务一份页签(宿主页 hostPage: 'browser')。
 * 这台电脑上的任务只指到它自带的「浏览器」页签;咕咕 server 上的任务画那台机器的 Chrome,
 * 这个任务请人登录时,只提供接管网页的路径。
 */
const fx = vi.hoisted(() => {
  const tabs = [{ tabId: 'T1', title: '京东', url: 'https://www.jd.com/', byAgent: true }]
  const baseStatus: Record<string, unknown> = {
    available: true,
    running: true,
    tabs,
    activeTabId: 'T1',
    automation: 'idle',
    completed: false,
    controlled: false,
    lastActivityAt: null,
    live: { port: 4321, token: 't' },
  }
  const baseState: Record<string, unknown> = { type: 'state', running: true, tabs, activeTabId: 'T1', automation: 'idle', completed: false, control: 'released' }
  return {
    baseStatus,
    baseState,
    machine: { kind: 'local' } as Record<string, unknown>,
    openTaskBrowser: vi.fn(() => true),
    respond: vi.fn(async (_answer: unknown) => ({ ok: true })),
    asks: {} as Record<string, unknown>,
    status: baseStatus,
    state: baseState,
  }
})

vi.mock('../../../../apps/desktop/src/components/browserUse/browserUsePlace', () => ({
  browserUseMachine: () => fx.machine,
  openTaskBrowser: fx.openTaskBrowser,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/use-session-host-ask', () => ({
  useSessionHostAsk: (sessionId: string | null) => (sessionId ? fx.asks[sessionId] ?? null : null),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  rpc: {},
  rpcOn: () => ({ sessionTimeline: { sessionRespond: fx.respond } }),
}))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({
  Sheet: ({ children, testId }: { children: ReactNode; testId?: string }) => <div role="dialog" data-testid={testId}>{children}</div>,
}))
vi.mock('../../../../apps/desktop/src/lib/cloudHostSuspended', () => ({ cloudHostSuspended: () => false }))
vi.mock('../../../../apps/desktop/src/lib/browserUseLink', () => {
  class CloudBrowserCallError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
    }
  }
  class CloudBrowserLink {
    constructor(_deviceId: string, _endpoint: unknown, private readonly handlers: { onState: (s: string) => void; onMessage: (m: unknown) => void }) {}
    start() {
      this.handlers.onState('open')
      this.handlers.onMessage(fx.state)
    }
    send() {
      return true
    }
    reconnect() {}
    dispose() {}
  }
  return {
    canOpenLiveBrowser: () => true,
    CloudBrowserCallError,
    CloudBrowserLink,
    fetchCloudBrowserStatus: async () => fx.status,
    fetchCloudBrowserSnapshot: async () => null,
  }
})

import { BrowserUseHostPage } from '../../../../apps/desktop/src/components/browserUse/BrowserUseHostPage'

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve() })
}
const vault = () => document.querySelector('[data-testid="browser-use-vault"]')
const server = { kind: 'server', deviceId: 'server-1', label: '云电脑', online: true, direct: true }
const loginAsk = {
  itemId: 'ask-1',
  state: 'pending',
  kind: 'permission',
  options: [{ optionId: 'done', name: 'Done', kind: 'allow_once' }, { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }],
  origin: { source: 'browser-assistance', payload: { kind: 'login', site: 'https://www.jd.com', url: 'https://passport.jd.com/' } },
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fx.asks = {}
  fx.status = { ...fx.baseStatus }
  fx.state = { ...fx.baseState }
  fx.openTaskBrowser.mockClear()
  fx.respond.mockClear()
})
afterEach(() => {
  harness.cleanup()
})

describe('Browser Use host page', () => {
  it('a task on this computer: one line pointing to its own Browser tab, and no second picture', async () => {
    fx.machine = { kind: 'local' }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    expect(harness.container.textContent).toContain('它用的浏览器就是任务里的「浏览器」页签')
    expect(harness.container.querySelector('canvas')).toBeNull()
    const open = harness.container.querySelector<HTMLButtonElement>('[data-testid="browser-use-open-local"]')!
    await act(async () => open.click())
    expect(fx.openTaskBrowser).toHaveBeenCalledWith('s1')
  })

  it('a page in no task says so', async () => {
    await harness.render(createNode(BrowserUseHostPage, { sessionId: null, active: true }))
    expect(harness.container.textContent).toContain('这个页签属于一个任务')
  })

  it('a task on another desktop, or on an offline server, is said as it is', async () => {
    fx.machine = { kind: 'desktop', label: '办公室 Mac' }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    expect(harness.container.textContent).toContain('另一台电脑「办公室 Mac」')
    // Observer components skip a re-render with the same props: the offline machine is a fresh mount.
    harness.cleanup()
    harness = createReactHarness()
    fx.machine = { ...server, online: false }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    expect(harness.container.textContent).toContain('「云电脑」现在不在线')
  })

  it('a task on a server: its Chrome, its tabs and take control', async () => {
    fx.machine = server
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    await settle()
    expect(harness.container.querySelector('[data-testid="browser-use-page"]')).not.toBeNull()
    expect(harness.container.querySelector('[role="tab"]')?.textContent).toContain('京东')
    expect(harness.container.textContent).toContain('接管浏览器')
    expect(harness.container.textContent).toContain('停止任务')
  })

  it('no Chrome there / Chrome not open: one honest line each', async () => {
    fx.machine = server
    fx.status = { ...fx.status, available: false }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    await settle()
    expect(harness.container.textContent).toContain('「云电脑」上没有可用的 Chrome')
    harness.cleanup()
    harness = createReactHarness()
    fx.status = { ...fx.status, available: true, running: false }
    fx.state = { ...fx.state, running: false }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    await settle()
    expect(harness.container.textContent).toContain('浏览器还没打开')
  })

  it('a pending login offers browser takeover without opening the removed credential form', async () => {
    fx.machine = server
    fx.asks = { s1: loginAsk }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's2', active: true }))
    await settle()
    expect(vault()).toBeNull()
    expect(harness.container.textContent).not.toContain('登录 jd.com')
    harness.cleanup()
    harness = createReactHarness()
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    await settle()
    expect(vault()).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('保存密码')
    expect(harness.container.textContent).not.toContain('保险箱')
    expect(harness.container.textContent).toContain('接管浏览器')
    expect(harness.container.querySelector('[data-browser-use-line]')?.getAttribute('data-browser-use-line')).toBe('needs')
  })

  it('a login can also be done by hand: take control, then Done answers this task’s ask', async () => {
    fx.machine = server
    fx.asks = { s1: loginAsk }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: true }))
    await settle()
    const page = harness.container.querySelector('[data-testid="browser-use-page"]')!
    expect(page.textContent).toContain('登录 jd.com')
    expect(page.textContent).toContain('接管浏览器')
    expect(page.textContent).toContain('在页面上登录')
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="browser-use-done"]')!.click())
    await settle()
    expect(fx.respond).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 's1', itemId: 'ask-1', kind: 'permission', optionId: 'done' }))
  })

  it('an inactive page does not open a credential form', async () => {
    fx.machine = server
    fx.asks = { s1: loginAsk }
    await harness.render(createNode(BrowserUseHostPage, { sessionId: 's1', active: false }))
    await settle()
    expect(vault()).toBeNull()
  })
})
