// @vitest-environment jsdom
// 群里一个 agent 的运行态翻一次 ⇒ 只该重画它自己发的那几条(头像上的状态);别人的气泡(连同正文的 markdown 解析)不动。
// 从前名片表整张递进每只气泡:一翻就是新表,一屏气泡的 memo 全被打穿(busy 群里每分钟上千次 markdown 重新解析)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness, message } from '../../../support/testHarness'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import type { ChatListRowItem, MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'

const renders = new Map<string, number>()
const seenProfiles: Array<Record<string, MemberProfileCardModel> | undefined> = []
vi.mock('../../../../apps/desktop/src/components/chat/MessageBubble', async () => {
  const React = await import('react')
  return {
    MessageBubble: React.memo(({ msg, memberProfiles }: { msg: MessageItem; memberProfiles?: Record<string, MemberProfileCardModel> }) => {
      renders.set(msg.id, (renders.get(msg.id) ?? 0) + 1)
      seenProfiles.push(memberProfiles)
      return React.createElement('span', null, msg.content)
    }),
  }
})

const { MessageList } = await import('../../../../apps/desktop/src/components/chat/MessageList')

const noop = () => {}
const agent = (id: string, agentStatus: MemberProfileCardModel['agentStatus']): MemberProfileCardModel => ({
  id, displayName: id, avatar: null, email: null, type: 'agent', role: 'member', agentStatus, agentMeta: { lastAction: agentStatus === 'working' ? 'Edit' : null },
})
function props(profiles: Record<string, MemberProfileCardModel>) {
  const messages = [
    message({ id: 'm1', chat_id: 'g', seq: 1, sender_user_id: 'a1', content: 'from a1' }),
    message({ id: 'm2', chat_id: 'g', seq: 2, sender_user_id: 'a2', content: 'from a2' }),
    message({ id: 'm3', chat_id: 'g', seq: 3, sender_user_id: 'a2', content: 'a2 again' }),
  ]
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps: MessageListRowProps = {
    rows, messages, isFiltering: false, mobile: false, memberReadSeqs: {}, queuedIds: new Set(), isAgentChat: false, isGroupChat: true, memberProfiles: profiles,
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, onOpenMemberProfile: undefined, onMentionMember: undefined,
    highlight: undefined, flashMessageId: undefined, threeParty: undefined, onShowReadReceipt: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined,
    agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined,
    selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  }
  return { rows, rowProps, resetKey: 'g#0#1' }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); renders.clear(); seenProfiles.length = 0 })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

describe('MessageList: an agent status flip', () => {
  it('re-renders only the rows that agent sent; the bubbles get names without live status', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const a1 = agent('a1', 'idle')
    const first = props({ a1, a2: agent('a2', 'idle') })
    await harness.render(createElement(MessageList, first))
    expect(Object.fromEntries(renders)).toEqual({ m1: 1, m2: 1, m3: 1 })
    expect(seenProfiles.every((profiles) => profiles && !('agentStatus' in profiles.a1!) && !('agentMeta' in profiles.a1!))).toBe(true)

    // a2 starts working: a new profile table, as ChatAreaPanel builds it on every presence change (structurally shared,
    // so a1's entry keeps its identity).
    const flipped = props({ a1, a2: agent('a2', 'working') })
    await harness.render(createElement(MessageList, { ...first, rowProps: { ...first.rowProps, memberProfiles: flipped.rowProps.memberProfiles } }))
    expect(renders.get('m1')).toBe(1)
    expect(renders.get('m2')).toBe(2)
    expect(renders.get('m3')).toBe(2)
  })
})
