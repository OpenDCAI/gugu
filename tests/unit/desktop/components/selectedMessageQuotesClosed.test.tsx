// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { TopicSplitPane } from '../../../../apps/desktop/src/components/chat/TopicSplitPane'
import { messageActionItems } from '../../../../apps/desktop/src/components/chat/messageActionItems'
import { contentWithQuote, partialQuotedContent } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'
import { topicHistoryStub } from '../../../support/chatWindowStub'
import { clickElement, createReactHarness, fireContextMenu, message, renderWithAppProviders } from '../../../support/testHarness'
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

it.each([
  ['Alpha first line.\n\nBeta second paragraph.', '> Alpha first line.'],
  ['A'.repeat(65) + '\nSecond paragraph.', '> ' + 'A'.repeat(60) + '…'],
])('keeps the original topic reply preview and source identity: %s', async (content, preview) => {
  const onSend = vi.fn(async () => {})
  await renderWithAppProviders(h, createElement(TopicSplitPane, {
    topic: { chatId: 'topic-1', name: 'Topic' }, messages: [message({ id: 'source', chat_id: 'topic-1', content })], loading: false,
    memberProfiles: {}, memberReadSeqs: {}, visibleChats: [], sourceMessagePreview: null, onSend,
    onSendAttachments: async () => {}, onClose: () => {}, currentUserId: 'user-1', history: topicHistoryStub(), mentionMembers: [], mobile: true,
  }))
  await fireContextMenu(h.container.querySelector<HTMLElement>('[data-msg-id="source"] [data-testid="message-bubble-action-target"]')!)
  await act(async () => { await vi.dynamicImportSettled() })
  await clickElement(document.querySelector('[data-testid="message-action-reply"]')!)
  const band = h.container.querySelector('button[aria-label="取消引用"]')!.parentElement!
  expect(band.querySelector('.max-w-60 > div:last-child')?.textContent).toBe(preview)
  const editor = h.container.querySelector<HTMLElement>('[data-topic-split-composer] [contenteditable]')!
  await act(async () => writeComposer(editor, 'Answer'))
  await clickElement(h.container.querySelector('button[aria-label="发送消息"]')!)
  expect(onSend).toHaveBeenCalledWith('Answer', [], 'source', undefined, expect.any(Number))
})
