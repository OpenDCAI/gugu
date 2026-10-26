// @vitest-environment jsdom
import { act, useState } from 'react'
import { frame } from '../../support/dialogExit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../support/testHarness'

// #7197 会话页的模式按钮:「对话」那行有没有咕咕身份看会话自己带不带 agent id —— 通讯录里还没有它的名字
// (agentOfSession 给 undefined)时 ❌ 说「还没有咕咕身份」。

const actions = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc')>(), updateSession: actions.update, fetchSessionOptions: vi.fn(async () => ({})),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({
  useAgentWatchSession: () => ({
    timeline: emptyAgentWatchTimeline(), phase: 'ready', error: null, actionError: null, dismissActionError: vi.fn(),
    waitingForRecord: false, reload: vi.fn(), loadOlder: vi.fn(), send: vi.fn(), pendingSends: [], respond: vi.fn(),
    sending: false, respondingItemId: null, cancel: vi.fn(), cancelling: false,
  }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/AgentThread', () => ({ AgentThread: () => null }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/StatusGlyph', () => ({ SessionAvatar: () => null }))

const device: Device = {
  device_id: 'device-1', label: 'Mac', hostname: 'fixture-mac', platform: 'darwin', status: 'online',
  is_online: true, last_seen_at: '2026-10-15T00:00:00.000Z',
  capabilities: { terminals: [], runtimes: ['claude'], host_runtime_capability: 1 },
}
const session = (extra: Partial<SessionpageSessionSummary> = {}): SessionpageSessionSummary => ({
  conversationId: 'conversation-1', projectId: 'project-1', title: 'Task one', harness: 'claude', runtime: 'pty',
  agentStatus: null, lastInteractedAt: '2026-10-15T00:00:00.000Z', supported: true, ...extra,
})
const chatRow = () => document.querySelector<HTMLElement>('[data-testid="agent-watch-mode-chat"]')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })

async function openMenu(): Promise<void> {
  await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-watch-mode-open"]')!)
  await waitForCondition(() => chatRow() !== null, 'mode menu opened')
}

describe('SessionTimelinePage mode button → 对话', () => {
  it('the session has an agent but the contacts have no name for it yet: 对话 still goes to that agent', async () => {
    const onOpenChat = vi.fn()
    await harness.render(createNode(SessionTimelinePage, { device, session: session({ agent: { userId: 'agent-1' } }), agent: undefined, onBack: vi.fn(), onOpenChat }))
    await openMenu()
    expect(chatRow()?.getAttribute('aria-disabled')).not.toBe('true')
    expect(chatRow()?.textContent).not.toContain(translateSessionMessage('task.modeChatNeedsIdentity'))
    await clickElement(chatRow()!)
    expect(onOpenChat).toHaveBeenCalledWith('agent-1')
  })

  it('the session has no agent: 对话 is greyed with the reason', async () => {
    await harness.render(createNode(SessionTimelinePage, { device, session: session({ agent: null }), agent: undefined, onBack: vi.fn(), onOpenChat: vi.fn() }))
    await openMenu()
    expect(chatRow()?.getAttribute('aria-disabled')).toBe('true')
    expect(chatRow()?.textContent).toContain(translateSessionMessage('task.modeChatNeedsIdentity'))
  })
})

it('timeline archive: the menu closes on the tap, the page goes back once the machine confirms', async () => {
  const back = vi.fn()
  let confirm: (value: { title: string; isPinned: boolean; archived: boolean }) => void = () => undefined
  actions.update.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
  function Parent() {
    const [shown, setShown] = useState(true)
    return shown ? createNode(SessionTimelinePage, { device, session: session(), onBack: () => { back(); setShown(false) } }) : null
  }
  await harness.render(createNode(Parent))
  await clickElement(document.querySelector('[data-testid="agent-watch-session-page-menu"]')!); await frame()
  expect(document.querySelector('[role="menu"]'), 'owner 10-26:贴着 ⋯ 弹菜单,❌ 底部抽屉').not.toBeNull()
  await clickElement(document.querySelector('[data-testid="agent-watch-session-archive"]')!)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(back, '机器还没回话,页面不走').not.toHaveBeenCalled()
  await act(async () => { confirm({ title: 'Task one', isPinned: false, archived: true }) })
  expect(back).toHaveBeenCalledOnce()
  expect(harness.container.textContent).toBe('')
})
