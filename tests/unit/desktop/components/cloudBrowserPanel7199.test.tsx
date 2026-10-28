// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { CloudBrowserState } from '../../../../apps/desktop/src/session/shared/cloud-browser'

const view = vi.hoisted(() => ({ state: null as unknown, open: true, send: null as unknown }))

vi.mock('../../../../apps/desktop/src/components/cloudBrowser/useCloudBrowser', () => ({
  useCloudBrowser: () => ({
    live: true,
    status: null,
    state: view.state,
    linkState: 'open',
    frame: null,
    open: view.open,
    send: view.send,
    ack: vi.fn(),
    reconnect: vi.fn(),
    onServerMessage: () => () => {},
  }),
}))

import { CloudBrowserPanel } from '../../../../apps/desktop/src/components/cloudBrowser/CloudBrowserPanel'

const browsing: CloudBrowserState = {
  type: 'state',
  running: true,
  tabs: [{ tabId: 'T1', title: 'Example Domain', url: 'https://example.com/', byAgent: true }],
  activeTabId: 'T1',
  automation: 'running',
  completed: false,
  control: 'released',
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  view.open = true
  view.send = vi.fn(() => true)
})
afterEach(() => {
  harness.cleanup()
})

const props = { deviceId: 'device-1', sessionId: 'session-1', agentName: '个人助理' }

function button(label: string): HTMLButtonElement | undefined {
  return [...harness.container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
}

/**
 * #7199 server 上的 agent 的浏览器只在任务页「浏览器」页签里(owner 10-28,聊天页不再浮小窗):
 * 画面、接管 / 交还、停止都在这一块;浏览器没开 = 空状态说一句。人只认识助理:❌「Agent」、❌「云电脑」。
 */
describe('#7199 cloud browser panel (task page tab)', () => {
  it('浏览器没开:空状态说一句,没有接管、停止', async () => {
    view.open = false
    view.state = null
    await harness.render(createNode(CloudBrowserPanel, props))
    expect(harness.container.querySelector('[data-cloud-browser-panel]')?.getAttribute('data-state')).toBe('empty')
    expect(harness.container.textContent).toContain('个人助理还没打开浏览器')
    expect(button('接管浏览器')).toBeUndefined()
    expect(button('停止任务')).toBeUndefined()
  })

  it('在浏览:标题是页面标题,状态说聊天对象的名字;接管、停止都在', async () => {
    view.state = browsing
    await harness.render(createNode(CloudBrowserPanel, props))
    expect(harness.container.querySelector('.cb-big-title')?.textContent).toBe('Example Domain')
    expect(harness.container.querySelector('.cb-line')?.textContent).toBe('实时 · 个人助理正在浏览 · https://example.com/')
    expect(button('停止任务')).toBeDefined()
    expect(harness.container.textContent).not.toMatch(/Agent|云电脑/)
  })

  it('点「接管浏览器」就地申请控制权(❌ 再弹大窗)', async () => {
    view.state = browsing
    await harness.render(createNode(CloudBrowserPanel, props))
    button('接管浏览器')?.click()
    expect(view.send).toHaveBeenCalledWith({ type: 'control_acquire' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('接管中:主按钮是「交还给个人助理」', async () => {
    view.state = { ...browsing, automation: 'idle', control: 'granted' }
    await harness.render(createNode(CloudBrowserPanel, props))
    expect(button('交还给个人助理')).toBeDefined()
    expect(harness.container.textContent).not.toMatch(/Agent|云电脑/)
  })

  it('还不知道名字:说「助理」', async () => {
    view.open = false
    await harness.render(createNode(CloudBrowserPanel, { ...props, agentName: '  ' }))
    expect(harness.container.textContent).toContain('助理还没打开浏览器')
  })
})
