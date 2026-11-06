import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatListPanel } from '@/components/ChatListPanel'
import { NeedsYouHost } from '@/components/needsYou/NeedsYouHost'
import { ShellSidebarToggle } from '@renderer/lib/components/titlebar/shell-titlebar'
import { installShellSlots } from '@/lib/shellSlots'
import { i18n } from '@/i18n'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'

const state = vi.hoisted(() => ({ mobile: false }))
const markSeen = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@gugu/core/cloud/config', async original => ({ ...await original<object>(), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/platform', async original => {
  const module = await original<typeof import('@/platform')>()
  return { ...module, platform: { ...module.platform, get kind() { return state.mobile ? 'capacitor' : 'electron' } } }
})
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('@/hooks/useAgentDisplayStatus', async original => ({ ...await original<object>(), useAgentDisplayStatuses: () => ({}) }))
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: true, isLeftPeeking: false, toggleLeft: vi.fn(), setTriggerHovered: vi.fn() }) }))
// The unit integration covers the real directory. These layout cases keep all 100 pending tasks stable.
vi.mock('@/components/needsYou/useNeedsYouTasks', () => ({
  markNeedsYouTaskSeen: markSeen,
  useNeedsYouTasks: () => ({ attention: 'approval', error: null, count: 100, tasks: Array.from({ length: 100 }, (_, index) => ({
    deviceId: 'host', machine: 'Host', local: false, phoneHost: false,
    session: { conversationId: `task-${index}`, title: `Task ${index}`, status: { status: 'needs_user', detail: 'approval' }, agentStatus: 'needs_user', unseen: true },
  })) }),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en-US')
  delete (window as unknown as Record<string, unknown>).__GUGU_SIDEBAR_NOTIFICATIONS_OPEN__
  installShellSlots()
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup() })

it.each([false, true])('the real list header keeps its bell/badge inside the pane and retains chat scroll (phone=%s)', async mobile => {
  state.mobile = mobile
  const width = mobile ? 320 : 390
  await page.viewport(width, 844)
  harness.container.style.cssText = `width:${width}px;height:700px;display:flex`
  if (mobile) harness.container.setAttribute('data-phone-shell', '')
  await renderWithAppProviders(harness, <><ChatListPanel mobile={mobile} /><NeedsYouHost /></>, {
    chat: { chats: Array.from({ length: 40 }, (_, index) => chat({ id: `chat-${index}`, kind: 'group', name: `Group ${index}` })) },
  })
  const bell = harness.container.querySelector<HTMLButtonElement>('[data-testid="notification-toggle"]')!
  await until('the bell and count are laid out', () => bell?.getBoundingClientRect().width > 0)
  const badge = harness.container.querySelector<HTMLElement>('[data-testid="notification-count"]')!
  const header = bell.closest<HTMLElement>('[data-slot="pane-header"]')!
  const headerBox = header.getBoundingClientRect()
  const badgeBox = badge.getBoundingClientRect()
  expect(badge.textContent).toBe('99+')
  expect(badgeBox.left).toBeGreaterThanOrEqual(headerBox.left)
  expect(badgeBox.right).toBeLessThanOrEqual(headerBox.right)
  expect(badgeBox.top).toBeGreaterThanOrEqual(headerBox.top)
  expect(getComputedStyle(badge).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  const original = harness.container.querySelector<HTMLElement>('[data-notification-original-list]')!
  const scroller = [...original.querySelectorAll<HTMLElement>('*')].find(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto')!
  expect(scroller).toBeDefined()
  scroller.scrollTop = 87
  const height = scroller.clientHeight
  await userEvent.click(bell)
  await until('the global notification list is visible', () => !!harness.container.querySelector('[data-testid="notification-list"]'))
  expect(harness.container.querySelector('[data-notification-original-list]')).toBe(original)
  await userEvent.click(bell)
  await until('the original list has its viewport again', () => getComputedStyle(original).contentVisibility !== 'hidden')
  expect(scroller.clientHeight).toBe(height)
  expect(scroller.scrollTop).toBe(87)
})

it('the desktop workspace titlebar keeps the bell badge inside the window', async () => {
  state.mobile = false
  await page.viewport(1000, 800)
  harness.container.style.cssText = 'position:relative;width:1000px;height:700px'
  await renderWithAppProviders(harness, <><ShellSidebarToggle /><NeedsYouHost /></>)
  const badge = harness.container.querySelector<HTMLElement>('[data-testid="notification-count"]')!
  await until('the workspace badge is laid out', () => badge?.getBoundingClientRect().width > 0)
  const box = badge.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(1000)
})
