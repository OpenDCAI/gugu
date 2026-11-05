// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../../support/testHarness'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { ChatTabMenuItems, chatTabHasActions } from '@/session/renderer/features/chats/chat-tab-menu-items'
import { openInfoTab } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'

vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { openableApps: [{ extensionId: 'board', name: 'Board' }] } }))
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ openInfoTab: vi.fn() }))
vi.mock('@/components/chat/ChatDetailsMenuItems', () => ({ ChatDetailsMenuItems: ({ onOpenInfo }: { onOpenInfo: () => void }) => createNode('button', { onClick: onOpenInfo }, 'Chat info') }))
let ui: ReturnType<typeof createReactHarness>
beforeEach(() => {
  ui = createReactHarness(); vi.clearAllMocks()
  publishChatSummaries([
    { id: 'group', kind: 'group', unread_count: 0, name: 'Group' },
    { id: 'dm', kind: 'dm', unread_count: 0, name: 'Person' },
  ])
})
afterEach(() => ui.cleanup())
describe('a chat tab menu holds its own chat actions, never the「+」App list', () => {
  it('a group tab has no menu even with Apps installed', () => {
    expect(chatTabHasActions('group')).toBe(false)
  })
  it('a DM tab offers only its information action', async () => {
    expect(chatTabHasActions('dm')).toBe(true)
    await ui.render(createNode(ChatTabMenuItems, { chatId: 'dm' }))
    expect(ui.container.textContent).toBe('Chat info')
    await clickElement(ui.container.querySelector('button')!)
    expect(openInfoTab).toHaveBeenCalledExactlyOnceWith('dm')
  })
})
