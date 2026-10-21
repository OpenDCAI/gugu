// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFriendsPanel } from '../../../../apps/desktop/src/components/NewFriendsPanel'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})
describe('NewFriendsPanel agent requests', () => {
  it('opens the shared agent group returned by accepting an agent request', async () => {
    const acceptRequest = vi.fn(async () => ({
      chatId: 'shared-agent-chat-1',
      kind: 'group' as const,
      name: null,
      member_count: 7,
      created: true,
    }))
    const onOpenGroupChat = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(NewFriendsPanel, { onOpenGroupChat }),
      {
        contacts: {
          acceptRequest,
          friendRequests: [{
            direction: 'received',
            request: {
              id: 'request-1',
              sender_id: 'requester-1',
              receiver_id: 'agent-1',
              sender: contact({ id: 'requester-1', display_name: 'Bob' }),
              receiver: contact({ id: 'agent-1', display_name: 'Deploy Bot', type: 'agent', owner_user_id: 'owner-1' }),
              message: 'please share deploy bot',
              status: 'pending',
              created_at: '2026-05-23T00:00:00Z',
            },
          }],
        },
      },
    )
    const acceptButton = Array.from(harness.container.querySelectorAll('button')).find((button) => button.textContent === '同意') as HTMLButtonElement
    await clickElement(acceptButton)
    expect(acceptRequest).toHaveBeenCalledWith('request-1')
    expect(onOpenGroupChat).toHaveBeenCalledWith({
      id: 'shared-agent-chat-1',
      kind: 'group',
      avatar_url: null,
      // @@@1624 - a no-name RPC result no longer silently falls back to '群聊' (a generic mask that hid the
      // missing name). It now fails loud via resolveOrLoud: a glaring marker in dev (and '' + console.error
      // in prod). The realtime chat-list refetch fills the real name shortly after.
      name: expect.stringContaining('未解析'),
      member_count: 7,
      is_muted: false,
    })
  })
})
