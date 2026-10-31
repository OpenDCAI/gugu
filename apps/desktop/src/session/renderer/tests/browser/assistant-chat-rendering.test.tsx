import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { createReactHarness, chat, displayIdentity, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@renderer/features/assistant/assistant-today.css'
import '@/mobile/assistant/assistant-phone.css'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

let harness: ReturnType<typeof createReactHarness>
beforeAll(async () => { await i18n.changeLanguage('zh-CN') })
afterEach(() => { harness?.cleanup(); localStorage.removeItem('app-theme'); delete document.documentElement.dataset.theme })

it.each(['light', 'dark'] as const)('restores the assistant IM colours and transparent top/bottom on %s', async theme => {
  writeThemePreference(theme)
  await page.viewport(1100, 800)
  harness = createReactHarness()
  harness.container.style.height = '740px'
  const dm = chat({ id: 'assistant-dm', kind: 'ai', peer_user_id: 'assistant' })
  await renderWithAppProviders(harness, <ThemeProvider><div className="ta-app"><div className="ta-chat-col"><div className="ta-chat">
    <ChatAreaPanel activeTab="chats" chrome={{ placeholder: '和咕咕聊天', attachGlyph: null, hideRunningStatus: true }} />
  </div></div></div></ThemeProvider>, { chat: {
    activeChat: dm, activeChatId: dm.id,
    identitiesById: { assistant: displayIdentity('assistant', { type: 'agent', display_name: '咕咕' }) },
    messages: [message({ id: 'answer', chat_id: dm.id, sender_user_id: 'assistant', content: '助理的原有消息气泡。' })],
  } })
  await until('the real IM bubble is visible', () => !!harness.container.querySelector('[data-msg-id="answer"] [data-bubble-tail="other"]'))
  expect(harness.container.querySelector('[data-testid="agent-dm-conversation"]')).toBeNull()
  const app = harness.container.querySelector<HTMLElement>('.ta-app')!
  const surface = harness.container.querySelector<HTMLElement>('[data-chat-surface]')!
  const list = harness.container.querySelector<HTMLElement>('[data-testid="chat-message-list"]')!
  const dock = harness.container.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
  const bubble = harness.container.querySelector<HTMLElement>('[data-bubble-tail="other"]')!
  expect(getComputedStyle(app).backgroundImage).toContain('linear-gradient')
  for (const element of [surface, list, dock]) {
    const style = getComputedStyle(element)
    expect(style.backgroundColor, 'no generic conversation backing over the assistant gradient').toBe('rgba(0, 0, 0, 0)')
    expect(style.backgroundImage).toBe('none')
  }
  expect(getComputedStyle(list).maskImage).toContain('linear-gradient')
  expect(getComputedStyle(bubble).backgroundColor).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgba(255, 255, 255, 0.06)')
  expect(getComputedStyle(bubble).fontSize).toBe('16px')
  expect(getComputedStyle(bubble).lineHeight).toBe('24px')
  const composer = harness.container.querySelector<HTMLElement>('[data-chat-composer]')!
  expect(getComputedStyle(composer).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ element: app, path: `__screenshots__/assistant-im-${theme}.png` })
})
