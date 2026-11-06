// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatKind } from '@gugu/core/shared/types/chat'
import { PersonalConversationRowMenu } from '../../../apps/desktop/src/components/chat/PersonalConversationRowMenu'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

it.each<ChatKind>(['dm', 'ai', 'group', 'topic'])('the personal menu for %s invokes only its explicit hide callback without loading admin permissions', async kind => {
  const settings = vi.spyOn(chatService, 'getGroupChatSettings').mockRejectedValue(new Error('ordinary member has no administration permission'))
  const hide = vi.fn().mockResolvedValue(undefined), legacyDelete = vi.fn(), leave = vi.fn(), removeAgent = vi.fn()
  const row = chat({ id: 'personal-row', kind, unread_count: 2 })
  await renderWithAppProviders(harness, createNode(PersonalConversationRowMenu, {
    chat: row, x: 20, y: 40, onClose: vi.fn(), onPin: vi.fn(), onSetNotificationLevel: vi.fn(), onHide: hide,
  }), { chat: { chats: [row], deleteChat: legacyDelete, leaveGroup: leave }, contacts: { removeOwnedAgent: removeAgent } })
  const remove = document.querySelector<HTMLElement>('[data-testid=conversation-row-delete-chat]')
  expect(remove).not.toBeNull()
  expect(remove?.textContent).toContain('从列表删除')
  await clickElement(remove!)
  expect(hide).toHaveBeenCalledTimes(1)
  expect(settings).not.toHaveBeenCalled()
  expect(legacyDelete).not.toHaveBeenCalled()
  expect(leave).not.toHaveBeenCalled()
  expect(removeAgent).not.toHaveBeenCalled()
})
