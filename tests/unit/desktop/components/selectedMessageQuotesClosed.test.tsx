// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { TopicSplitPane } from '../../../../apps/desktop/src/components/chat/TopicSplitPane'
import { messageActionItems, messageSelectionActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'
import { contentWithQuote, partialQuotedContent } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'
import { observeMessageTextSelection } from '../../../../apps/desktop/src/lib/messageTextSelection'
import { topicHistoryStub } from '../../../support/chatWindowStub'
import { clickElement, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const t = ((key: string) => key) as TFunction<'messaging'>
let h: ReturnType<typeof createReactHarness>
let disposers: (() => void)[]
beforeEach(() => {
  shell.mobile = true
  h = createReactHarness()
  disposers = []
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  disposers.forEach(dispose => dispose())
  h.cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function select(start: Node, end = start) {
  const range = document.createRange()
  range.setStart(start, 0); range.setEnd(end, end.textContent!.length)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('touchend'))
    document.dispatchEvent(new Event('gugu:message-selection-settled'))
  })
}

it('keeps a cross-paragraph native range copyable without automatically quoting it', async () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>Beta <strong>bold</strong></p><ol><li>First item</li><li>Second item</li></ol><pre><code>const n = 1;</code></pre>'
  h.container.append(root)
  const onQuote = vi.fn(), onContext = vi.fn()
  disposers.push(observeMessageTextSelection(root, { enabled: true, onQuote, onContext, onClearQuote: vi.fn() }))
  await select(root.querySelector('p')!.firstChild!, root.querySelector('code')!.firstChild!)
  expect(window.getSelection()?.toString()).toBe('Beta boldFirst itemSecond itemconst n = 1;')
  expect(onContext).toHaveBeenLastCalledWith(expect.objectContaining({ text: window.getSelection()!.toString() }))
  const copy = new Event('copy', { bubbles: true, cancelable: true })
  root.dispatchEvent(copy)
  expect(copy.defaultPrevented).toBe(false)
  expect(onQuote).not.toHaveBeenCalled()
})

it('keeps whole-message Reply, Copy and reactions in a selected-text toolbar', () => {
  const whole = vi.fn(), excerpt = vi.fn(), copy = vi.fn(), react = vi.fn()
  const actions = messageSelectionActionItems({ isRetracted: false, content: 'Alpha Beta', onReply: whole, onQuoteSelection: excerpt, onCopy: copy, onShowReactions: react }, t)
  expect(actions.map(item => item.key)).toEqual(['reply', 'copy', 'react'])
  actions.find(item => item.key === 'reply')!.onSelect!()
  actions.find(item => item.key === 'copy')!.onSelect!()
  actions.find(item => item.key === 'react')!.onSelect!()
  expect(whole).toHaveBeenCalledOnce(); expect(excerpt).not.toHaveBeenCalled()
  expect(copy).toHaveBeenCalledOnce(); expect(react).toHaveBeenCalledOnce()
})

it('omits the excerpt command from desktop and overflow action menus', () => {
  const items = messageActionItems({ isRetracted: false, content: 'Alpha Beta', onReply: vi.fn(), onQuoteSelection: vi.fn(), onCopy: vi.fn() }, t)
  expect(items.map(item => item.key)).toEqual(['reply', 'copy'])
})

it.each([false, true])('does not serialize a stale excerpt even if a composer receives one (phone=%s)', async mobile => {
  shell.mobile = mobile
  const onSend = vi.fn(async () => {})
  await renderWithAppProviders(h, createElement(ChatMessageComposer, { onSend,
    quoteContent: { messageId: 'source', senderName: 'Ada', content: 'Beta', originalContent: 'Alpha Beta', source: message({ id: 'source' }) },
  }))
  await act(async () => writeComposer(h.container.querySelector('[contenteditable]')!, 'Explain'))
  await clickElement(h.container.querySelector('button[aria-label="发送消息"]')!)
  expect(onSend).toHaveBeenCalledWith('Explain', expect.objectContaining({ replyToMessageId: 'source' }))
})

it('leaves ordinary whole-message replies and legacy quotes without an IM source unchanged', () => {
  expect(contentWithQuote('Answer', { messageId: 'source', senderName: 'Ada', content: 'Alpha Beta' })).toBe('Answer')
  expect(contentWithQuote('Answer', { senderName: 'Ada', content: 'Whole source' })).toBe('> [Ada]: Whole source\n\nAnswer')
})

it('still reads a historical excerpt separately from the reply while sending is closed', () => {
  expect(partialQuotedContent({ content: '> [Ada]: Beta\n\n> Answer', reply_to_message_id: 'source', reply_to_content: 'Alpha Beta' }))
    .toEqual({ senderName: 'Ada', quoteText: 'Beta', replyText: '> Answer' })
})

it('keeps a topic selection and focus without attaching or sending a quote', async () => {
  const onSend = vi.fn(async () => {})
  await renderWithAppProviders(h, createElement(TopicSplitPane, {
    topic: { chatId: 'topic-1', name: 'Topic' }, messages: [message({ id: 'source', chat_id: 'topic-1', content: 'Alpha paragraph.\n\nBeta paragraph.' })], loading: false,
    memberProfiles: {}, memberReadSeqs: {}, visibleChats: [], sourceMessagePreview: null, onSend,
    onSendAttachments: async () => {}, onClose: () => {}, currentUserId: 'user-1', history: topicHistoryStub(), mentionMembers: [], mobile: true,
  }))
  const text = h.container.querySelector('[data-message-text-selection="source"]')!.querySelectorAll('p')[1].firstChild!
  await select(text)
  const editor = h.container.querySelector<HTMLElement>('[data-topic-split-composer] [contenteditable]')!
  expect(window.getSelection()?.toString()).toBe('Beta paragraph.')
  expect(document.activeElement).not.toBe(editor)
  expect(h.container.querySelector('button[aria-label="取消引用"]')).toBeNull()
  await act(async () => writeComposer(editor, 'Explain'))
  await clickElement(h.container.querySelector('button[aria-label="发送消息"]')!)
  expect(onSend).toHaveBeenCalledWith('Explain', [], null, undefined, expect.any(Number))
})
