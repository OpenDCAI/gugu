// @vitest-environment jsdom
// 转发页最上面的「分享到其他应用」(product spec):分享收在转发里,❌ 在消息菜单里和「转发」并列(owner 2026-09-27)。
import { act, createElement } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { formatVoiceAttachmentMetadata } from '../../../../packages/core/src/shared/ui/voiceAttachmentModels'

const host = vi.hoisted(() => ({
  platform: {
    kind: 'capacitor',
    capabilities: { shareToApps: true },
    shareToApps: vi.fn(async (_payload: unknown) => {}),
  },
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: host.platform }))

const { ForwardMessageDialog } = await import('../../../../apps/desktop/src/components/chat/ForwardMessageDialog')

function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'chat-x', kind: 'dm', status: 'active', name: 'Chat X', created_at: '2026-01-01T00:00:00.000Z',
    last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null,
    last_read_seq: 0, next_message_seq: 1, ...overrides,
  }
}
function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'msg-1', chat_id: 'src', sender_user_id: 'u1', to_user_ids: null, seq: 1, content: '晚上七点见',
    content_type: 'text', reply_to_message_id: null, retracted_at: null, created_at: '2026-06-15T00:00:00.000Z',
    reactions: [], is_mine: false, delivered: true, delivery_status: null, ...overrides,
  }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  host.platform.capabilities.shareToApps = true
  host.platform.shareToApps.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderDialog(messages: MessageItem[], onClose = vi.fn()) {
  await act(async () => {
    root.render(createElement(ForwardMessageDialog, {
      messages,
      chats: [chat({ id: 'src', name: 'Source' }), chat({ id: 'a', name: 'Alpha' })],
      sourceChatId: 'src',
      onForward: vi.fn(async () => {}),
      onClose,
    }))
  })
  return onClose
}
const shareRow = () => document.body.querySelector('[data-share-to-apps]') as HTMLElement | null

describe('转发页里的「分享到其他应用」', () => {
  it('在会话列表最上面;点它关掉转发页,把这条消息交给系统分享面板', async () => {
    const onClose = await renderDialog([message()])
    const row = shareRow()
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('分享到其他应用')
    // 排在第一个会话行之前。
    const firstChat = document.body.querySelector('[data-pick-row]')!
    expect(row!.compareDocumentPosition(firstChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(host.platform.shareToApps).toHaveBeenCalledWith({ text: '晚上七点见' })
  })

  it('宿主没有系统分享(电脑、浏览器)就不出现', async () => {
    host.platform.capabilities.shareToApps = false
    await renderDialog([message()])
    expect(shareRow()).toBeNull()
    expect(document.body.querySelector('[data-pick-row="a"]')).not.toBeNull()
  })

  it('选中的消息里有分享不了的(语音)就不出现', async () => {
    await renderDialog([message(), message({ id: 'v', content_type: 'attachment', content: formatVoiceAttachmentMetadata(1000, '你好') })])
    expect(shareRow()).toBeNull()
  })

  it('消息菜单里不再单列「分享」', () => {
    // 动作表住在 messageActionItems(桌面菜单与手机长按面板共用),气泡里只剩接线 ⇒ 两处都读。
    for (const file of ['apps/desktop/src/components/chat/MessageBubble.tsx', 'apps/desktop/src/components/chat/messageActionItems.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/ShareToApps|message\.actions\.share/)
    }
  })
})
