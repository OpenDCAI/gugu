// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import type { CloudBrowserState } from '../../../../apps/desktop/src/session/shared/cloud-browser'

const view = vi.hoisted(() => ({ state: null as unknown }))

vi.mock('../../../../apps/desktop/src/components/cloudBrowser/useCloudBrowser', () => ({
  useCloudBrowser: () => ({
    live: true,
    status: null,
    state: view.state,
    linkState: 'open',
    frame: null,
    shown: true,
    send: vi.fn(() => true),
    ack: vi.fn(),
    reconnect: vi.fn(),
    dismiss: vi.fn(),
    onServerMessage: () => () => {},
  }),
}))

import { CloudBrowserCard } from '../../../../apps/desktop/src/components/cloudBrowser/CloudBrowserCard'

const browsing: CloudBrowserState = {
  type: 'state',
  running: true,
  tabs: [{ tabId: 'T1', title: 'Example Domain', url: 'https://example.com/', byAgent: true }],
  activeTabId: 'T1',
  automation: 'running',
  completed: false,
  control: 'released',
  assistance: null,
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})

/** #7199 人只认识助理:小窗说「个人助理的浏览器」「实时 · 个人助理正在浏览」,❌「Agent」、❌「云电脑」。 */
describe('#7199 cloud browser card copy', () => {
  it('标题和状态说的是聊天对象的名字', async () => {
    view.state = browsing
    await harness.render(createNode(CloudBrowserCard, { deviceId: 'device-1', agentName: '个人助理' }))
    const text = harness.container.textContent ?? ''
    expect(harness.container.querySelector('.cb-title')?.textContent).toBe('个人助理的浏览器')
    expect(harness.container.querySelector('.cb-line')?.textContent).toBe('实时 · 个人助理正在浏览')
    expect(text).not.toMatch(/Agent|云电脑/)
  })

  it('接管中:主按钮是「交还给个人助理」', async () => {
    view.state = { ...browsing, automation: 'idle', control: 'granted' }
    await harness.render(createNode(CloudBrowserCard, { deviceId: 'device-1', agentName: '个人助理' }))
    expect(harness.container.textContent).toContain('交还给个人助理')
    expect(harness.container.textContent).not.toMatch(/Agent|云电脑/)
  })

  it('还不知道名字:说「助理」', async () => {
    view.state = browsing
    await harness.render(createNode(CloudBrowserCard, { deviceId: 'device-1', agentName: '  ' }))
    expect(harness.container.querySelector('.cb-title')?.textContent).toBe('助理的浏览器')
  })
})
