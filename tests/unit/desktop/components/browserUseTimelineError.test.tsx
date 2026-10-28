// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * 旧的私聊浏览器卡把会话时间线那条线的错(`record_not_found`)当成浏览器的错摆在卡上。Browser Use 页签里
 * 等人的那一步只读这个任务的时间线:读不到只进日志,浏览器照常画。
 */
const fx = vi.hoisted(() => ({
  warn: vi.fn(),
  status: {
    available: true,
    running: true,
    tabs: [{ tabId: 'T1', title: 'Example', url: 'https://example.com/', byAgent: true }],
    activeTabId: 'T1',
    automation: 'running',
    completed: false,
    controlled: false,
    lastActivityAt: null,
    live: null,
  },
}))

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { remotePorts: {} },
  events: { on: () => () => {} },
  rpcOn: () => ({
    sessionTimeline: {
      sessionSnapshot: async () => {
        throw new Error('record_not_found')
      },
      sessionSubscribe: async () => ({}),
      sessionUnsubscribe: async () => ({}),
    },
  }),
}))
vi.mock('@renderer/utils/logger', () => ({ log: { warn: fx.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => null } }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/app-install-approval', () => ({
  answerAppInstall: vi.fn(),
  answeredTooLate: () => false,
  appInstallWords: vi.fn(),
  sessionWaitsOnApproval: () => false,
}))
vi.mock('../../../../apps/desktop/src/components/browserUse/browserUsePlace', () => ({
  browserUseMachine: () => ({ kind: 'server', deviceId: 'server-1', label: '云电脑', online: true, direct: false }),
  openTaskBrowser: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }))
vi.mock('../../../../apps/desktop/src/lib/cloudHostSuspended', () => ({ cloudHostSuspended: () => false }))
vi.mock('../../../../apps/desktop/src/lib/browserUseLink', () => ({
  canOpenLiveBrowser: () => true,
  CloudBrowserCallError: class extends Error {},
  CloudBrowserLink: class {},
  fetchCloudBrowserStatus: async () => fx.status,
  fetchCloudBrowserSnapshot: async () => null,
}))

import { BrowserUseHostPage } from '../../../../apps/desktop/src/components/browserUse/BrowserUseHostPage'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => {
  harness.cleanup()
})

it('a timeline read failure is logged, never shown as the browser’s error', async () => {
  await harness.render(createNode(BrowserUseHostPage, { sessionId: 'task-1', active: true }))
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
  expect(harness.container.querySelector('[data-testid="browser-use-page"]')).not.toBeNull()
  expect(harness.container.textContent).not.toMatch(/record_not_found/)
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  expect(fx.warn).toHaveBeenCalledWith('Host asks of this session could not be read', expect.objectContaining({ sessionId: 'task-1', error: 'record_not_found' }))
})
