// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageSenderProvider } from '../../../../apps/desktop/src/components/chat/MessageSenderProvider'
import { BubbleSender } from '../../../../apps/desktop/src/components/chat/MessageBubbleChrome'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const navigation = vi.hoisted(() => ({ open: vi.fn(), mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => navigation.mobile, readMobileShell: () => navigation.mobile }))
vi.mock('../../../../apps/desktop/src/lib/openMessageSender', () => ({ openMessageSender: navigation.open }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks(); navigation.mobile = false })
afterEach(() => harness.cleanup())

it.each(['agent', 'human'] as const)('opens the clicked %s from the group instead of reopening its source message', async type => {
  const member: MemberProfileCardModel = {
    id: 'peer-963', displayName: 'Participant', avatar: null, email: null, type,
    role: 'member', membership: 'current', profileScope: 'group', ownerUserId: type === 'agent' ? 'user-1' : undefined,
  }
  const message = { id: 'source-message-963', chat_id: 'group-963', sender_user_id: member.id }
  await renderWithAppProviders(harness, createNode(MessageSenderProvider, { message, group: true },
    createNode(BubbleSender, { member, senderId: member.id })), { chat: {}, contacts: {} })
  const name = harness.container.querySelector<HTMLButtonElement>('button.msg-sender-name')
  expect(name?.textContent).toBe(member.displayName)
  await clickElement(name!)
  expect(navigation.open).toHaveBeenCalledExactlyOnceWith({ kind: 'sender', userId: member.id, sourceChatId: message.chat_id })
})

it('keeps the phone group-name action on its existing source message', async () => {
  navigation.mobile = true
  const member: MemberProfileCardModel = { id: 'peer', displayName: 'Phone participant', avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'group' }
  const message = { id: 'message', chat_id: 'group', sender_user_id: member.id }
  await renderWithAppProviders(harness, createNode(MessageSenderProvider, { message, group: true }, createNode(BubbleSender, { member, senderId: member.id })), { chat: {}, contacts: {} })
  await clickElement(harness.container.querySelector<HTMLButtonElement>('button.msg-sender-name')!)
  expect(navigation.open).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', chatId: 'group', messageId: 'message' })
})

it('keeps a direct conversation name on the ordinary peer route', async () => {
  const member: MemberProfileCardModel = { id: 'peer', displayName: 'Direct peer', avatar: null, email: null, type: 'human', role: 'member', membership: 'current', profileScope: 'direct' }
  await renderWithAppProviders(harness, createNode(MessageSenderProvider, { message: { id: 'message', chat_id: 'dm', sender_user_id: member.id }, group: false }, createNode(BubbleSender, { member, senderId: member.id })), { chat: {}, contacts: {} })
  await clickElement(harness.container.querySelector<HTMLButtonElement>('button.msg-sender-name')!)
  expect(navigation.open).toHaveBeenCalledExactlyOnceWith({ kind: 'sender', userId: 'peer' })
})
