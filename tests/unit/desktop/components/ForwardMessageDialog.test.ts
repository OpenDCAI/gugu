// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForwardMessageDialog } from '../../../../apps/desktop/src/components/chat/ForwardMessageDialog'
import { forwardPreview, forwardableChats } from '../../../../apps/desktop/src/components/chat/forwardMessageUtils'
import messagingZhCN from '../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'chat-x',
    kind: 'dm',
    status: 'active',
    name: 'Chat X',
    created_at: '2026-01-01T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 0,
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: 1,
    ...overrides,
  }
}
function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'msg-1',
    chat_id: 'src',
    sender_user_id: 'u1',
    to_user_ids: null,
    seq: 1,
    content: 'hello world',
    content_type: 'text',
    reply_to_message_id: null,
    retracted_at: null,
    created_at: '2026-06-15T00:00:00.000Z',
    reactions: [],
    is_mine: false,
    delivered: true,
    delivery_status: null,
    ...overrides,
  }
}
describe('forward helpers', () => {
  it('forwardPreview labels non-text content and falls back for empty', () => {
    expect(messagingZhCN.forward.preview).toEqual({
      attachment: '[附件]',
      card: '[卡片]',
      empty: '[空消息]',
    })
    const labels = { attachment: '[attachment]', card: '[card]', empty: '[empty message]' }
    expect(forwardPreview({ content: 'hi', content_type: 'text' }, labels)).toBe('hi')
    expect(forwardPreview({ content: null, content_type: 'attachment' }, labels)).toBe('[attachment]')
    expect(forwardPreview({ content: '{}', content_type: 'card' }, labels)).toBe('[card]')
    expect(forwardPreview({ content: '   ', content_type: 'text' }, labels)).toBe('[empty message]')
  })
  it('filters peers by current canonical identity and groups by canonical chat name', () => {
    const identities: Record<string, string> = { 'user-a': 'Alpha' }
    const chats = [
      chat({ id: 'src', name: '', peer_user_id: 'source-user' }),
      chat({ id: 'a', name: '', peer_user_id: 'user-a' }),
      chat({ id: 'b', kind: 'group', name: 'Beta Group' }),
    ]
    const displayName = (item: ChatItem) => item.kind === 'group' ? item.name : (identities[item.peer_user_id ?? ''] ?? '')
    expect(forwardableChats(chats, 'src', '', displayName).map((c) => c.id)).toEqual(['a', 'b'])
    expect(forwardableChats(chats, 'src', 'alph', displayName).map((c) => c.id)).toEqual(['a'])
    identities['user-a'] = 'Renamed Peer'
    expect(forwardableChats(chats, 'src', 'alph', displayName)).toEqual([])
    expect(forwardableChats(chats, 'src', 'renamed', displayName).map((c) => c.id)).toEqual(['a'])
    expect(forwardableChats(chats, 'src', 'beta group', displayName).map((c) => c.id)).toEqual(['b'])
  })
})
let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
describe('ForwardMessageDialog', () => {
  it('forwards the message to selected chats and closes', async () => {
    const onForward = vi.fn(async () => {})
    const onClose = vi.fn()
    const chats = [chat({ id: 'src', name: 'Source' }), chat({ id: 'a', name: 'Alpha' }), chat({ id: 'b', name: 'Beta' })]
    await act(async () => {
      root.render(createElement(ForwardMessageDialog, {
        messages: [message({ chat_id: 'src' })],
        chats,
        sourceChatId: 'src',
        onForward,
        onClose,
      }))
    })
    await flush()
    // Source chat is excluded from the picker.
    expect(document.body.querySelector('[data-pick-row="src"]')).toBeNull()
    const alpha = document.body.querySelector('[data-pick-row="a"]') as HTMLElement
    expect(alpha).not.toBeNull()
    await act(async () => {
      alpha.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const forwardBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '转发')!
    await act(async () => {
      forwardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(onForward).toHaveBeenCalledWith(['a'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('surfaces forward failures without closing', async () => {
    const onForward = vi.fn(async () => { throw new Error('网络错误') })
    const onClose = vi.fn()
    const chats = [chat({ id: 'src', name: 'Source' }), chat({ id: 'a', name: 'Alpha' })]
    await act(async () => {
      root.render(createElement(ForwardMessageDialog, {
        messages: [message({ chat_id: 'src' })],
        chats,
        sourceChatId: 'src',
        onForward,
        onClose,
      }))
    })
    await flush()
    const alpha = document.body.querySelector('[data-pick-row="a"]') as HTMLElement
    await act(async () => {
      alpha.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const forwardBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '转发')!
    await act(async () => {
      forwardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(onForward).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('网络错误')
  })
  // @@@multi-select (#988) — batch forward: >1 message shows a count summary (not a single preview),
  // and forwarding routes through the same onForward(targetChatIds) the caller fans out over.
  it('shows a batch summary and forwards multiple messages to selected chats', async () => {
    const onForward = vi.fn(async () => {})
    const onClose = vi.fn()
    const chats = [chat({ id: 'src', name: 'Source' }), chat({ id: 'a', name: 'Alpha' })]
    await act(async () => {
      root.render(createElement(ForwardMessageDialog, {
        messages: [
          message({ id: 'm1', chat_id: 'src' }),
          message({ id: 'm2', chat_id: 'src' }),
          message({ id: 'm3', chat_id: 'src' }),
        ],
        chats,
        sourceChatId: 'src',
        onForward,
        onClose,
      }))
    })
    await flush()
    // Batch summary instead of a single-message preview.
    expect(document.body.textContent).toContain('转发 3 条消息')
    const alpha = document.body.querySelector('[data-pick-row="a"]') as HTMLElement
    await act(async () => {
      alpha.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const forwardBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '转发')!
    await act(async () => {
      forwardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(onForward).toHaveBeenCalledWith(['a'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
