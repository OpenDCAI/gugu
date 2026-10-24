// @vitest-environment jsdom
// 右键群聊消息的发送者头像 → 输入框 @ 他。插入本身走 rowProps.onMentionMember(主线里就是点运行中头像
// 用的那个 setMentionToInsert),这里判的是:哪一次右键会调它、调的时候带什么、什么时候不碰原生菜单。
import { topicHistoryStub } from '../../../support/chatWindowStub'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { TopicSplitPane } from '../../../../apps/desktop/src/components/chat/TopicSplitPane'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

const noop = () => {}
function profile(id: string, displayName: string, overrides: Partial<MemberProfileCardModel> = {}): MemberProfileCardModel {
  return { id, displayName, avatar: null, email: null, type: 'human', role: 'member', membership: 'current', ...overrides }
}
const memberProfiles = {
  'u-alice': profile('u-alice', 'Alice'),
  'u-claude': profile('u-claude', 'Claude 5', { type: 'agent' }),
  'u-gone': profile('u-gone', 'Carol', { membership: 'former' }),
  'user-1': profile('user-1', 'User'),
}
// 发送者两两不同 ⇒ 每行都是组首、都画头像。
const messages: MessageItem[] = [
  message({ id: 'm-alice', seq: 1, sender_user_id: 'u-alice', content: 'hi from alice' }),
  message({ id: 'm-claude', seq: 2, sender_user_id: 'u-claude', content: 'hi from claude' }),
  message({ id: 'm-gone', seq: 3, sender_user_id: 'u-gone', content: 'bye' }),
  message({ id: 'm-mine', seq: 4, sender_user_id: 'user-1', is_mine: true, content: 'mine' }),
]

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function renderList(overrides: Partial<MessageListRowProps> = {}) {
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const onMentionMember = vi.fn()
  const rowProps: MessageListRowProps = {
    rows, messages, isFiltering: false, mobile: false, memberReadSeqs: {}, isAgentChat: false, isGroupChat: true, memberProfiles,
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, onOpenMemberProfile: noop, onMentionMember,
    highlight: undefined, flashMessageId: undefined, threeParty: undefined, onShowReadReceipt: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop, ...overrides,
  }
  await renderWithAppProviders(harness, createElement(MessageList, { rows, rowProps, resetKey: 'chat-1' }))
  return onMentionMember
}

// 点在头像里面的图上(真实右键落点),靠 closest 认出是哪颗头像。
function avatarOf(messageId: string): Element {
  const button = harness.container.querySelector(`[data-msg-id="${messageId}"] [data-message-sender-id]`)
  if (!button) throw new Error(`no sender avatar rendered for ${messageId}`)
  return button.firstElementChild ?? button
}
function rightClick(target: Element): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  act(() => { target.dispatchEvent(event) })
  return event.defaultPrevented
}

describe('右键群聊消息头像 → @ 他', () => {
  it('在群的人和 agent:以他的 id 和名字插 @,并吞掉原生菜单', async () => {
    const onMentionMember = await renderList()
    expect(rightClick(avatarOf('m-alice'))).toBe(true)
    expect(rightClick(avatarOf('m-claude'))).toBe(true)
    expect(onMentionMember.mock.calls).toEqual([[{ id: 'u-alice', name: 'Alice' }], [{ id: 'u-claude', name: 'Claude 5' }]])
  })

  it('右键气泡正文不是点名(那是消息菜单)', async () => {
    const onMentionMember = await renderList()
    const text = [...harness.container.querySelectorAll('[data-msg-id="m-alice"] *')].find((node) => node.childElementCount === 0 && node.textContent === 'hi from alice')
    if (!text) throw new Error('bubble text not rendered')
    rightClick(text)
    expect(onMentionMember).not.toHaveBeenCalled()
  })

  it('自己、已退群的人不 @,原生菜单照常(正对照:同一列表里 Alice 能 @)', async () => {
    const onMentionMember = await renderList()
    expect(rightClick(avatarOf('m-mine'))).toBe(false)
    expect(rightClick(avatarOf('m-gone'))).toBe(false)
    expect(onMentionMember).not.toHaveBeenCalled()
    expect(rightClick(avatarOf('m-alice'))).toBe(true)
    expect(onMentionMember).toHaveBeenCalledWith({ id: 'u-alice', name: 'Alice' })
  })

  it('私聊、没有输入框的表面(不传 onMentionMember):右键头像什么都不做', async () => {
    const onMentionMember = await renderList({ isGroupChat: false })
    expect(rightClick(avatarOf('m-alice'))).toBe(false)
    expect(onMentionMember).not.toHaveBeenCalled()
    harness.cleanup()
    harness = createReactHarness()
    await renderList({ onMentionMember: undefined })
    expect(rightClick(avatarOf('m-alice'))).toBe(false)
  })

  // owner 10-22:「在话题中右键 agent 头像没有那个 @ 的功能 …… 说明链路不统一」。分栏手拼的 rowProps 漏了
  // onMentionMember;现在每个键都是必填,漏接是编译错。这一格从分栏真的组件走一遍:@ 进的是话题自己的输入框。
  it('话题分栏:右键头像,@ 进话题自己的输入框', async () => {
    await renderWithAppProviders(harness, createElement(TopicSplitPane, {
      topic: { chatId: 'topic-1', name: '分片下载失败' }, sourceChatId: 'source-1', messages, loading: false, memberProfiles, memberReadSeqs: {}, visibleChats: [],
      sourceMessagePreview: 'pending', onOpenFile: noop, onDownloadFile: noop, onSend: async () => {}, onSendAttachments: async () => {},
      onClose: noop, currentUserId: 'user-1', history: topicHistoryStub(), mentionMembers: [], onOpenMemberProfile: noop,
    }))
    expect(rightClick(avatarOf('m-claude'))).toBe(true)
    const composer = harness.container.querySelector('[data-topic-split-composer] textarea') as HTMLTextAreaElement
    expect(composer.value).toBe('@Claude 5 ')
  })
})
