// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { MobileModeMenu } from '../../../apps/desktop/src/mobile/agent-watch/MobileModeMenu'
import { MobileAgentOpenTask } from '../../../apps/desktop/src/mobile/agent-watch/MobileAgentOpenTask'
import { useAgentSessionRow } from '../../../apps/desktop/src/mobile/agent-watch/useAgentSessionRow'
import { APP_SHOW_SESSION_EVENT, type AppShowSessionDetail } from '../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { retainDeviceSessions, updateDeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../support/testHarness'

// #7197 手机上的模式按钮:只在手机自己的「对话 / 项目」两个视图之间跳,不让那台电脑换编程 / 通用(owner 10-15)。

const deviceStore = vi.hoisted(() => ({ devices: [] as Device[] }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: deviceStore.devices }),
}))

const session = (extra: Partial<SessionpageSessionSummary> = {}): SessionpageSessionSummary => ({
  conversationId: 'conversation-1',
  projectId: 'project-1',
  title: 'Task one',
  harness: 'claude',
  runtime: 'pty',
  agentStatus: null,
  lastInteractedAt: '2026-10-15T00:00:00.000Z',
  supported: true,
  agent: { userId: 'agent-1' },
  ...extra,
})

const device = (): Device => ({
  device_id: 'device-1',
  label: 'Mac',
  hostname: 'mac',
  platform: 'darwin',
  status: 'online',
  last_seen_at: '2026-10-15T00:00:00.000Z',
  is_online: true,
  capabilities: { terminals: [], runtimes: [] },
} as Device)

const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const choice = (view: 'chat' | 'task') => q<HTMLElement>(`[data-testid="agent-watch-mode-${view}"]`)
/** 桌面同款下拉(❌ 底部抽屉):点按钮,等两行出现。 */
const openMenu = async (): Promise<void> => {
  await clickElement(q<HTMLElement>('[data-testid="agent-watch-mode-open"]')!)
  await waitForCondition(() => choice('chat') !== null, 'mode menu opened')
}
const menuClosed = () => waitForCondition(() => choice('chat') === null, 'mode menu closed')
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((el) => ({
  id: el.getAttribute('data-testid')?.replace('agent-watch-mode-', ''),
  checked: el.getAttribute('aria-checked'),
  text: el.textContent,
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  deviceStore.devices = [device()]
})
afterEach(() => {
  harness.cleanup()
  retainDeviceSessions([])
})

describe('MobileModeMenu on the session page (at=task)', () => {
  it('two rows, 对话 / 项目 (the bottom-bar names), the one in use checked; 对话 goes to the agent chat; no switch action', async () => {
    const onOpenChat = vi.fn()
    await harness.render(createNode(MobileModeMenu, { at: 'task', onOpenChat }))
    expect(q('[data-testid="agent-watch-mode-open"]')?.textContent).toBe('会话')

    await openMenu()
    expect(document.querySelector('[data-testid="agent-watch-mode"]')).toBeNull() // 没有底部抽屉
    expect(rows()).toEqual([
      { id: 'chat', checked: 'false', text: '对话' },
      { id: 'task', checked: 'true', text: '会话' },
    ])
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    // 没有「切换为编程 / 通用模式」:那个手动切换整个删了,手机上也不会有。
    expect(document.body.textContent).not.toContain('切换为')

    await clickElement(choice('chat')!)
    expect(onOpenChat).toHaveBeenCalledTimes(1)
    await menuClosed()
  })

  it('tapping the view you are already in only closes the sheet', async () => {
    const onOpenChat = vi.fn()
    await harness.render(createNode(MobileModeMenu, { at: 'task', onOpenChat }))
    await openMenu()
    await clickElement(choice('task')!)
    expect(onOpenChat).not.toHaveBeenCalled()
    await menuClosed()
  })

  it('no Gugu identity: 对话 is greyed with the reason', async () => {
    await harness.render(createNode(MobileModeMenu, { at: 'task', onOpenChat: null }))
    await openMenu()
    expect(choice('chat')?.getAttribute('aria-disabled')).toBe('true')
    expect(choice('chat')?.textContent).toContain(translateSessionMessage('task.modeChatNeedsIdentity'))
  })
})

/** 私聊页拿到的就是这一份:找得到才放按钮(AgentSessionpagePresentation)。 */
function DmHeader({ agentUserId }: { agentUserId: string | null }) {
  const row = useAgentSessionRow(agentUserId)
  return row ? createNode(MobileAgentOpenTask, { row }) : createNode('span', { 'data-testid': 'no-mode-button' })
}

// #639:电脑私聊页头的模式菜单换成了一颗「在任务中打开」;手机跟着换成一颗按钮,❌ 「对话 / 项目」下拉。
describe('MobileAgentOpenTask (agent chat header)', () => {
  it('one icon button that opens the agent’s session the way gugu.showSession does, no menu', async () => {
    updateDeviceSessions('device-1', { sessions: [session({ conversationId: 'other', agent: { userId: 'agent-2' } }), session()], cached: false, loading: false, error: null })
    const shown: AppShowSessionDetail[] = []
    const listen = (event: Event) => shown.push((event as CustomEvent<AppShowSessionDetail>).detail)
    window.addEventListener(APP_SHOW_SESSION_EVENT, listen)
    try {
      await harness.render(createNode(DmHeader, { agentUserId: 'agent-1' }))
      expect(q('[data-testid="agent-watch-mode-open"]')).toBeNull()
      const button = q<HTMLElement>('[data-testid="agent-open-task"]')!
      // 私聊页头放不下名字(390 宽时 agent 名被挤成「C…」):只画图标,名字进读屏标签。
      expect(button.textContent).toBe('')
      expect(button.getAttribute('aria-label')).toBe('在任务中打开')
      await clickElement(button)
      expect(rows()).toEqual([])
      expect(shown).toEqual([{ deviceId: 'device-1', session: expect.objectContaining({ conversationId: 'conversation-1' }) }])
    } finally {
      window.removeEventListener(APP_SHOW_SESSION_EVENT, listen)
    }
  })

  it('no button when no machine lists a session for this agent, or when it is not asked to look (desktop)', async () => {
    updateDeviceSessions('device-1', { sessions: [session({ agent: { userId: 'agent-2' } })], cached: false, loading: false, error: null })
    await harness.render(createNode(DmHeader, { agentUserId: 'agent-1' }))
    expect(q('[data-testid="agent-open-task"]')).toBeNull()
    expect(q('[data-testid="no-mode-button"]')).not.toBeNull()
    await harness.render(createNode(DmHeader, { agentUserId: null }))
    expect(q('[data-testid="agent-open-task"]')).toBeNull()
  })
})
