// @vitest-environment jsdom
// 点「多选」进入多选态 ⇒ 每一行只换外壳(勾选框、底色),气泡不该卸载重挂;重挂 = 一屏气泡连同正文 markdown 全部重建,整列卡一下。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness, message } from '../../../support/testHarness'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'

const mounts = new Map<string, number>()
const renders = new Map<string, number>()
vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return {
    MessageBubble: React.memo(({ msg }: { msg: MessageItem }) => {
      renders.set(msg.id, (renders.get(msg.id) ?? 0) + 1)
      React.useEffect(() => { mounts.set(msg.id, (mounts.get(msg.id) ?? 0) + 1) }, [msg.id])
      return React.createElement('span', null, msg.content)
    }),
  }
})

const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const noop = () => {}
const messages = ['m1', 'm2', 'm3'].map((id, i) => message({ id, chat_id: 'g', seq: i + 1, sender_user_id: 'u1', content: id }))
const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
const base: MessageListRowProps = {
  rows, messages, mobile: false, memberReadSeqs: {}, deliveryWaits: new Map(), isGroupChat: true, memberProfiles: {},
  onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, onOpenMemberProfile: undefined, onMentionMember: undefined,
  flashMessageId: undefined, threeParty: undefined, onShowReadReceipt: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
  agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined,
  selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
}
const list = (rowProps: MessageListRowProps) => createElement(MessageList, { rows, rowProps, resetKey: 'g#0#1' })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); mounts.clear(); renders.clear() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

describe('MessageList: entering and leaving select mode', () => {
  it('keeps every bubble mounted and only redraws the row shell', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    await harness.render(list(base))
    expect(Object.fromEntries(mounts)).toEqual({ m1: 1, m2: 1, m3: 1 })

    await harness.render(list({ ...base, selectMode: true, selectedIds: new Set(['m2']) }))
    expect(harness.container.querySelectorAll('[data-message-select-row]')).toHaveLength(3)
    expect(harness.container.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1)
    await harness.render(list({ ...base, selectMode: true, selectedIds: new Set(['m2', 'm3']) }))
    await harness.render(list(base))
    expect(harness.container.querySelectorAll('[data-message-select-row]')).toHaveLength(0)

    expect(Object.fromEntries(mounts)).toEqual({ m1: 1, m2: 1, m3: 1 })
    expect(Object.fromEntries(renders)).toEqual({ m1: 1, m2: 1, m3: 1 })
  })
})
