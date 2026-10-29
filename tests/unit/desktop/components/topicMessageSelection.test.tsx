// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TopicSplitPane } from '../../../../apps/desktop/src/components/chat/TopicSplitPane'
import { topicHistoryStub } from '../../../support/chatWindowStub'
import { createReactHarness, message, renderWithAppProviders, clickElement } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'

vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let h: ReturnType<typeof createReactHarness>
const messages = [
  message({ id: 'source', chat_id: 'topic-1', seq: 1, sender_user_id: 'ada', content: 'Alpha paragraph.\n\nBeta paragraph.' }),
  message({ id: 'other', chat_id: 'topic-1', seq: 2, sender_user_id: 'ada', content: 'Other message.' }),
]
beforeEach(() => {
  h = createReactHarness()
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { h.cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(chatId = 'topic-1') {
  const onSend = vi.fn(async () => {})
  await renderWithAppProviders(h, createElement(TopicSplitPane, {
    topic: { chatId, name: 'Topic' }, messages: chatId === 'topic-1' ? messages : [], loading: false,
    memberProfiles: { ada: { id: 'ada', displayName: 'Ada', avatar: null, email: null, type: 'human', role: 'member' } },
    memberReadSeqs: {}, visibleChats: [], sourceMessagePreview: null, onSend, onSendAttachments: async () => {},
    onClose: () => {}, currentUserId: 'user-1', history: topicHistoryStub(), mentionMembers: [], mobile: true,
  }))
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 0 })
  return onSend
}
const editor = () => h.container.querySelector<HTMLElement>('[data-topic-split-composer] [contenteditable]')!
const text = (id: string, paragraph: number) => h.container.querySelector(`[data-message-text-selection="${id}"]`)!.querySelectorAll('p')[paragraph].firstChild!
async function select(end = text('source', 1)) {
  const range = document.createRange()
  range.setStart(text('source', 1), 0)
  range.setEnd(end, end.textContent!.length)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange')); document.dispatchEvent(new Event('touchend'))
  })
}
it('sends the selected topic excerpt with the original message identity', async () => {
  const onSend = await render()
  await select()
  await act(async () => { writeComposer(editor(), 'Explain') })
  await clickElement(h.container.querySelector('button[aria-label="发送消息"]')!)
  expect(onSend).toHaveBeenCalledWith('> [Ada]: Beta paragraph.\n\nExplain', [], 'source', undefined, expect.any(Number))
})
it('clears an automatic topic quote when the range crosses into a second message', async () => {
  await render(); await select()
  expect(h.container.querySelector('button[aria-label="取消引用"]')).not.toBeNull()
  await select(text('other', 0))
  expect(h.container.querySelector('button[aria-label="取消引用"]')).toBeNull()
})
it('keeps native selection focus when a topic excerpt is attached automatically', async () => {
  await render(); await select()
  expect(document.activeElement).not.toBe(editor())
  expect(window.getSelection()?.toString()).toBe('Beta paragraph.')
})

it('never sends another topic’s quote after the same split pane changes topic', async () => {
  const originalSend = await render(); await select()
  expect(h.container.querySelector('button[aria-label="取消引用"]')).not.toBeNull()
  const onSend = await render('topic-2')
  expect(h.container.querySelector('button[aria-label="取消引用"]')).toBeNull()
  await act(async () => writeComposer(editor(), 'New topic'))
  await clickElement(h.container.querySelector('button[aria-label="发送消息"]')!)
  expect(onSend).toHaveBeenCalledWith('New topic', [], null, undefined, expect.any(Number))
  expect(originalSend).not.toHaveBeenCalled()
})
