// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../../support/testHarness'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { ChatTabMenuItems, chatTabHasActions } from '@/session/renderer/features/chats/chat-tab-menu-items'
import { openApp } from '@/components/appSlot/useOpenApp'
import { openInfoTab } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'

const data = vi.hoisted(() => ({ apps: [] as Array<{ extensionId: string; name: string; iconDataUrl?: string }> }))
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { get openableApps() { return data.apps } } }))
vi.mock('@/components/appSlot/useOpenApp', () => ({ openApp: vi.fn() }))
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ openInfoTab: vi.fn() }))
vi.mock('@renderer/lib/ui/context-menu', () => ({ ContextMenuItem: 'button', ContextMenuSeparator: 'hr' }))
vi.mock('@/components/chat/ChatDetailsMenuItems', () => ({ ChatDetailsMenuItems: ({ onOpenInfo }: { onOpenInfo: () => void }) => createNode('button', { onClick: onOpenInfo }, 'Chat info') }))
let ui: ReturnType<typeof createReactHarness>
beforeEach(() => {
  ui = createReactHarness(); data.apps = []; vi.clearAllMocks()
  publishChatSummaries([
    { id: 'group', kind: 'group', unread_count: 0, name: 'Group' },
    { id: 'dm', kind: 'dm', unread_count: 0, name: 'Person' },
  ])
})
afterEach(() => ui.cleanup())
describe('group tabs keep Apps and leave settings in the header', () => {
  it('has no actions or blank menu when a group has no Apps', async () => {
    expect(chatTabHasActions('group')).toBe(false)
    await ui.render(createNode(ChatTabMenuItems, { chatId: 'group' }))
    expect(ui.container.textContent).toBe('')
    expect(ui.container.querySelector('button,hr')).toBeNull()
  })
  it('retains App actions bound to the group, without a settings action or leading separator', async () => {
    data.apps = [{ extensionId: 'board', name: 'Board' }]
    expect(chatTabHasActions('group')).toBe(true)
    await ui.render(createNode(ChatTabMenuItems, { chatId: 'group' }))
    expect(ui.container.textContent).toBe('Board')
    expect(ui.container.querySelector('hr')).toBeNull()
    await clickElement(ui.container.querySelector('button')!)
    expect(openApp).toHaveBeenCalledExactlyOnceWith('board', 'group')
    expect(openInfoTab).not.toHaveBeenCalled()
  })
  it('retains the distinct DM information action', async () => {
    expect(chatTabHasActions('dm')).toBe(true)
    await ui.render(createNode(ChatTabMenuItems, { chatId: 'dm' }))
    await clickElement(ui.container.querySelector('button')!)
    expect(openInfoTab).toHaveBeenCalledExactlyOnceWith('dm')
  })
})
