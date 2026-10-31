// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { createNode, createReactHarness } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  showNotification: vi.fn(),
  systemPermissions: ['notifications'] as string[],
  onList: null as null | ((result: { sessions: readonly SessionpageSessionSummary[] }, revision?: number) => void),
  baseline: [] as SessionpageSessionSummary[],
  backgroundWatch: false,
  setBackgroundWatch: vi.fn(async (_label: string | null) => undefined),
}))

// 提醒不该再碰提示条 —— 这个 mock 在这里是**探针**:它被调用一次就说明第二个通道又长回来了。
vi.mock('@/components/toastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('@/platform', () => ({
  platform: {
    get systemPermissions() { return mocks.systemPermissions },
    capabilities: { get backgroundWatch() { return mocks.backgroundWatch } },
    setBackgroundWatch: (label: string | null) => mocks.setBackgroundWatch(label),
    subscribeAppForeground: () => () => undefined,
    showNotification: (...args: unknown[]) => mocks.showNotification(...args),
  },
}))
// 假宿主:订上那一刻推一份整的(协议 8);`mocks.onList` 再推一份整的(合并时整份就是它)。
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  subscribeSessionsList: async () => { mocks.onList?.({ sessions: mocks.baseline }) },
  unsubscribeSessionsList: async () => undefined,
  onLinkChange: () => () => undefined,
  onAgentIdentity: () => () => undefined,
  subscribeSessionsListEvents: (
    _deviceId: string,
    subscriptionId: string,
    onEvent: (event: { subscriptionId: string; full: { projects: []; sessions: readonly SessionpageSessionSummary[] } }) => void,
  ) => {
    mocks.onList = (result) => onEvent({ subscriptionId, full: { projects: [], sessions: result.sessions } })
    return () => undefined
  },
}))

const { useAgentWatchAlerts, useAgentWatchFocus } = await import('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchAlerts')

const device = { device_id: 'machine-1', is_online: true, capabilities: {} } as unknown as Device
const session = (agentStatus: string): SessionpageSessionSummary => ({
  conversationId: 'conversation-1',
  projectId: 'project-1',
  title: '分析下北京经济',
  harness: 'claude',
  runtime: 'acp',
  agentStatus,
  lastInteractedAt: '2026-09-15T00:00:00.000Z',
  supported: true,
} as SessionpageSessionSummary)

// 壳根上的订阅(AgentWatchRoot 那一份)+ 会话页(挂着时报「正盯着哪条」)。page=false 即人不在「任务」tab。
function WatchingPage({ focus }: { focus: { deviceId: string; sessionId: string } | null }) {
  useAgentWatchFocus(focus)
  return null
}
function Probe({ focus, page = true }: { focus: { deviceId: string; sessionId: string } | null; page?: boolean }) {
  useAgentWatchAlerts([device])
  return page ? createNode(WatchingPage, { focus }) : null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.toast.mockReset()
  mocks.showNotification.mockReset().mockResolvedValue({ success: true, displayed: true })
  mocks.systemPermissions = ['notifications']
  mocks.onList = null
  mocks.baseline = [session('working')]
  mocks.backgroundWatch = false
  mocks.setBackgroundWatch.mockClear()
})
afterEach(() => { harness.cleanup() })

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

async function mount(focus: { deviceId: string; sessionId: string } | null = null, page = true) {
  await harness.render(createNode(Probe, { focus, page }))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function finishTurn() {
  // 回合结束 = idle + 未读(四态合同里没有 completed;未读位只由回合结束那条边写出)。
  await act(async () => { mocks.onList?.({ sessions: [{ ...session('idle'), unseen: true }] }) })
}
async function askApproval() {
  await act(async () => { mocks.onList?.({ sessions: [{ ...session('needs_approval'), unseen: true }] }) })
}
async function mountAndAsk(focus: { deviceId: string; sessionId: string } | null = null) {
  await mount(focus)
  await askApproval()
}

/**
 * product spec:提醒**只有一个通道 —— 系统横幅**,不分 App 在不在前台。
 * owner 2026-09-15:「其实你就统一一下,都用系统横幅不行吗?没必要搞什么 App 内的提示条」。
 * 这组断言钉的就是「只有一个通道」:提示条被调用一次就算回潮。
 */
describe('agent watch alert delivery', () => {
  for (const state of ['visible', 'hidden'] as const) {
    it(`posts a system banner and nothing else while the page is ${state}`, async () => {
      setVisibility(state)
      await mountAndAsk()
      expect(mocks.showNotification).toHaveBeenCalledTimes(1)
      expect(String(mocks.showNotification.mock.calls[0][0].title)).toContain('分析下北京经济')
      expect(mocks.toast).not.toHaveBeenCalled()
    })
  }

  it('a turn finishing or erroring is a state change and posts nothing (owner 10-30)', async () => {
    setVisibility('hidden')
    await mount()
    await finishTurn()
    await act(async () => { mocks.onList?.({ sessions: [session('error')] }) })
    expect(mocks.showNotification).not.toHaveBeenCalled()
  })

  it('does not grow a second channel when the system banner cannot be posted', async () => {
    setVisibility('visible')
    mocks.showNotification.mockResolvedValue({ success: false, displayed: false, error: 'NOTIFICATIONS_NOT_GRANTED' })
    await mountAndAsk()
    expect(mocks.showNotification).toHaveBeenCalledTimes(1)
    // 没给通知权限就没有提醒 —— 那是「我的 → 权限」那一页要解决的事,❌ 不在这里另开一条路。
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('stays quiet for the session the user is already watching', async () => {
    setVisibility('visible')
    await mountAndAsk({ deviceId: 'machine-1', sessionId: 'conversation-1' })
    expect(mocks.showNotification).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  // 离开「任务」tab = 会话页卸掉;订阅与常驻通知都不能跟着走。
  it('keeps alerting after the Tasks page goes away, and stops suppressing the session it was watching', async () => {
    setVisibility('visible')
    const watched = { deviceId: 'machine-1', sessionId: 'conversation-1' }
    await mount(watched)
    await harness.render(createNode(Probe, { focus: watched, page: false }))
    await askApproval()
    expect(mocks.showNotification, 'the tasks page is gone, so nobody is watching that session any more').toHaveBeenCalledTimes(1)
  })

  it('holds the background-watch notification across the Tasks page coming and going, and drops it only with the root', async () => {
    mocks.backgroundWatch = true
    await mount(null, false)
    expect(mocks.setBackgroundWatch, 'up before the Tasks page was ever opened').toHaveBeenCalledTimes(1)
    expect(typeof mocks.setBackgroundWatch.mock.calls[0][0]).toBe('string')
    await harness.render(createNode(Probe, { focus: null, page: true }))
    await harness.render(createNode(Probe, { focus: null, page: false }))
    expect(mocks.setBackgroundWatch.mock.calls.some((call) => call[0] === null), 'no tab switch may drop it').toBe(false)
    await harness.render(null)
    expect(mocks.setBackgroundWatch.mock.calls.at(-1)?.[0], 'logging out (root unmount) drops it').toBeNull()
  })
})
