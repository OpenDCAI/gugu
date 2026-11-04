// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatKind } from '@gugu/core/shared/types/chat'
import { notifyForIngestedMessage } from '../../../../apps/desktop/src/store/chatListProjection'
import { chat, message } from '../../../support/testHarness'

const showNotification = vi.hoisted(() => vi.fn(async (_payload: { chatId: string | null }) => ({ success: true, displayed: true })))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { capabilities: { notifications: true }, showNotification },
}))

const row = (id: string, kind: ChatKind, unread: number, addressed: number): ChatItem => chat({ id, kind, unread_count: unread,
  unread_locator: unread === 0 ? null : { stream_id: `main:${id}`, stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
    unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false } })
const context = { onScreen: () => false, notificationsEnabled: true, soundEnabled: true }

beforeEach(() => { showNotification.mockClear() })

// 手机和桌面跑的是同一份渲染层:聊天系统通知只有这一个出口,判据是 shouldNotify。
describe('the chat notification call site, shared by phone and desktop', () => {
  it('banners a direct message and a group message addressed to you, and nothing else', async () => {
    for (const chat of [row('dm', 'dm', 1, 0), row('group-at', 'group', 2, 1), row('group-chatter', 'group', 3, 0)]) {
      await notifyForIngestedMessage('viewer', chat, message({ chat_id: chat.id, sender_user_id: 'peer', seq: 1,
        to_user_ids: chat.id === 'group-at' ? ['viewer'] : null }), context)
    }
    expect(showNotification.mock.calls.map(([payload]) => payload.chatId)).toEqual(['dm', 'group-at'])
  })

  it('raises nothing for the chat the person is looking at (desktop: focused window, that group on screen)', async () => {
    await notifyForIngestedMessage('viewer', row('group-at', 'group', 1, 1),
      message({ chat_id: 'group-at', sender_user_id: 'peer', to_user_ids: ['viewer'] }),
      { ...context, onScreen: (id) => id === 'group-at' })
    expect(showNotification).not.toHaveBeenCalled()
  })
})
