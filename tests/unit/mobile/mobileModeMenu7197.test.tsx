// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { MobileModeMenu } from '../../../apps/desktop/src/mobile/agent-watch/MobileModeMenu'
import { retainDeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../support/testHarness'

// #7197 手机上的模式按钮:只在手机自己的「对话 / 项目」两个视图之间跳,不让那台电脑换编程 / 通用(owner 10-15)。

const deviceStore = vi.hoisted(() => ({ devices: [] as Device[] }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: deviceStore.devices }),
}))

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
