// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, message, renderWithAppProviders, clickElement } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { MessageList, type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { MessageQuote, DirectMessageQuote } from '../../../../apps/desktop/src/components/chat/MessageQuote'
import { quoteSummary } from '../../../../apps/desktop/src/components/chat/quoteSummary'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let h: ReturnType<typeof createReactHarness>
const noop = () => {}
const profiles = Object.fromEntries(['user-1', 'agent'].map(id => [id, { id, displayName: id === 'user-1' ? '测试用户' : '咕咕', avatar: null, email: null, type: id === 'user-1' ? 'human' : 'agent', role: 'member', profileScope: 'group' }])) as Record<string, MemberProfileCardModel>
const msg = (id: string, sender: string, seq: number, reply?: string) => message({ id, chat_id: 'dm', sender_user_id: sender, seq, is_mine: sender === 'user-1', content: `正文 ${id}`, reply_to_message_id: reply ?? null, reply_to_sender_user_id: reply ? 'user-1' : null, reply_to_content: reply ? '原消息' : null })
const marker = (id: string) => h.container.querySelector(`[data-msg-id="${id}"] .gg-chat-reply-jump`)
beforeEach(() => { h = createReactHarness(); vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { h.cleanup(); vi.unstubAllGlobals() })
async function render(messages: MessageItem[], mobile = false, group = false) {
  const rows = messages.map(message => ({ type: 'message' as const, message }))
  const rowProps: MessageListRowProps = { rows, messages, isFiltering: false, mobile, isGroupChat: group, memberReadSeqs: {}, queuedIds: new Set(), memberProfiles: profiles, onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, onShowMessage: vi.fn(), onShowReadReceipt: undefined, highlight: undefined, flashMessageId: undefined, threeParty: undefined, onOpenMemberProfile: undefined, onOpenTopic: undefined, topicAnchors: undefined, onOpenTopicAnchor: undefined, agentFloodNoticeMessageId: undefined, onAgentFloodUndone: undefined, onOpenFile: undefined, onOpenLocalFileLink: undefined, onMentionMember: undefined, selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: undefined }
  await renderWithAppProviders(h, <MessageList rows={rows} rowProps={rowProps} />)
}
for (const group of [false, true]) it.each([false, true])(`retains all explicit reply marks with no visible quote text at rest (group=${group}, mobile=%s)`, async mobile => {
  const messages = [msg('question', 'user-1', 1), msg('answer-1', 'agent', 2, 'question'), msg('answer-2', 'agent', 3, 'question')]
  const original = JSON.stringify(messages)
  await render(messages, mobile, group)
  expect(marker('answer-1')).not.toBeNull(); expect(marker('answer-2')).not.toBeNull()
  expect(h.container.querySelector('.gg-chat-reply-preview')).toBeNull()
  expect(h.container.textContent).not.toContain('原消息')
  expect(h.container.textContent).toContain('正文 answer-2')
  expect(JSON.stringify(messages)).toBe(original)
})
it('does not create a reply marker from an author or neighbouring message', async () => {
  await render([msg('question', 'user-1', 1), msg('answer', 'agent', 2)])
  expect(marker('answer')).toBeNull()
})
it('the direct quote summary preserves its 24-character limit and grapheme boundaries', () => {
  expect(quoteSummary('一二三四五六七八九十一二三四五六七八九十一二三四')).toBe('一二三四五六七八九十一二三四五六七八九十一二三四')
  expect(quoteSummary('一二三四五六七八九十一二三四五六七八九十一二三四五')).toBe('一二三四五六七八九十一二三四五六七八九十一二三四…')
  expect(quoteSummary('  第一行\n\n 第二行 ')).toBe('第一行 第二行')
  expect(quoteSummary(`${'一'.repeat(23)}👨‍👩‍👧尾巴`)).toBe(`${'一'.repeat(23)}👨‍👩‍👧…`)
})
for (const group of [false, true]) {
  const Quote = group ? MessageQuote : DirectMessageQuote
  it(`preserves the disclosed excerpt, source author and jump callback (group=${group})`, async () => {
    const onShowMessage = vi.fn()
    await renderWithAppProviders(h, <Quote msg={{ ...msg('answer', 'agent', 3, 'old'), content: '> [测试用户]: Beta chosen.\nPlease explain.', reply_to_content: 'Alpha original paragraph. Beta chosen.' }} quoterIsAgent memberProfiles={profiles} onShowMessage={onShowMessage} />)
    const quote = h.container.querySelector<HTMLElement>('[title="跳到被引用的消息"]')!
    expect(quote.textContent).toContain('测试用户')
    expect(quote.textContent).toContain('Beta chosen.')
    expect(quote.textContent).not.toContain('Alpha original')
    await clickElement(quote)
    expect(onShowMessage).toHaveBeenCalledWith('old')
  })
  it(`keeps the task-card head and source text in the disclosed preview (group=${group})`, async () => {
    const content = serializeComposerCard({ v: 1, type: 'task', text: 'Original task', agentUserId: 'agent', agentName: 'Ada', sessionId: 's', projectId: 'p', deviceId: 'd', machineLabel: 'Mac' })
    await renderWithAppProviders(h, <Quote msg={{ ...msg('answer', 'agent', 3, 'old'), reply_to_content: content }} quoterIsAgent memberProfiles={profiles} />)
    expect(h.container.textContent).toContain('新任务')
    expect(h.container.textContent).toContain('Original task')
  })
}
it('keeps an authored inline quote and its answer when there is no structural reply ID', async () => {
  await render([{ ...msg('legacy', 'user-1', 1), content: '> [Ada]: Legacy quoted text\nLegacy answer.' }])
  expect(h.container.textContent).toContain('Legacy quoted text')
  expect(h.container.textContent).toContain('Legacy answer.')
  expect(marker('legacy')).toBeNull()
})
it.each([false, true])('keeps an ambiguous answer beginning with > readable (mobile=%s)', async mobile => {
  await render([msg('old', 'user-1', 1), { ...msg('answer', 'agent', 3, 'old'), content: '> [测试用户]: Beta\n> Answer', reply_to_content: 'Alpha Beta' }], mobile)
  expect(h.container.querySelector('[data-msg-id="answer"] .gg-md')?.textContent).toContain('Answer')
})
