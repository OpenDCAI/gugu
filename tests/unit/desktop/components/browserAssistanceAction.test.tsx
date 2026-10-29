// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * agent 请人替它登录 / 接手浏览器(`browser-assistance`):那一问的主入口打开这个任务的 Browser Use 页签;
 * 没装 / 停用了就照实说、指到 App 的那一页,❌ 一个点了没反应的按钮。手机上没有这个入口。
 */
const fx = vi.hoisted(() => ({
  state: 'ready' as 'ready' | 'disabled' | 'missing',
  mobile: false,
  open: vi.fn(async () => {}),
  followLink: vi.fn(() => true),
}))

vi.mock('../../../../apps/desktop/src/components/browserUse/browserUseApp', () => ({
  BROWSER_USE_APP_ID: 'browser-use',
  browserUseTab: () => ({ state: fx.state, tab: fx.state === 'missing' ? null : { extensionId: 'browser-use', kind: 'browser-use.browser', enabled: fx.state === 'ready' } }),
  isBrowserAssistance: (settlement: { origin?: { source?: string } } | null) => settlement?.origin?.source === 'browser-assistance',
}))
vi.mock('../../../../apps/desktop/src/components/browserUse/browserUsePlace', () => ({ openBrowserUseTab: fx.open }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink: fx.followLink }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: vi.fn() }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => fx.mobile }))

import { BrowserAssistanceAction } from '../../../../apps/desktop/src/components/browserUse/BrowserAssistanceAction'

const login = { origin: { source: 'browser-assistance', payload: { kind: 'login', site: 'https://www.jd.com' } } }
const takeover = { origin: { source: 'browser-assistance', payload: { kind: 'takeover', text: '输入短信验证码' } } }

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  fx.state = 'ready'
  fx.mobile = false
  fx.open.mockClear()
  fx.followLink.mockClear()
})
afterEach(() => {
  harness.cleanup()
})

const button = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="browser-assistance-action"] button')

describe('browser-assistance ask: the way to the task’s Browser Use tab', () => {
  it('a login ask opens this task’s Browser Use tab', async () => {
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: login }))
    expect(button()?.textContent).toContain('在 Browser Use 里查看')
    await act(async () => button()!.click())
    await vi.waitFor(() => expect(fx.open).toHaveBeenCalledWith('task-1'))
  })

  it('a takeover ask opens it to watch', async () => {
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: takeover }))
    expect(button()?.textContent).toContain('在 Browser Use 里查看')
  })

  it('without the App, or with it off: says so and goes to its App page', async () => {
    fx.state = 'missing'
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: login }))
    expect(harness.container.textContent).toContain('要装上 Browser Use App')
    await act(async () => button()!.click())
    expect(fx.followLink).toHaveBeenCalledWith({ kind: 'app-detail', extensionId: 'browser-use' })
    expect(fx.open).not.toHaveBeenCalled()
    // Observer components skip a re-render with the same props: the switched-off App is a fresh mount.
    harness.cleanup()
    harness = createReactHarness()
    fx.state = 'disabled'
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: login }))
    expect(harness.container.textContent).toContain('Browser Use App 已停用')
  })

  it('nothing for another kind of ask, and nothing on the phone', async () => {
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: { origin: { source: 'app-install' } } }))
    expect(harness.container.innerHTML).toBe('')
    harness.cleanup()
    harness = createReactHarness()
    fx.mobile = true
    await harness.render(createNode(BrowserAssistanceAction, { sessionId: 'task-1', settlement: login }))
    expect(harness.container.innerHTML).toBe('')
  })
})
