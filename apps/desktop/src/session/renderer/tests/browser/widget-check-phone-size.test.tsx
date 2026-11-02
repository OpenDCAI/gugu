import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { phoneWidgetWidth } from '@gugu/core/shared/ui/messageBubbleLayout'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async original => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: {} }))
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: {
  isLoaded: true, isEnabled: () => true,
  manifestFor: () => ({ id: 'vote', version: '1.0.0', contributes: { tabs: [{ name: 'poll', widget: { height: 240 } }] } }),
} }))
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: () => undefined, shown: true }) }))
// Only the App's contents are a stand-in; MessageBubble and WidgetBubble's real layout remain intact.
vi.mock('@/session/renderer/features/extensions/extension-view-layer', async original => ({ ...(await original<object>()), ExtensionPage: () => <iframe title="widget slot" style={{ width: '100%', height: '100%', border: 0 }} /> }))
vi.mock('@/components/appSlot/PhoneAppFrame', async original => ({ ...(await original<object>()), PhoneAppFrame: () => <iframe title="widget slot" style={{ width: '100%', height: '100%', border: 0 }} /> }))
const { MessageBubble } = await import('@/components/chat/MessageBubble')
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it.each([false, true])('phone412 widget iframe matches the hidden check viewport (mine=%s)', async isMine => {
  await page.viewport(412, 844)
  harness = createReactHarness()
  harness.container.style.width = '412px'
  await renderWithAppProviders(harness, createNode(MessageBubble, {
    msg: message({ id: 'widget-1', sender_user_id: 'sender', content_type: 'widget', is_mine: isMine,
      content: JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', data: {} }) }),
    compactMobile: true, isGroup: true, memberReadSeqs: {},
    onReaction: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  }))
  const frame = harness.container.querySelector<HTMLIFrameElement>('iframe[title="widget slot"]')!
  expect(frame).not.toBeNull()
  const actual = frame.getBoundingClientRect()
  expect(actual.height).toBe(240)
  expect(actual.width).toBeGreaterThan(200)
  expect(actual.width).toBeLessThan(412 - 28)
  expect(Math.abs(actual.width - phoneWidgetWidth(412))).toBeLessThan(1)
})
