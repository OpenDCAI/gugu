import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { ChatListPanel } from '@/components/ChatListPanel'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { requestComposerEntryFocus } from '@/lib/composerEntryFocus'
import { publishSidebarChatView } from '@/lib/sidebarChatsBridge'
import { installSessionViewRequestBridge, SESSION_VIEW_REQUEST_BRIDGE_KEY } from '@renderer/features/sessions/stores/session-view-requests'
import { openChatOnScreen } from '@renderer/features/chats/open-chat'
import { showOnScreen, showBesideOnScreen } from '@renderer/app/screen-layout-actions'
import { chat, message, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const screen = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('@renderer/app/screen-layout-actions', { spy: true })
vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/store/devicesContext', async original => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [] }) }))
vi.mock('@/hooks/useAgentDisplayStatus', async original => ({ ...(await original<object>()), useAgentDisplayStatuses: () => ({}) }))
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }))

type Cdp = { send(method: string, params: object): Promise<unknown> }
const protocol = () => cdp() as unknown as Cdp
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const group = 'background-group-a'
const initial = [
  chat({ id: group, kind: 'group', name: 'Current group', last_message_preview: 'first', last_message_at: '2099-01-02T00:00:00Z' }),
  chat({ id: 'background-group-b', kind: 'group', name: 'Another group', last_message_preview: 'older', last_message_at: '2099-01-01T00:00:00Z' }),
]
let harness: ReturnType<typeof createReactHarness>
let previousBridge: unknown
const composition: string[] = []
const onSend = vi.fn(async () => {})

beforeEach(async () => {
  await page.viewport(1280, 900)
  harness = createReactHarness()
  composition.length = 0
  screen.show.mockClear()
  vi.mocked(showOnScreen).mockImplementation(screen.show)
  vi.mocked(showBesideOnScreen).mockImplementation(screen.show)
  previousBridge = (window as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY]
  installSessionViewRequestBridge(window, { openChat: openChatOnScreen })
  publishSidebarChatView({ focusedChatId: group, groups: [] })
})
afterEach(async () => {
  await protocol().send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  harness.cleanup()
  requestComposerEntryFocus(null)
  publishSidebarChatView({ focusedChatId: null, groups: [] })
  if (previousBridge === undefined) delete (window as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY]
  else (window as unknown as Record<string, unknown>)[SESSION_VIEW_REQUEST_BRIDGE_KEY] = previousBridge
})

async function render(rows = initial, messages: ReturnType<typeof message>[] = []) {
  await renderWithAppProviders(harness, <LocalizationProvider><div style={{ display: 'flex', width: 1200, height: 700 }}>
    <div style={{ display: 'flex', width: 320 }}><ChatListPanel placement="sidebar" /></div>
    <div style={{ flex: 1 }}>
      <input aria-label="Search" onCompositionStart={() => composition.push('start')} onCompositionEnd={() => composition.push('end')} />
      <ChatMessageComposer chatId={group} currentUserId="user-1" onSend={onSend} isGroupChat entryActive messages={messages} />
    </div>
  </div></LocalizationProvider>, { chat: { chats: rows, activeChatId: group, messages }, contacts: {} })
  await until('the real sidebar rows and composer exist', () => !!harness.container.querySelector(`[data-chat-row="${group}"]`) && !!harness.container.querySelector('[data-testid="chat-composer"]'))
}
const editor = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-composer"]')!
const search = () => harness.container.querySelector<HTMLInputElement>('[aria-label="Search"]')!
const row = () => harness.container.querySelector<HTMLElement>(`[data-chat-row="${group}"]`)!

it('hands focus over for pointer and Enter activation, but never for refresh, new messages or reordering', async () => {
  await render()
  await page.getByRole('option').nth(0).click()
  await until('pointer entry reaches the real composer', () => document.activeElement === editor())
  expect(screen.show).toHaveBeenCalledTimes(1)
  await page.getByRole('textbox', { name: 'Search' }).click()
  await render([...initial])
  await frames()
  expect(document.activeElement).toBe(search())
  const arrived = [message({ id: 'arrived', chat_id: group, content: 'new message' })]
  const updated = [initial[0]!, { ...initial[1]!, last_message_preview: 'new message', last_message_at: '2099-01-03T00:00:00Z', unread_count: 1 }]
  await render(updated, arrived)
  await until('the real list has reordered for the arriving message', () => harness.container.querySelector('[data-chat-row]')?.getAttribute('data-chat-row') === 'background-group-b')
  expect(document.activeElement).toBe(search())
  expect(screen.show).toHaveBeenCalledTimes(1)
  row().focus()
  await userEvent.keyboard('{Enter}')
  await until('Enter activation reaches the real composer', () => document.activeElement === editor())
  expect(screen.show).toHaveBeenCalledTimes(2)
})

it('preserves an uncommitted Chinese search composition while messages arrive and rows reorder', async () => {
  await render()
  await page.getByRole('option').nth(0).click()
  await until('the initial entry intent has been consumed', () => document.activeElement === editor())
  await page.getByRole('textbox', { name: 'Search' }).click()
  await protocol().send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  expect(composition).toEqual(['start'])
  expect(search().value).toBe('中文')
  const updated = [initial[0]!, { ...initial[1]!, last_message_preview: 'incoming during composition', last_message_at: '2099-01-03T00:00:00Z', unread_count: 2 }]
  await render(updated, [message({ id: 'during-ime', chat_id: group, content: 'incoming during composition' })])
  await until('the background row update has reached the actual list', () => harness.container.querySelector('[data-chat-row]')?.getAttribute('data-chat-row') === 'background-group-b')
  await frames()
  expect(document.activeElement).toBe(search())
  expect(search().value).toBe('中文')
  expect(composition).toEqual(['start'])
  expect(screen.show).toHaveBeenCalledTimes(1)
  await protocol().send('Input.insertText', { text: '中文' })
  expect(composition).toEqual(['start', 'end'])
  expect(document.activeElement).toBe(search())
  expect(search().value).toBe('中文')
})
